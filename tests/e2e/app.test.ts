/**
 * The app, end to end: viewing, page operations, annotations, forms,
 * properties, keyboard, encrypted files. Saved files are decoded with pdf.js
 * and checked, not just the screen.
 */
import { copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
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
const suggestedNames = () => shellLog().flatMap((e) => e.suggestedName ?? []);

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

const nameField = '.page[data-page-number="1"] .annotationLayer input[type="text"]';
const agreeBox = '.page[data-page-number="1"] .annotationLayer input[type="checkbox"]';

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
  await app.click("#propsDialog button.primary");
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
  await app.fill("#passwordInput", "wrong");
  await app.click("#passwordDialog button.primary");
  await poll(() => app.text("#passwordMsg")).toContain("not correct");
  await app.fill("#passwordInput", "secret");
  await app.click("#passwordDialog button.primary");
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
