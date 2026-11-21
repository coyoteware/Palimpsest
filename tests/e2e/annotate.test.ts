/** Shapes, text markup and Fill & Sign: what they draw, and what is saved. */
import { join } from "node:path";
import { expect, test } from "vitest";
import { answer, clickPage, launch, onPage, opened, poll, sampleIn, savedTo, shellLog, useApp, workDir } from "./harness";
import { Key, type Session } from "./webdriver";

useApp();

const tool = (name: string) => `.toolbar .tool[data-tool="${name}"]`;

async function openSample() {
  const dir = workDir();
  const app = await launch(await sampleIn(dir));
  await opened(app);
  return { app, dir };
}

async function saveAs(app: Session, dir: string) {
  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  return savedTo(out);
}

/** Drag on page 1 from one point to another (CSS pixels from the page's top left). */
async function dragOnPage(app: Session, from: [number, number], to: [number, number]) {
  const a = await onPage(app, 1, ...from);
  const b = await onPage(app, 1, ...to);
  await app.drag([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b]);
}

/** Select the text of the span on page 1 containing `text`, by dragging across it. */
async function selectText(app: Session, text: string) {
  const [x, y, w, h] = await app.exec<[number, number, number, number]>(
    `const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
       .find((s) => s.textContent.includes(arguments[0]));
     span.scrollIntoView({ block: "center" });
     const r = span.getBoundingClientRect();
     return [r.left, r.top, r.width, r.height];`,
    text,
  );
  await app.drag([[x + 1, y + h / 2], [x + w / 2, y + h / 2], [x + w - 1, y + h / 2]], 40);
}

test("shapes are drawn by dragging and saved as ink, in the toolbar's colour", async () => {
  const { app, dir } = await openSample();
  await app.exec("document.querySelector('#viewerContainer').focus()");
  await app.press("s");
  await poll(() => app.attr(tool("shape"), "aria-checked")).toBe("true");
  expect(await app.attr('#toolOptions [data-shape="rect"]', "aria-checked")).toBe("true");
  await dragOnPage(app, [100, 500], [300, 600]);
  await poll(() => app.count(".inkEditor")).toBe(1);
  // Still the shape tool, ready for the next one.
  expect(await app.attr(tool("shape"), "aria-checked")).toBe("true");

  await app.click('#toolOptions [data-shape="arrow"]');
  await app.fill("#optColor", "#2050e0");
  await dragOnPage(app, [100, 700], [400, 650]);
  await poll(() => app.count(".inkEditor")).toBe(2);
  // A click is not a shape.
  await clickPage(app, 1, 500, 300);
  // Undo takes the last shape away, redo brings it back.
  await app.press(Key.Control, "z");
  await poll(() => app.count(".inkEditor")).toBe(1);
  await app.press(Key.Control, Key.Shift, "z");
  await poll(() => app.count(".inkEditor")).toBe(2);

  const ink = (await saveAs(app, dir)).pages[0].annotations.filter((a) => a.subtype === "Ink");
  expect(ink.map((a) => a.color)).toEqual(["#e5484d", "#2050e0"]);
  // The rectangle is one closed stroke of five corners; the arrow is a shaft and a head.
  const [rect] = ink[0].ink;
  expect(rect).toHaveLength(5);
  expect(rect[4]).toEqual(rect[0]);
  // Dragged 200 × 100 CSS pixels: twice as wide as tall, in points too.
  const [[x1, y1], , [x2, y2]] = rect;
  expect(Math.abs(x2 - x1) / Math.abs(y2 - y1)).toBeCloseTo(2, 1);
  expect(ink[1].ink.map((stroke) => stroke.length)).toEqual([2, 3]);
});

