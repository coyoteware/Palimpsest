/**
 * Reading features: page labels, bookmarks, attachments, layers, back and
 * forward, page layouts, rotating the view, presentation mode.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LAYER_BOX } from "../fixtures/rich";
import { answer, dirty, launch, onPage, opened, poll, richIn, sampleIn, savedTo, shellLog, STARTUP, useApp, workDir } from "./harness";
import { Key, type Session } from "./webdriver";

useApp();

async function openRich() {
  const dir = workDir();
  const path = await richIn(dir);
  const app = await launch(path);
  await poll(() => app.text("#pageCount"), STARTUP).toBe("(1 of 6)");
  await poll(() => app.count('.page[data-page-number="1"] .textLayer span')).toBeGreaterThan(0);
  return { app, dir, path };
}

const pageBox = (app: Session) => Promise.all([app.value("#pageNumber"), app.text("#pageCount")]);
const treeTitles = (app: Session) =>
  app.exec<string[]>(
    `return [...document.querySelectorAll("#outlineTree [role=treeitem]")]
       .filter((li) => li.checkVisibility())
       .map((li) => li.querySelector(".tree-title").textContent)`,
  );
const treeItem = (title: string) =>
  `#outlineTree [role=treeitem]:has(> .tree-row > .tree-title[title="${title}"])`;

test("page labels show in the page box and can be typed", async () => {
  const { app } = await openRich();
  expect(await pageBox(app)).toEqual(["i", "(1 of 6)"]);
  expect(await app.text('.thumb[data-index="1"] .thumb-label')).toBe("ii");
  expect(await app.text('.thumb[data-index="2"] .thumb-label')).toBe("1");

  // A label goes to that page, even when it is also a page number.
  await app.fill("#pageNumber", "3");
  await poll(() => pageBox(app)).toEqual(["3", "(5 of 6)"]);
  await app.fill("#pageNumber", "ii");
  await poll(() => pageBox(app)).toEqual(["ii", "(2 of 6)"]);
  // Anything else puts the current label back.
  await app.fill("#pageNumber", "xyz");
  await poll(() => pageBox(app)).toEqual(["ii", "(2 of 6)"]);
});

test("bookmarks: a tree that opens, closes and navigates; back and forward return", async () => {
  const { app } = await openRich();
  // The sample has no attachments or layers… this one does: their tabs show.
  expect(await app.visible("#tabAttachments")).toBe(true);
  await app.click("#tabOutline");
  await poll(() => app.visible("#outlineTree")).toBe(true);
  // Chapter 1 is open in the PDF, the appendix is not.
  expect(await treeTitles(app)).toEqual(["Preface", "Chapter 1", "Section 1.1", "Section 1.2", "Appendix"]);
  expect(await app.attr(treeItem("Appendix"), "aria-expanded")).toBe("false");

  await app.click(`${treeItem("Section 1.1")} .tree-title`);
  await poll(() => pageBox(app)).toEqual(["2", "(4 of 6)"]);
  expect(await app.exec("return document.querySelector('#btnBack').disabled")).toBe(false);
  await app.click("#btnBack");
  await poll(() => pageBox(app)).toEqual(["i", "(1 of 6)"]);
  await app.click("#btnForward");
  await poll(() => pageBox(app)).toEqual(["2", "(4 of 6)"]);

  // Keyboard: Right opens the appendix, Down reaches its child, Enter follows it.
  await app.exec(`document.querySelector(arguments[0]).focus()`, treeItem("Appendix"));
  await app.press(Key.ArrowRight);
  await poll(() => treeTitles(app)).toContain("Notes");
  await app.press(Key.ArrowDown);
  await app.press(Key.Enter);
  await poll(() => pageBox(app)).toEqual(["4", "(6 of 6)"]);
  await app.press(Key.ArrowLeft); // to the parent
  await app.press(Key.ArrowLeft); // closes it
  await poll(() => treeTitles(app)).not.toContain("Notes");
});

test("a link in the page, then Alt+Left goes back to where it was", async () => {
  const { app } = await openRich();
  await app.click('.page[data-page-number="1"] .annotationLayer .linkAnnotation a');
  await poll(() => pageBox(app)).toEqual(["3", "(5 of 6)"]);
  await app.exec("document.querySelector('#viewerContainer').focus()");
  await app.press(Key.Alt, Key.ArrowLeft);
  await poll(() => pageBox(app)).toEqual(["i", "(1 of 6)"]);
  await app.press(Key.Alt, Key.ArrowRight);
  await poll(() => pageBox(app)).toEqual(["3", "(5 of 6)"]);
});

test("attachments are listed and saved where the user chooses", async () => {
  const { app, dir } = await openRich();
  await app.click("#tabAttachments");
  await poll(() => app.text("#attachmentList .file-name")).toBe("notes.txt");
  expect(await app.text("#attachmentList .file-note")).toBe("Reading notes");
  const out = join(dir, "saved-notes.txt");
  answer({ save: out });
  await app.click("#attachmentList .file-row");
  await poll(() => app.text(".toast")).toContain("Saved saved-notes.txt");
  expect(readFileSync(out, "utf8")).toBe("Attached notes for the rich sample.\n");
  expect(shellLog().flatMap((e) => e.suggestedName ?? [])).toEqual(["notes.txt"]);
});

test("layers can be hidden and shown", async () => {
  const { app } = await openRich();
  await app.click("#tabLayers");
  await poll(() => app.text("#layerList .layer span")).toBe("Watermark");
  /** Is the layer's box drawn on page 2's canvas? */
  const boxShown = () =>
    app.exec<boolean>(
      `const [x, y, h] = arguments;
       const page = document.querySelector('.page[data-page-number="2"]');
       page.scrollIntoView();
       const canvas = page.querySelector("canvas");
       if (!canvas) return null;
       const scale = canvas.width / 612;
       const [r, g, b] = canvas.getContext("2d").getImageData(x * scale, (792 - y) * scale, 1, 1).data;
       return r > 200 && g < 80 && b < 80;`,
      LAYER_BOX.x + LAYER_BOX.width / 2,
      LAYER_BOX.y + LAYER_BOX.height / 2,
    );
  await poll(boxShown).toBe(true);
  await app.click("#layerList input[type=checkbox]");
  await poll(boxShown).toBe(false);
  await app.click("#layerList input[type=checkbox]");
  await poll(boxShown).toBe(true);
  expect(await dirty(app)).toBe(false);
});

