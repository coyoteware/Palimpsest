import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  PNG_RED,
  inspect,
  lastSaved,
  openSample,
  pageCount,
  sampleFile,
  stubOpenPicker,
  stubSavePicker,
  thumb,
} from "./helpers";

const problems = new WeakMap<object, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on("pageerror", (e) => list.push(`uncaught: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") list.push(`console.error: ${m.text()}`);
  });
  await stubSavePicker(page);
});

test.afterEach(async ({ page }) => {
  expect(problems.get(page), "errors logged by the app").toEqual([]);
});

test("opens a PDF and navigates", async ({ page }) => {
  await openSample(page);
  await expect(page.locator("#docTitle")).toContainText("sample.pdf");
  await expect(page).toHaveTitle(/sample\.pdf — Palimpsest/);
  await thumb(page, 3).click();
  await expect(page.locator("#pageNumber")).toHaveValue("4");
  await page.locator("#pageNumber").fill("2");
  await page.locator("#pageNumber").press("Enter");
  await expect(page.locator(".thumb.current")).toHaveAttribute("data-index", "1");
});

test("finds text across pages", async ({ page }) => {
  await openSample(page);
  await page.keyboard.press("Control+f");
  await expect(page.locator("#findbar")).toBeVisible();
  await page.locator("#findInput").fill("zebra4");
  await expect(page.locator("#findStatus")).toHaveText("1 of 1");
  await expect(page.locator("#pageNumber")).toHaveValue("4");
  await page.locator("#findInput").fill("palimpsest");
  await expect(page.locator("#findStatus")).toHaveText(/of 5$/);
  await page.locator("#findInput").fill("nonexistentword");
  await expect(page.locator("#findStatus")).toHaveText("No matches");
  await page.keyboard.press("Escape");
  await expect(page.locator("#findbar")).toBeHidden();
});

test("deletes, undoes and redoes page changes", async ({ page }) => {
  await openSample(page);
  await thumb(page, 1).click();
  await page.locator("#pgDelete").click();
  await expect(pageCount(page)).toHaveText("/ 4");
  await expect(page.locator("#docTitle .dirty")).toBeVisible();
  await page.locator("#btnUndo").click();
  await expect(pageCount(page)).toHaveText("/ 5");
  await page.locator("#btnRedo").click();
  await expect(pageCount(page)).toHaveText("/ 4");

  await page.keyboard.press("Control+Shift+s");
  const { name, bytes } = await lastSaved(page);
  expect(name).toBe("sample.pdf");
  const doc = await inspect(bytes);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 3", "Page 4", "Page 5"]);
  await expect(page.locator("#docTitle .dirty")).toHaveCount(0);
});

test("rotates, duplicates, inserts blank pages and reorders by drag", async ({ page }) => {
  await openSample(page);
  await thumb(page, 0).click();
  await page.locator("#pgRotR").click();
  await expect(page.locator("#busy")).toBeHidden();
  await thumb(page, 2).click();
  await page.locator("#pgDup").click();
  await expect(pageCount(page)).toHaveText("/ 6");
  // The copy (index 3) is selected afterwards.
  await expect(thumb(page, 3)).toHaveClass(/selected/);
  await page.locator("#pgBlank").click();
  await expect(pageCount(page)).toHaveText("/ 7");

  // Drag page 2 above page 1.
  await thumb(page, 0).scrollIntoViewIfNeeded();
  await thumb(page, 1).dragTo(thumb(page, 0), { targetPosition: { x: 60, y: 8 } });
  await expect(thumb(page, 0)).toHaveClass(/selected/);
  await expect(page.locator("#pageNumber")).toHaveValue("1");

  await page.locator("#btnSaveAs").click();
  const doc = await inspect((await lastSaved(page)).bytes);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 2", "Page 1", "Page 3", "Page 3", "", "Page 4", "Page 5"]);
  expect(doc.pages.map((p) => p.rotate)).toEqual([0, 90, 0, 0, 0, 0, 0]);
  expect(doc.pages[4].text.trim()).toBe("");
});

test("multi-select with shift and extract to a new file", async ({ page }) => {
  await openSample(page);
  await thumb(page, 1).click();
  await thumb(page, 3).click({ modifiers: ["Shift"] });
  await expect(page.locator("#selectionInfo")).toHaveText("3 pages selected");
  await page.locator("#pgExtract").click();
  const { name, bytes } = await lastSaved(page);
  expect(name).toBe("sample-p2-4.pdf");
  const doc = await inspect(bytes);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 2", "Page 3", "Page 4"]);
  // The open document is untouched.
  await expect(pageCount(page)).toHaveText("/ 5");
});

test("adds text and ink annotations and saves them as real annotations", async ({ page }) => {
  await openSample(page);
  const page1 = page.locator('.page[data-page-number="1"]');

  await page.locator('.tool[data-tool="text"]').click();
  await expect(page.locator('.tool[data-tool="text"]')).toHaveAttribute("aria-checked", "true");
  await page1.click({ position: { x: 300, y: 520 } });
  await page.keyboard.type("Hello Palimpsest");
  await page1.click({ position: { x: 700, y: 900 } }); // commit
  await expect(page.locator(".freeTextEditor").first()).toBeVisible();

  await page.locator('.tool[data-tool="ink"]').click();
  const box = (await page1.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 700);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 200 + i * 20, box.y + 700 + (i % 2) * 30);
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await expect(page.locator("#docTitle .dirty")).toBeVisible();

  await page.keyboard.press("Control+s");
  const doc = await inspect((await lastSaved(page)).bytes);
  const subtypes = doc.pages[0].annotations.map((a) => a.subtype);
  expect(subtypes).toContain("FreeText");
  expect(subtypes).toContain("Ink");
  const free = doc.pages[0].annotations.find((a) => a.subtype === "FreeText")!;
  expect(free.contents).toContain("Hello Palimpsest");
});

test("opens through the file picker and saves back in place", async ({ page }) => {
  const data = readFileSync(await sampleFile()).toString("base64");
  await stubOpenPicker(page, {
    pdf: { name: "picked.pdf", type: "application/pdf", data },
    image: { name: "red.png", type: "image/png", data: PNG_RED },
  });
  await page.goto("./");
  await page.locator("#btnOpenEmpty").click();
  await expect(pageCount(page)).toHaveText("/ 5");
  await expect(page.locator("#docTitle")).toContainText("picked.pdf");

  // Image tool opens the image picker and drops the image on the current page.
  await page.locator('.tool[data-tool="image"]').click();
  await expect(page.locator(".stampEditor")).toHaveCount(1);
  await page.locator('.tool[data-tool="none"]').click();

  await page.keyboard.press("Control+s");
  const saved = await lastSaved(page);
  expect(saved.name).toBe("picked.pdf");
  const doc = await inspect(saved.bytes);
  expect(doc.pages[0].annotations.map((a) => a.subtype)).toContain("Stamp");
  await expect(page.locator("#docTitle .dirty")).toHaveCount(0);
});

test("tool options set defaults and restyle the selected annotation", async ({ page }) => {
  await openSample(page);
  const page1 = page.locator('.page[data-page-number="1"]');
  await page.locator('.tool[data-tool="text"]').click();
  await expect(page.locator("#optFontSize")).toHaveValue("12");
  await page.locator("#optFontSize").fill("20");
  await page1.click({ position: { x: 300, y: 300 } });
  await page.keyboard.type("Big");
  await page1.click({ position: { x: 600, y: 600 } }); // commit; new text box not created on empty commit
  const editor = page.locator(".freeTextEditor").first();
  await expect(editor).toHaveCSS("font-size", /px$/);
  const big = parseFloat(await editor.locator(".internal").evaluate((e) => getComputedStyle(e).fontSize));

  // Select the annotation and shrink it via the toolbar.
  await page.keyboard.press("Escape");
  await editor.click();
  await expect(page.locator("#optFontSize")).toHaveValue("20");
  await page.locator("#optFontSize").fill("10");
  await expect
    .poll(async () => parseFloat(await editor.locator(".internal").evaluate((e) => getComputedStyle(e).fontSize)))
    .toBeLessThan(big);
});

test("defaults apply when switching straight from one tool to another", async ({ page }) => {
  await openSample(page);
  const page1 = page.locator('.page[data-page-number="1"]');
  // Highlight some text, then go directly to the pen (the highlight stays selected in pdf.js).
  await page.locator('.tool[data-tool="highlight"]').click();
  const span = page1.locator(".textLayer span", { hasText: "Unique marker zebra1" });
  const b = (await span.boundingBox())!;
  await page.mouse.move(b.x + 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".highlightEditor")).toHaveCount(1);

  await page.locator('.tool[data-tool="ink"]').click();
  await page.locator("#optColor").fill("#e5484d");
  const box = (await page1.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 750);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + 200 + i * 20, box.y + 750 + (i % 2) * 25);
  await page.mouse.up();

  // And straight from the pen to text: the new box uses the toolbar size.
  await page.locator('.tool[data-tool="text"]').click();
  await expect(page.locator("#optFontSize")).toHaveValue("12");
  await page1.click({ position: { x: 300, y: 300 } });
  await page.keyboard.type("Sized");
  await expect(page.locator(".freeTextEditor .internal")).toHaveAttribute("style", /font-size: calc\(12px/);
  await page1.click({ position: { x: 600, y: 620 } });

  await page.locator("#btnSaveAs").click();
  const annots = (await inspect((await lastSaved(page)).bytes)).pages[0].annotations;
  expect(annots.find((a) => a.subtype === "Ink")).toMatchObject({ color: "#e5484d", borderWidth: 2 });
  expect(annots.find((a) => a.subtype === "Highlight")?.color).toBe("#ffff98");
});

test("annotations survive a page operation", async ({ page }) => {
  await openSample(page);
  const page1 = page.locator('.page[data-page-number="1"]');
  await page.locator('.tool[data-tool="text"]').click();
  await page1.click({ position: { x: 300, y: 520 } });
  await page.keyboard.type("Keep me");
  await page1.click({ position: { x: 700, y: 900 } });
  await page.locator('.tool[data-tool="none"]').click();

  await thumb(page, 4).click();
  await page.locator("#pgDelete").click();
  await expect(pageCount(page)).toHaveText("/ 4");
  await page.locator("#btnSaveAs").click();
  const doc = await inspect((await lastSaved(page)).bytes);
  expect(doc.pages[0].annotations.find((a) => a.subtype === "FreeText")?.contents).toContain("Keep me");
});

test("fills form fields", async ({ page }) => {
  await openSample(page);
  await page.locator('.annotationLayer input[type="text"]').first().fill("Ada Lovelace");
  await page.locator('.annotationLayer input[type="checkbox"]').first().check();
  await expect(page.locator("#docTitle .dirty")).toBeVisible();
  await page.locator("#btnSaveAs").click();
  const doc = await inspect((await lastSaved(page)).bytes);
  const fields = Object.fromEntries(doc.pages[0].annotations.filter((a) => a.fieldName).map((a) => [a.fieldName, a.fieldValue]));
  expect(fields.name).toBe("Ada Lovelace");
  expect(fields.agree).not.toBe("Off");
});

test("form values survive page operations and extraction", async ({ page }) => {
  const fieldValues = (doc: Awaited<ReturnType<typeof inspect>>) =>
    Object.fromEntries(doc.pages[0].annotations.filter((a) => a.fieldName).map((a) => [a.fieldName, a.fieldValue]));
  const saves = () => page.evaluate(() => (window as unknown as { __saved: unknown[] }).__saved.length);
  await openSample(page);
  await page.locator('.annotationLayer input[type="text"]').first().fill("Ada Lovelace");
  await page.locator('.annotationLayer input[type="checkbox"]').first().check();

  // Saving a selection as a new file takes the unsaved values along.
  await thumb(page, 0).click();
  await thumb(page, 1).click({ modifiers: ["Shift"] });
  await page.locator("#pgExtract").click();
  await expect.poll(saves).toBe(1);
  const extracted = await inspect((await lastSaved(page)).bytes);
  expect(extracted.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 2"]);
  expect(fieldValues(extracted).name).toBe("Ada Lovelace");

  // So does a page operation on the open document.
  await thumb(page, 4).click();
  await page.locator("#pgDelete").click();
  await expect(pageCount(page)).toHaveText("/ 4");
  await thumb(page, 0).click();
  await expect(page.locator('.page[data-page-number="1"] .annotationLayer input[type="text"]')).toHaveValue("Ada Lovelace");
  await page.locator("#btnSaveAs").click();
  await expect.poll(saves).toBe(2);
  const doc = await inspect((await lastSaved(page)).bytes);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 2", "Page 3", "Page 4"]);
  const fields = fieldValues(doc);
  expect(fields.name).toBe("Ada Lovelace");
  expect(fields.agree).not.toBe("Off");
});

test("edits document properties", async ({ page }) => {
  await openSample(page);
  await page.locator("#btnProps").click();
  await expect(page.locator("#propTitle")).toHaveValue("Palimpsest sample");
  await page.locator("#propTitle").fill("Renamed by test");
  await page.locator("#propAuthor").fill("Test Author");
  await page.locator("#propsDialog button.primary").click();
  await expect(page.locator("#docTitle .dirty")).toBeVisible();
  await page.locator("#btnSaveAs").click();
  const doc = await inspect((await lastSaved(page)).bytes);
  expect(doc.meta.Title).toBe("Renamed by test");
  expect(doc.meta.Author).toBe("Test Author");
});

test("keyboard: tool shortcuts and zoom", async ({ page }) => {
  await openSample(page);
  await page.locator("#viewerContainer").focus();
  await page.keyboard.press("d");
  await expect(page.locator('.tool[data-tool="ink"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#optThickness")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('.tool[data-tool="none"]')).toHaveAttribute("aria-checked", "true");
  await page.locator("#zoomSelect").selectOption("2");
  await expect(page.locator("#zoomSelect")).toHaveValue("2");
  await page.keyboard.press("Control+-");
  await expect(page.locator("#zoomSelect")).not.toHaveValue("2");
});

test("opens a same-origin ?file= URL on start", async ({ page }) => {
  const body = readFileSync(await sampleFile());
  await page.route("**/from-url.pdf", (route) => route.fulfill({ body, contentType: "application/pdf" }));
  await page.goto("./?file=from-url.pdf");
  await expect(pageCount(page)).toHaveText("/ 5");
  await expect(page.locator("#docTitle")).toContainText("from-url.pdf");
});

test("opens password-protected PDFs and keeps them encrypted", async ({ page }) => {
  await page.goto("./");
  await page.setInputFiles("#fileInput", "tests/fixtures/encrypted.pdf");
  await expect(page.locator("#passwordDialog")).toBeVisible();
  await page.locator("#passwordInput").fill("wrong");
  await page.locator("#passwordDialog button.primary").click();
  await expect(page.locator("#passwordMsg")).toContainText("not correct");
  await page.locator("#passwordInput").fill("secret");
  await page.locator("#passwordDialog button.primary").click();
  await expect(pageCount(page)).toHaveText("/ 5");

  await thumb(page, 1).click();
  await page.locator("#pgDelete").click();
  await expect(pageCount(page)).toHaveText("/ 4");
  await page.locator("#pgRotR").click();
  await expect(page.locator(".toast.error")).toContainText("not supported on encrypted PDFs");

  await page.locator("#btnSaveAs").click();
  const { bytes } = await lastSaved(page);
  await expect(inspect(bytes)).rejects.toThrow(/password/i);
  const doc = await inspect(bytes, "secret");
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 3", "Page 4", "Page 5"]);
});

test("installable: manifest declares a PDF file handler", async ({ page, request }) => {
  await page.goto("./");
  const manifest = await (await request.get("manifest.webmanifest")).json();
  expect(manifest.file_handlers[0].accept["application/pdf"]).toContain(".pdf");
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()))).toBe(true);
});