test("underline, strike out and squiggle selected text", async () => {
  const { app, dir } = await openSample();
  await app.click(tool("markup"));
  expect(await app.attr('#toolOptions [data-markup="underline"]', "aria-checked")).toBe("true");
  await selectText(app, "Unique marker zebra1");
  await poll(() => app.count(".inkEditor")).toBe(1);
  // The selection is used up.
  expect(await app.exec("return window.getSelection().isCollapsed")).toBe(true);
  await app.click('#toolOptions [data-markup="strikeout"]');
  await selectText(app, "Page 1");
  await poll(() => app.count(".inkEditor")).toBe(2);

  const ink = (await saveAs(app, dir)).pages[0].annotations.filter((a) => a.subtype === "Ink");
  expect(ink).toHaveLength(2);
  const [under, strike] = ink;
  expect(under.color).toBe("#e5484d");
  // One flat line, as wide as the text.
  const [[[ux1, uy1], [ux2, uy2]]] = under.ink;
  expect(uy1).toBeCloseTo(uy2);
  expect(ux2 - ux1).toBeGreaterThan(100);
  // "Page 1" is 32 pt type with its baseline at y = 690: the strike-out runs through it.
  const [[[sx1, sy1], [sx2, sy2]]] = strike.ink;
  expect(sy1).toBeCloseTo(sy2);
  expect(sx2 - sx1).toBeGreaterThan(60);
  expect(sy1).toBeGreaterThan(690);
  expect(sy1).toBeLessThan(690 + 24);
});

test("Fill & Sign: marks, the date, and a typed signature kept for next time", async () => {
  const { app, dir } = await openSample();
  const menuItem = async (label: string) => {
    await app.click(tool("sign"));
    await poll(() => app.visible("#signMenu")).toBe(true);
    await app.exec(
      `[...document.querySelectorAll("#signMenu [role=menuitem]")].find((b) => b.textContent.includes(arguments[0])).click()`,
      label,
    );
  };
  await menuItem("Check mark");
  await poll(() => app.attr(tool("sign"), "aria-checked")).toBe("true");
  expect(await app.text("#signHint")).toBe("Click on the page to add a check mark");
  await clickPage(app, 1, 63, 300);
  await poll(() => app.count(".inkEditor")).toBe(1);
  await clickPage(app, 1, 120, 300); // the tool stays on: another one
  await poll(() => app.count(".inkEditor")).toBe(2);

  await menuItem("Date");
  await clickPage(app, 1, 300, 360);
  await poll(() => app.count(".freeTextEditor")).toBe(1);
  const today = await app.exec<string>("return new Date().toLocaleDateString()");

  await menuItem("Add signature");
  await poll(() => app.exec("return document.querySelector('#signatureDialog').open")).toBe(true);
  expect(await app.exec("return document.querySelector('#sigOk').disabled")).toBe(true);
  await app.type("#sigName", "Ada Lovelace");
  await poll(() => app.text("#sigPreview")).toBe("Ada Lovelace");
  await app.click("#sigOk");
  await poll(() => app.text("#signHint")).toBe("Click on the page to add your signature");
  await clickPage(app, 1, 300, 420);
  await poll(() => app.count(".stampEditor")).toBe(1);
  // Placed where clicked, and shown (the date too).
  const centre = await app.exec<[number, number]>(
    `const p = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
     const r = document.querySelector(".stampEditor").getBoundingClientRect();
     return [r.left + r.width / 2 - p.left, r.top + r.height / 2 - p.top];`,
  );
  expect(centre[0]).toBeCloseTo(300, -1);
  expect(centre[1]).toBeCloseTo(420, -1);
  expect(await app.visible(".freeTextEditor")).toBe(true);
  expect(await app.text(".freeTextEditor .internal")).toBe(today);

  // Saved for next time: the menu offers it.
  await app.click(tool("sign"));
  await poll(() => app.count("#signMenu .signature-item img")).toBe(1);
  // Placing things left the tool on.
  expect(await app.attr(tool("sign"), "aria-checked")).toBe("true");
  await app.press(Key.Escape); // closes the menu
  await app.press(Key.Escape); // leaves the tool
  await poll(() => app.attr(tool("none"), "aria-checked")).toBe("true");

  const annots = (await saveAs(app, dir)).pages[0].annotations;
  const checks = annots.filter((a) => a.subtype === "Ink");
  expect(checks.map((a) => a.ink.map((stroke) => stroke.length))).toEqual([[3], [3]]);
  // Each one 12 points wide, the second to the right of the first.
  const xs = checks.map((a) => a.ink[0].map(([x]) => x));
  expect(Math.max(...xs[0]) - Math.min(...xs[0])).toBeCloseTo(12, 0);
  expect(Math.min(...xs[1])).toBeGreaterThan(Math.max(...xs[0]));
  expect(annots.find((a) => a.subtype === "FreeText")?.contents).toBe(today);
  const stamp = annots.find((a) => a.subtype === "Stamp")!;
  expect(stamp).toBeDefined();
  const [x1, y1, x2, y2] = stamp.rect;
  expect(x2 - x1).toBeLessThanOrEqual(161);
  expect(y2 - y1).toBeLessThanOrEqual(49);
});

