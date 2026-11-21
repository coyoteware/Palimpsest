/** Shapes, text markup and Fill & Sign: what they draw, and what is saved. */
import { join } from "node:path";
import { expect, test } from "vitest";
import { answer, clickPage, launch, onPage, opened, poll, sampleIn, savedTo, useApp, workDir } from "./harness";
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
