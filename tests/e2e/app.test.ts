/**
 * The app, end to end: viewing, page operations, annotations, forms,
 * properties, keyboard, encrypted files. Saved files are decoded with pdf.js
 * and checked, not just the screen.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { numberedPdf } from "../fixtures/make";
import { PNG_RED } from "../fixtures/pdf";
import {
  answer,
  clickPage,
  dirty,
  formFields,
  launch,
  opened,
  poll,
  readPdf,
  sampleIn,
  savedTo,
  shellLog,
  STARTUP,
  stroke,
  useApp,
  workDir,
} from "./harness";
import { Key } from "./webdriver";

useApp();

const thumb = (i: number) => `.thumb[data-index="${i}"]`;
const tool = (name: string) => `.toolbar .tool[data-tool="${name}"]`;
const nameField = '.page[data-page-number="1"] .annotationLayer input[type="text"]';
const agreeBox = '.page[data-page-number="1"] .annotationLayer input[type="checkbox"]';
const suggestedNames = () => shellLog().flatMap((e) => e.suggestedName ?? []);
const isOpen = (app: Awaited<ReturnType<typeof launch>>, dialog: string) =>
  app.exec<boolean>("return document.querySelector(arguments[0]).open", dialog);
/** "Page 3", "Other 1": what each page of a decoded PDF says it is. */
const labels = (doc: Awaited<ReturnType<typeof readPdf>>) => doc.pages.map((p) => /(Page|Other) \d/.exec(p.text)?.[0]);
const mergeList = (app: Awaited<ReturnType<typeof launch>>) =>
  app.exec<string[]>("return [...document.querySelectorAll('#mergeList .file-name')].map((e) => e.textContent)");

/** Open a fresh copy of the sample; returns the app, its folder and the file's path. */
async function openSample(name = "sample.pdf") {
  const dir = workDir();
  const path = await sampleIn(dir, name);
  const app = await launch(path);
  await opened(app);
  return { app, dir, path };
}

test("opens a PDF and navigates", async () => {
  const { app } = await openSample();
  expect(await app.text("#docTitle")).toContain("sample.pdf");
  expect(await app.title()).toMatch(/sample\.pdf — Palimpsest/);
  await app.click(thumb(3));
  await poll(() => app.value("#pageNumber")).toBe("4");
  await app.fill("#pageNumber", "2");
  await app.press(Key.Enter);
  await poll(() => app.attr(".thumb.current", "data-index")).toBe("1");
});

test("finds text across pages", async () => {
  const { app } = await openSample();
  await app.press(Key.Control, "f");
  await poll(() => app.visible("#findbar")).toBe(true);
  await app.fill("#findInput", "zebra4");
  await poll(() => app.text("#findStatus")).toBe("1 of 1");
  await poll(() => app.value("#pageNumber")).toBe("4");
  await app.fill("#findInput", "palimpsest");
  await poll(() => app.text("#findStatus")).toMatch(/of 5$/);
  await app.fill("#findInput", "nonexistentword");
  await poll(() => app.text("#findStatus")).toBe("No matches");
  await app.press(Key.Escape);
  await poll(() => app.visible("#findbar")).toBe(false);
});

test("deletes, undoes and redoes page changes", async () => {
  const { app, dir } = await openSample();
  await app.click(thumb(1));
  await app.click("#pgDelete");
  await poll(() => app.text("#pageCount")).toBe("/ 4");
  expect(await dirty(app)).toBe(true);
  await app.click("#btnUndo");
  await poll(() => app.text("#pageCount")).toBe("/ 5");
  await app.click("#btnRedo");
  await poll(() => app.text("#pageCount")).toBe("/ 4");

  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.press(Key.Control, Key.Shift, "s");
  const doc = await savedTo(out);
  expect(suggestedNames()).toEqual(["sample.pdf"]);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 3", "Page 4", "Page 5"]);
  await poll(() => dirty(app)).toBe(false);
});