test("Fill & Sign: a drawn signature", async () => {
  const { app, dir } = await openSample();
  await app.click(tool("sign"));
  await poll(() => app.visible("#signMenu")).toBe(true);
  await app.exec(`[...document.querySelectorAll("#signMenu [role=menuitem]")].find((b) => b.textContent.includes("Add initials")).click()`);
  await poll(() => app.exec("return document.querySelector('#signatureDialog').open")).toBe(true);
  expect(await app.text("#sigTitle")).toBe("Add initials");
  await app.click('#signatureDialog [data-mode="draw"]');
  const [x, y] = await app.center("#sigCanvas");
  await app.drag([[x - 80, y], [x - 40, y - 20], [x, y + 20], [x + 40, y - 20], [x + 80, y]]);
  await poll(() => app.exec("return document.querySelector('#sigOk').disabled")).toBe(false);
  // Not kept this time.
  await app.click("#sigSave");
  await app.click("#sigOk");
  await clickPage(app, 1, 300, 420);
  await poll(() => app.count(".stampEditor")).toBe(1);
  expect(await app.exec("return JSON.parse(localStorage.getItem('palimpsest:signatures') ?? '[]').length")).toBe(0);
  const annots = (await saveAs(app, dir)).pages[0].annotations;
  expect(annots.map((a) => a.subtype)).toContain("Stamp");
});

test("sticky notes, and the comments panel: listed, shown, edited, deleted", async () => {
  const { app, dir } = await openSample();
  await app.exec("document.querySelector('#viewerContainer').focus()");
  await app.press("n");
  await poll(() => app.attr(tool("note"), "aria-checked")).toBe("true");
  await clickPage(app, 1, 450, 200);
  await poll(() => app.exec("return document.querySelector('#noteDialog').open")).toBe(true);
  await app.type("#noteText", "Check the figures");
  await app.fill("#noteAuthor", "Ada");
  await app.click("#noteOk");
  // The note is on the page, as pdf.js draws notes.
  await poll(() => app.count('.page[data-page-number="1"] .annotationLayer .textAnnotation')).toBe(1);

  // A drawing not saved yet is listed too.
  await app.press("s");
  await dragOnPage(app, [100, 600], [250, 700]);
  await poll(() => app.count(".inkEditor")).toBe(1);

  await app.click("#tabComments");
  const items = () =>
    app.exec<string[]>(
      `return [...document.querySelectorAll("#commentList .comment")].map((c) =>
         [...c.querySelectorAll(".comment-kind, .comment-author")].map((e) => e.textContent).join(" · ") + ": " + c.querySelector(".comment-text").textContent)`,
    );
  await poll(items).toEqual(["Note · Ada: Check the figures", "Drawing: No comment"]);
  expect(await app.text("#commentList .comment-page h3")).toBe("Page 1");

  // Edit the note's text from the panel.
  await app.click('#commentList .comment:first-child button[aria-label="Edit comment"]');
  await poll(() => app.value("#noteText")).toBe("Check the figures");
  await app.fill("#noteText", "Figures checked");
  await app.click("#noteOk");
  await poll(items).toEqual(["Note · Ada: Figures checked", "Drawing: No comment"]);

  // Delete the drawing; undo brings it back.
  await app.click('#commentList .comment:last-child button[aria-label="Delete"]');
  await poll(() => app.exec("return document.querySelector('#confirmDialog').open")).toBe(true);
  expect(await app.text("#confirmTitle")).toBe("Delete this drawing?");
  await app.click("#confirmOk");
  await poll(items).toEqual(["Note · Ada: Figures checked"]);
  await app.click("#btnUndo");
  await poll(items).toEqual(["Note · Ada: Figures checked", "Drawing: No comment"]);

  const annots = (await saveAs(app, dir)).pages[0].annotations;
  expect(annots.find((a) => a.subtype === "Text")).toMatchObject({ contents: "Figures checked", author: "Ada" });
  expect(annots.map((a) => a.subtype)).toEqual(expect.arrayContaining(["Text", "Popup", "Ink"]));
});