test("view menu: page layouts and rotating the view", async () => {
  const dir = workDir();
  const app = await launch(await sampleIn(dir));
  await opened(app);
  // No attachments or layers here, so no tabs for them.
  expect(await app.visible("#tabAttachments")).toBe(false);
  expect(await app.visible("#tabLayers")).toBe(false);

  const viewer = (prop: string) => app.exec<number>(`return window.palimpsest.viewer[arguments[0]]`, prop);
  const choose = async (item: string) => {
    await app.click("#btnView");
    await poll(() => app.visible("#viewMenu")).toBe(true);
    await app.click(`#viewMenu ${item}`);
    await poll(() => app.visible("#viewMenu")).toBe(false);
  };
  await choose('[data-group="spread"][data-value="odd"]');
  await poll(() => app.count("#viewer .spread")).toBe(3);
  await choose('[data-group="scroll"][data-value="page"]');
  expect(await viewer("scrollMode")).toBe(3);
  // The menu shows what is chosen.
  await app.click("#btnView");
  expect(await app.attr('#viewMenu [data-value="page"]', "aria-checked")).toBe("true");
  expect(await app.attr('#viewMenu [data-value="odd"]', "aria-checked")).toBe("true");
  expect(await app.attr('#viewMenu [data-value="vertical"]', "aria-checked")).toBe("false");
  await app.press(Key.Escape);
  await poll(() => app.visible("#viewMenu")).toBe(false);
  await choose('[data-group="spread"][data-value="none"]');
  await choose('[data-group="scroll"][data-value="vertical"]');
  expect(await viewer("scrollMode")).toBe(0);
  expect(await app.count("#viewer .spread")).toBe(0);

  // Rotating the view turns the pages on screen, not in the file.
  await choose('[data-act="rotateViewCw"]');
  expect(await viewer("pagesRotation")).toBe(90);
  await app.exec("document.querySelector('#viewerContainer').focus()");
  await app.press(Key.Control, Key.Shift, "=");
  expect(await viewer("pagesRotation")).toBe(180);
  expect(await dirty(app)).toBe(false);
  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.click("#btnSaveAs");
  expect((await savedTo(out)).pages.map((p) => p.rotate)).toEqual([0, 0, 0, 0, 0]);
});