test("rotates, duplicates, inserts blank pages and reorders by drag", async () => {
  const { app, dir } = await openSample();
  await app.click(thumb(0));
  await app.click("#pgRotR");
  await poll(() => app.visible("#busy")).toBe(false);
  await app.click(thumb(2));
  await app.click("#pgDup");
  await poll(() => app.text("#pageCount")).toBe("/ 6");
  // The copy (index 3) is selected afterwards.
  expect(await app.attr(thumb(3), "class")).toMatch(/\bselected\b/);
  await app.click("#pgBlank");
  await poll(() => app.text("#pageCount")).toBe("/ 7");

  // Drag page 2 onto the top edge of page 1. WebDriver cannot start the
  // system's drag session in a webview, so the page's drag events are
  // dispatched directly, as the webview would send them.
  await app.center(thumb(0));
  await app.exec(
    `const [source, target] = [document.querySelector(arguments[0]), document.querySelector(arguments[1])];
     const dataTransfer = new DataTransfer();
     const r = target.getBoundingClientRect();
     const at = { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 60, clientY: r.top + 8 };
     source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
     for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, at));
     source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));`,
    thumb(1),
    thumb(0),
  );
  await poll(() => app.attr(thumb(0), "class")).toMatch(/\bselected\b/);
  await poll(() => app.value("#pageNumber")).toBe("1");

  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  const doc = await savedTo(out);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 2", "Page 1", "Page 3", "Page 3", "", "Page 4", "Page 5"]);
  expect(doc.pages.map((p) => p.rotate)).toEqual([0, 90, 0, 0, 0, 0, 0]);
  expect(doc.pages[4].text.trim()).toBe("");
});

test("multi-select with shift and extract to a new file", async () => {
  const { app, dir } = await openSample();
  await app.click(thumb(1));
  await app.clickAt(await app.center(thumb(3)), Key.Shift);
  await poll(() => app.text("#selectionInfo")).toBe("3 pages selected");
  const out = join(dir, "part.pdf");
  answer({ save: out });
  await app.click("#pgExtract");
  const doc = await savedTo(out);
  expect(suggestedNames()).toEqual(["sample-p2-4.pdf"]);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 2", "Page 3", "Page 4"]);
  // The open document is untouched.
  expect(await app.text("#pageCount")).toBe("/ 5");
});