test("print: which pages, with or without comments, fit or actual size", async () => {
  const { app } = await openSample();
  const printed = () => app.count("#printContainer .print-page");
  const printCount = () => shellLog().filter((e) => e.print).length;
  const open = async () => {
    await app.press(Key.Control, "p");
    await poll(() => app.exec("return document.querySelector('#printDialog').open")).toBe(true);
  };
  /** Is there red in the printed image of the first printed page? */
  const hasRed = () =>
    app.execAsync<boolean>(
      `const done = arguments[arguments.length - 1];
       const img = document.querySelector("#printContainer .print-page img");
       img.decode().then(() => {
         const c = document.createElement("canvas");
         c.width = img.naturalWidth; c.height = img.naturalHeight;
         const ctx = c.getContext("2d");
         ctx.drawImage(img, 0, 0);
         const d = ctx.getImageData(0, 0, c.width, c.height).data;
         for (let i = 0; i < d.length; i += 4 * 7) if (d[i] > 200 && d[i + 1] < 100 && d[i + 2] < 100) return done(true);
         done(false);
       });`,
    );

  // A red box drawn on page 2, to print with and without.
  await app.click(tool("shape"));
  await app.fill("#optThickness", "12");
  const a = await onPage(app, 2, 150, 300);
  const b = await onPage(app, 2, 400, 450);
  await app.drag([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b]);
  await poll(() => app.count(".inkEditor")).toBe(1);
  await app.click(tool("none"));
  await poll(() => app.exec("return window.palimpsest.page")).toBe(2);

  await open();
  expect(await app.text("#printPreview")).toBe("5 pages to print");
  // Only the current page.
  await app.click('#printDialog input[value="current"]');
  expect(await app.text("#printPreview")).toBe("1 page to print");
  await app.click("#printOk");
  await poll(printCount).toBe(1);
  expect(await printed()).toBe(1);
  expect(await hasRed()).toBe(true);

  // Without comments and markup.
  await open();
  await app.click("#printComments");
  await app.click("#printOk");
  await poll(printCount).toBe(2);
  expect(await hasRed()).toBe(false);

  // A range: mistakes are explained and stop the print; pages print in the order given.
  await open();
  await app.fill("#printRange", "9");
  await poll(() => app.text("#printPreview")).toBe("There is no page 9; the document has 5 pages.");
  expect(await app.exec("return document.querySelector('#printOk').disabled")).toBe(true);
  await app.fill("#printRange", "4-5, 1");
  await poll(() => app.text("#printPreview")).toBe("3 pages to print");
  await app.click('#printDialog input[value="actual"]');
  await app.click("#printOk");
  await poll(printCount).toBe(3);
  expect(await printed()).toBe(3);
  expect(await app.attr("#printContainer .print-page img", "style")).toMatch(/width: 612pt/);
  // Cancel prints nothing.
  await open();
  await app.click('#printDialog button[value="cancel"]');
  await new Promise((r) => setTimeout(r, 300));
  expect(printCount()).toBe(3);
});