test("presentation mode: full screen, page by page, Escape ends it", async () => {
  const dir = workDir();
  const app = await launch(await sampleIn(dir));
  await opened(app);
  await app.exec("document.querySelector('#viewerContainer').focus()");
  await app.press(Key.Control, "l");
  await poll(() => app.attr("#app", "class")).toMatch(/\bpresenting\b/);
  expect(await app.visible(".toolbar")).toBe(false);
  await poll(() => shellLog().flatMap((e) => (e.fullscreen === undefined ? [] : [e.fullscreen]))).toEqual([true]);
  await app.press(Key.ArrowRight);
  await poll(() => app.exec("return window.palimpsest.page")).toBe(2);
  await app.press(Key.Space);
  await poll(() => app.exec("return window.palimpsest.page")).toBe(3);
  await app.press(Key.ArrowLeft);
  await poll(() => app.exec("return window.palimpsest.page")).toBe(2);
  await app.press(Key.Escape);
  await poll(() => app.attr("#app", "class")).not.toMatch(/\bpresenting\b/);
  expect(await app.visible(".toolbar")).toBe(true);
  expect(shellLog().flatMap((e) => (e.fullscreen === undefined ? [] : [e.fullscreen]))).toEqual([true, false]);
  expect(await app.exec("return window.palimpsest.viewer.scrollMode")).toBe(0);

  // Also from the View menu.
  await app.click("#btnView");
  await app.click('#viewMenu [data-act="present"]');
  await poll(() => app.attr("#app", "class")).toMatch(/\bpresenting\b/);
});

test("hand tool scrolls by dragging; zoom tool zooms to a box", async () => {
  const dir = workDir();
  const app = await launch(await sampleIn(dir));
  await opened(app);
  const scrollTop = () => app.exec<number>("return document.querySelector('#viewerContainer').scrollTop");
  const scale = () => app.exec<number>("return window.palimpsest.viewer.currentScale");

  await app.click('.toolbar .tool[data-tool="hand"]');
  const before = await scrollTop();
  const [x, y] = await app.center("#viewerContainer");
  await app.drag([[x, y + 150], [x, y + 50], [x, y - 150]]);
  expect((await scrollTop()) - before).toBeGreaterThan(250);
  // Dragging the page does not select text.
  expect(await app.exec("return window.getSelection().isCollapsed")).toBe(true);

  await app.exec("document.querySelector('#viewerContainer').focus()");
  await app.press("z");
  await poll(() => app.attr('.toolbar .tool[data-tool="zoom"]', "aria-checked")).toBe("true");
  const s0 = await scale();
  // A box a quarter of the page wide fills the window: about four times the zoom.
  const width = await app.exec<number>("return document.querySelector('.page').getBoundingClientRect().width / 4");
  const page = await app.exec<number>("return window.palimpsest.page");
  const a = await onPage(app, page, 100, 100);
  await app.drag([a, [a[0] + width / 2, a[1] + 20], [a[0] + width, a[1] + 40]]);
  await poll(scale).toBeGreaterThan(s0 * 3);
  const s1 = await scale();
  // Alt+click zooms out a step, a click zooms in again.
  const c = await app.center("#viewerContainer");
  await app.clickAt(c, Key.Alt);
  await poll(scale).toBeLessThan(s1);
  const s2 = await scale();
  await app.clickAt(c);
  await poll(scale).toBeGreaterThan(s2);
});

test("snapshot copies a box of the page as an image", async () => {
  const dir = workDir();
  const app = await launch(await sampleIn(dir));
  await opened(app);
  // Where the clipboard is not available, the image is saved instead.
  const out = join(dir, "snap.png");
  answer({ save: out });
  await app.click('.toolbar .tool[data-tool="snapshot"]');
  const a = await onPage(app, 1, 100, 100);
  await app.drag([a, [a[0] + 100, a[1] + 40], [a[0] + 200, a[1] + 80]]);
  await poll(() => app.text(".toast")).toMatch(/Copied to the clipboard|saved snap\.png/);
  const ratio = await app.exec<number>("return 2 * (window.devicePixelRatio || 1)");
  expect(await app.exec("return window.palimpsest.lastSnapshot")).toEqual({ width: 200 * ratio, height: 80 * ratio });
  if ((await app.text(".toast"))!.includes("saved")) {
    expect(readFileSync(out).subarray(1, 4).toString()).toBe("PNG");
    expect(shellLog().flatMap((e) => e.suggestedName ?? [])).toEqual(["sample-p1-snapshot.png"]);
  }
});