test("splits into files in a folder the user picks", async () => {
  const { app, dir } = await openSample();
  // Unsaved form values go into the parts.
  await app.type(nameField, "Ada Lovelace");
  const parts = join(dir, "parts");
  mkdirSync(parts);
  answer({ folder: parts });

  await app.click("#pgSplit");
  await poll(() => isOpen(app, "#splitDialog")).toBe(true);
  expect(await app.text("#splitPreview")).toBe("5 files: sample-p1.pdf, sample-p2.pdf, …, sample-p5.pdf");
  await app.fill("#splitEvery", "2");
  await poll(() => app.text("#splitPreview")).toBe("3 files: sample-p1-2.pdf, sample-p3-4.pdf, sample-p5.pdf");
  await app.click("#splitOk");
  await poll(() => app.text(".toast")).toContain("Saved 3 files in parts");
  expect(readdirSync(parts).sort()).toEqual(["sample-p1-2.pdf", "sample-p3-4.pdf", "sample-p5.pdf"]);
  const first = await readPdf(join(parts, "sample-p1-2.pdf"));
  expect(first.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 2"]);
  expect(formFields(first).name).toBe("Ada Lovelace");
  expect((await readPdf(join(parts, "sample-p3-4.pdf"))).pages.map((p) => p.heading)).toEqual(["Page 3", "Page 4"]);
  expect((await readPdf(join(parts, "sample-p5.pdf"))).pages.map((p) => p.heading)).toEqual(["Page 5"]);
  // The open document is unchanged.
  expect(await app.text("#pageCount")).toBe("/ 5");

  // By page ranges. A mistake is explained and stops the split.
  await app.click("#pgSplit");
  await poll(() => isOpen(app, "#splitDialog")).toBe(true);
  await app.fill("#splitRanges", "4-2");
  await poll(() => app.text("#splitPreview")).toBe("“4-2” runs backwards.");
  expect(await app.exec("return document.querySelector('#splitOk').disabled")).toBe(true);
  expect(await app.exec(`return document.querySelector('input[name="splitMode"]:checked').value`)).toBe("ranges");
  await app.fill("#splitRanges", "1, 5-");
  await poll(() => app.text("#splitPreview")).toBe("2 files: sample-p1.pdf, sample-p5.pdf");
  // sample-p5.pdf is already there: replacing it asks first, and Cancel writes nothing.
  const before = statSync(join(parts, "sample-p5.pdf")).mtimeMs;
  await app.press(Key.Enter);
  await poll(() => isOpen(app, "#confirmDialog")).toBe(true);
  expect(await app.text("#confirmMsg")).toBe("sample-p5.pdf is already in parts.");
  await app.click('#confirmDialog button[value="cancel"]');
  await poll(() => isOpen(app, "#confirmDialog")).toBe(false);
  expect(readdirSync(parts)).not.toContain("sample-p1.pdf");

  await app.click("#pgSplit");
  await poll(() => isOpen(app, "#splitDialog")).toBe(true);
  expect(await app.value("#splitRanges")).toBe("1, 5-");
  await app.click("#splitOk");
  await poll(() => isOpen(app, "#confirmDialog")).toBe(true);
  await app.click("#confirmOk");
  await poll(() => app.text(".toast:last-child")).toContain("Saved 2 files in parts");
  expect(readdirSync(parts).sort()).toEqual(["sample-p1-2.pdf", "sample-p1.pdf", "sample-p3-4.pdf", "sample-p5.pdf"]);
  expect(statSync(join(parts, "sample-p5.pdf")).mtimeMs).toBeGreaterThan(before);
  expect((await readPdf(join(parts, "sample-p1.pdf"))).pages.map((p) => p.heading)).toEqual(["Page 1"]);

  // More pages per file than the document has makes one file.
  await app.click("#pgSplit");
  await poll(() => isOpen(app, "#splitDialog")).toBe(true);
  await app.fill("#splitEvery", "9");
  await poll(() => app.text("#splitPreview")).toBe("1 file: sample-p1-5.pdf");
  await app.click("#splitOk");
  await poll(() => readdirSync(parts)).toContain("sample-p1-5.pdf");
  expect(shellLog().flatMap((e) => e.dialog ?? [])).toEqual(["folder", "folder", "folder", "folder"]);
});

test("merges PDFs into a new document", async () => {
  const dir = workDir();
  const a = await sampleIn(dir, "a.pdf");
  const b = join(dir, "b.pdf");
  writeFileSync(b, await numberedPdf(2, "Other"));
  answer({ pdf: [a, b] });
  const app = await launch();

  await app.click("#btnMergeEmpty");
  await poll(() => isOpen(app, "#mergeDialog")).toBe(true);
  expect(await mergeList(app)).toEqual(["a.pdf", "b.pdf"]);
  await app.click('#mergeList li[data-index="1"] button[data-act="up"]');
  expect(await mergeList(app)).toEqual(["b.pdf", "a.pdf"]);
  // Focus follows the moved file; it is first now, so "Move up" is off.
  expect(await app.exec("return document.activeElement.getAttribute('aria-label')")).toBe("Move down: b.pdf");
  await app.click("#mergeOk");
  await opened(app, 7);
  expect(await app.text("#docTitle")).toContain("b-merged.pdf");
  expect(await dirty(app)).toBe(true);

  // A new document: Save asks where to put it.
  const out = join(dir, "merged.pdf");
  answer({ save: out });
  await app.press(Key.Control, "s");
  const doc = await savedTo(out);
  expect(suggestedNames()).toEqual(["b-merged.pdf"]);
  expect(labels(doc)).toEqual(["Other 1", "Other 2", "Page 1", "Page 2", "Page 3", "Page 4", "Page 5"]);
  await poll(() => dirty(app)).toBe(false);
});

test("merges the open document, unsaved changes and all, with other PDFs", async () => {
  const { app, dir, path } = await openSample();
  const other = join(dir, "other.pdf");
  writeFileSync(other, await numberedPdf(2, "Other"));
  await app.type(nameField, "Ada Lovelace");
  answer({ pdf: [other] });

  await app.click("#btnMerge");
  await poll(() => isOpen(app, "#mergeDialog")).toBe(true);
  expect(await mergeList(app)).toEqual(["sample.pdf", "other.pdf"]);
  expect(await app.text('#mergeList li[data-index="0"] .tag')).toBe("open document");
  await app.click("#mergeAdd");
  await poll(() => mergeList(app)).toEqual(["sample.pdf", "other.pdf", "other.pdf"]);
  await app.click('#mergeList li[data-index="2"] button[data-act="remove"]');
  await app.click('#mergeList li[data-index="1"] button[data-act="remove"]');
  // One file is not a merge.
  expect(await mergeList(app)).toEqual(["sample.pdf"]);
  expect(await app.exec("return document.querySelector('#mergeOk').disabled")).toBe(true);
  await app.click("#mergeAdd");
  await poll(() => mergeList(app)).toEqual(["sample.pdf", "other.pdf"]);

  await app.click("#mergeOk");
  // The merge replaces the open document, which has unsaved changes.
  await poll(() => isOpen(app, "#confirmDialog")).toBe(true);
  await app.click("#confirmOk");
  await opened(app, 7);
  expect(await app.text("#docTitle")).toContain("sample-merged.pdf");

  const out = join(dir, "merged.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  const doc = await savedTo(out);
  expect(labels(doc)).toEqual(["Page 1", "Page 2", "Page 3", "Page 4", "Page 5", "Other 1", "Other 2"]);
  expect(formFields(doc).name).toBe("Ada Lovelace");
  // The original file is untouched.
  expect(formFields(await readPdf(path)).name).not.toBe("Ada Lovelace");
});

test("asks for the password of a protected PDF being merged", async () => {
  const dir = workDir();
  const plain = join(dir, "plain.pdf");
  writeFileSync(plain, await numberedPdf(1, "Other"));
  const encrypted = join(dir, "encrypted.pdf");
  copyFileSync(resolve(import.meta.dirname, "../fixtures/encrypted.pdf"), encrypted);
  answer({ pdf: [plain, encrypted] });
  const app = await launch();

  await app.click("#btnMergeEmpty");
  await poll(() => isOpen(app, "#mergeDialog")).toBe(true);
  await app.click("#mergeOk");
  await poll(() => isOpen(app, "#passwordDialog")).toBe(true);
  expect(await app.text("#passwordMsg")).toBe("encrypted.pdf is protected. Enter its password.");
  await app.fill("#passwordInput", "secret");
  await app.click("#passwordDialog button.primary");
  await opened(app, 6);

  const out = join(dir, "merged.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  expect(labels(await savedTo(out))).toEqual(["Other 1", "Page 1", "Page 2", "Page 3", "Page 4", "Page 5"]);
});

test("adds text and ink annotations and saves them as real annotations", async () => {
  const { app, path } = await openSample();
  await app.click(tool("text"));
  expect(await app.attr(tool("text"), "aria-checked")).toBe("true");
  await clickPage(app, 1, 300, 520);
  await app.keys("Hello Palimpsest");
  await clickPage(app, 1, 700, 600); // commit
  await poll(() => app.count(".freeTextEditor")).toBeGreaterThan(0);

  await app.click(tool("ink"));
  await stroke(app, 1, 200, 700);
  await app.press(Key.Escape);
  await poll(() => dirty(app)).toBe(true);

  await app.press(Key.Control, "s");
  await poll(() => app.text(".toast")).toContain("Saved sample.pdf");
  const doc = await readPdf(path);
  const subtypes = doc.pages[0].annotations.map((a) => a.subtype);
  expect(subtypes).toContain("FreeText");
  expect(subtypes).toContain("Ink");
  expect(doc.pages[0].annotations.find((a) => a.subtype === "FreeText")!.contents).toContain("Hello Palimpsest");
});

test("opens through the file dialog and saves back in place", async () => {
  const dir = workDir();
  const picked = await sampleIn(dir, "picked.pdf");
  const png = join(dir, "red.png");
  writeFileSync(png, Buffer.from(PNG_RED, "base64"));
  answer({ pdf: [picked], image: png });
  const app = await launch();
  await app.click("#btnOpenEmpty");
  await opened(app);
  expect(await app.text("#docTitle")).toContain("picked.pdf");

  // The image tool asks for an image and drops it on the current page.
  await app.click(tool("image"));
  await poll(() => app.count(".stampEditor")).toBe(1);
  await app.click(tool("none"));

  await app.press(Key.Control, "s");
  await poll(() => app.text(".toast")).toContain("Saved picked.pdf");
  const doc = await readPdf(picked);
  expect(doc.pages[0].annotations.map((a) => a.subtype)).toContain("Stamp");
  await poll(() => dirty(app)).toBe(false);
});

test("tool options set defaults and restyle the selected annotation", async () => {
  const { app } = await openSample();
  const fontSize = () =>
    app.exec<number>("return parseFloat(getComputedStyle(document.querySelector('.freeTextEditor .internal')).fontSize)");
  await app.click(tool("text"));
  expect(await app.value("#optFontSize")).toBe("12");
  await app.fill("#optFontSize", "20");
  await clickPage(app, 1, 300, 300);
  await app.keys("Big");
  await clickPage(app, 1, 600, 600); // commit; an empty commit does not make a new box
  await poll(() => app.count(".freeTextEditor .internal")).toBe(1);
  const big = await fontSize();

  // Select the annotation and shrink it from the toolbar.
  await app.press(Key.Escape);
  await app.click(".freeTextEditor");
  await poll(() => app.value("#optFontSize")).toBe("20");
  await app.fill("#optFontSize", "10");
  await poll(fontSize).toBeLessThan(big);
});

test("defaults apply when switching straight from one tool to another", async () => {
  const { app, dir } = await openSample();
  // Highlight some text, then go straight to the pen (pdf.js keeps the highlight selected).
  await app.click(tool("highlight"));
  const [x, y, w, h] = await app.exec<[number, number, number, number]>(
    `const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
       .find((s) => s.textContent.includes("Unique marker zebra1"));
     span.scrollIntoView({ block: "center" });
     const r = span.getBoundingClientRect();
     return [r.left, r.top, r.width, r.height];`,
  );
  await app.drag([[x + 2, y + h / 2], [x + w / 3, y + h / 2], [x + (2 * w) / 3, y + h / 2], [x + w - 2, y + h / 2]], 50);
  await poll(() => app.count(".highlightEditor")).toBe(1);

  await app.click(tool("ink"));
  await app.fill("#optColor", "#e5484d");
  await stroke(app, 1, 200, 750, 8);

  // And straight from the pen to text: the new box uses the toolbar size.
  await app.click(tool("text"));
  expect(await app.value("#optFontSize")).toBe("12");
  await clickPage(app, 1, 300, 300);
  await app.keys("Sized");
  await poll(() => app.attr(".freeTextEditor .internal", "style")).toMatch(/font-size: calc\(12px/);
  await clickPage(app, 1, 600, 620);

  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  const annots = (await savedTo(out)).pages[0].annotations;
  expect(annots.find((a) => a.subtype === "Ink")).toMatchObject({ color: "#e5484d", borderWidth: 2 });
  expect(annots.find((a) => a.subtype === "Highlight")?.color).toBe("#ffff98");
});

test("annotations survive a page operation", async () => {
  const { app, dir } = await openSample();
  await app.click(tool("text"));
  await clickPage(app, 1, 300, 520);
  await app.keys("Keep me");
  await clickPage(app, 1, 700, 600);
  await app.click(tool("none"));

  await app.click(thumb(4));
  await app.click("#pgDelete");
  await poll(() => app.text("#pageCount")).toBe("/ 4");
  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  const doc = await savedTo(out);
  expect(doc.pages[0].annotations.find((a) => a.subtype === "FreeText")?.contents).toContain("Keep me");
});

test("fills form fields", async () => {
  const { app, dir } = await openSample();
  await app.type(nameField, "Ada Lovelace");
  await app.click(agreeBox);
  await poll(() => dirty(app)).toBe(true);
  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  const fields = formFields(await savedTo(out));
  expect(fields.name).toBe("Ada Lovelace");
  expect(fields.agree).not.toBe("Off");
});

test("form values survive page operations and extraction", async () => {
  const { app, dir } = await openSample();
  await app.type(nameField, "Ada Lovelace");
  await app.click(agreeBox);

  // Saving a selection as a new file takes the unsaved values along.
  await app.click(thumb(0));
  await app.clickAt(await app.center(thumb(1)), Key.Shift);
  const part = join(dir, "part.pdf");
  answer({ save: part });
  await app.click("#pgExtract");
  const extracted = await savedTo(part);
  expect(extracted.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 2"]);
  expect(formFields(extracted).name).toBe("Ada Lovelace");

  // So does a page operation on the open document.
  await app.click(thumb(4));
  await app.click("#pgDelete");
  await poll(() => app.text("#pageCount")).toBe("/ 4");
  await app.click(thumb(0));
  await poll(() => app.value(nameField)).toBe("Ada Lovelace");
  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  const doc = await savedTo(out);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 2", "Page 3", "Page 4"]);
  const fields = formFields(doc);
  expect(fields.name).toBe("Ada Lovelace");
  expect(fields.agree).not.toBe("Off");
});

test("edits document properties", async () => {
  const { app, dir } = await openSample();
  await app.click("#btnProps");
  await poll(() => app.value("#propTitle")).toBe("Palimpsest sample");
  await app.fill("#propTitle", "Renamed by test");
  await app.fill("#propAuthor", "Test Author");
  // Enter in a field applies, as the primary button does.
  await app.press(Key.Enter);
  await poll(() => isOpen(app, "#propsDialog")).toBe(false);
  await poll(() => dirty(app)).toBe(true);
  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  const doc = await savedTo(out);
  expect(doc.meta.Title).toBe("Renamed by test");
  expect(doc.meta.Author).toBe("Test Author");
});

test("keyboard: tool shortcuts and zoom", async () => {
  const { app } = await openSample();
  await app.exec("document.querySelector('#viewerContainer').focus()");
  await app.press("d");
  await poll(() => app.attr(tool("ink"), "aria-checked")).toBe("true");
  await poll(() => app.visible("#optThickness")).toBe(true);
  await app.press(Key.Escape);
  await poll(() => app.attr(tool("none"), "aria-checked")).toBe("true");
  await app.fill("#zoomSelect", "2");
  await poll(() => app.value("#zoomSelect")).toBe("2");
  await app.press(Key.Control, "-");
  await poll(() => app.value("#zoomSelect")).not.toBe("2");
});

test("opens password-protected PDFs and keeps them encrypted", async () => {
  const dir = workDir();
  const encrypted = join(dir, "encrypted.pdf");
  copyFileSync(resolve(import.meta.dirname, "../fixtures/encrypted.pdf"), encrypted);
  const app = await launch(encrypted);
  const passwordDialog = () => app.exec<boolean>("return document.querySelector('#passwordDialog').open");
  await poll(passwordDialog, STARTUP).toBe(true);
  // Enter submits the password.
  await app.fill("#passwordInput", "wrong");
  await app.press(Key.Enter);
  await poll(() => app.text("#passwordMsg")).toContain("not correct");
  await app.fill("#passwordInput", "secret");
  await app.press(Key.Enter);
  await opened(app);

  await app.click(thumb(1));
  await app.click("#pgDelete");
  await poll(() => app.text("#pageCount")).toBe("/ 4");
  await app.click("#pgRotR");
  await poll(() => app.text(".toast.error")).toContain("not supported on encrypted PDFs");

  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  const doc = await savedTo(out, "secret");
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 3", "Page 4", "Page 5"]);
  await expect(readPdf(out)).rejects.toThrow(/password/i);
});
