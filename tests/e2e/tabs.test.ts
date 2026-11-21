/** Tabs: several documents in one window, each keeping its own state. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { numberedPdf } from "../fixtures/make";
import { answer, dirty, launch, onPage, opened, poll, readPdf, sampleIn, savedTo, useApp, workDir } from "./harness";
import { Key, type Session } from "./webdriver";

useApp();

const tabs = (app: Session) =>
  app.exec<string[]>(
    `return [...document.querySelectorAll("#tabbar .doc-tab")].map((t) =>
       (t.getAttribute("aria-selected") === "true" ? "*" : "") + t.querySelector(".name").textContent + (t.querySelector(".dirty") ? " ●" : ""))`,
  );

test("tabs: open several files, switch keeping each one's place and edits, close them", async () => {
  const dir = workDir();
  const a = await sampleIn(dir, "a.pdf");
  const b = join(dir, "b.pdf");
  writeFileSync(b, await numberedPdf(3, "Other"));
  const app = await launch(a);
  await opened(app);
  // One document: no tab bar.
  expect(await app.visible("#tabbar")).toBe(false);

  answer({ pdf: [b] });
  await app.press(Key.Control, "o");
  await poll(() => app.text("#pageCount")).toBe("/ 3");
  await poll(() => tabs(app)).toEqual(["a.pdf", "*b.pdf"]);
  expect(await app.visible("#tabbar")).toBe(true);

  // In b: go to page 3 and draw something (not saved).
  await app.fill("#pageNumber", "3");
  await app.click('.toolbar .tool[data-tool="shape"]');
  const p = await onPage(app, 3, 100, 100);
  await app.drag([p, [p[0] + 100, p[1] + 60], [p[0] + 200, p[1] + 120]]);
  await poll(() => app.count(".inkEditor")).toBe(1);
  await poll(() => tabs(app)).toEqual(["a.pdf", "*b.pdf ●"]);

  // To a: its own document, page and title.
  await app.click('#tabbar .doc-tab:first-child .name');
  await poll(() => app.text("#pageCount")).toBe("/ 5");
  expect(await app.value("#pageNumber")).toBe("1");
  expect(await app.title()).toMatch(/^a\.pdf — Palimpsest/);
  expect(await tabs(app)).toEqual(["*a.pdf", "b.pdf ●"]);
  expect(await dirty(app)).toBe(false);

  // Back to b (Ctrl+Tab): page 3, still unsaved, the drawing still there.
  await app.exec("document.querySelector('#viewerContainer').focus()");
  await app.press(Key.Control, Key.Tab);
  await poll(() => app.text("#pageCount")).toBe("/ 3");
  await poll(() => app.value("#pageNumber")).toBe("3");
  expect(await dirty(app)).toBe(true);
  const out = join(dir, "b-out.pdf");
  answer({ save: out });
  await app.press(Key.Control, Key.Shift, "s");
  expect((await savedTo(out)).pages[2].annotations.map((x) => x.subtype)).toContain("Ink");
  // The drawing, put away with the tab, is one step to undo.
  await app.press(Key.Control, "z");
  await poll(() => app.text(".toast:last-child")).toBe("Undid: annotation and form edits");

  // Opening a file that is already open shows its tab.
  answer({ pdf: [a] });
  await app.press(Key.Control, "o");
  await poll(() => tabs(app)).toEqual(["*a.pdf", "b-out.pdf ●"]);

  // Closing: a document with unsaved changes asks first.
  await app.press(Key.Control, Key.Tab);
  await poll(() => tabs(app)).toEqual(["a.pdf", "*b-out.pdf ●"]);
  await app.press(Key.Control, "w");
  await poll(() => app.exec("return document.querySelector('#confirmDialog').open")).toBe(true);
  expect(await app.text("#confirmMsg")).toBe("b-out.pdf has changes that have not been saved.");
  await app.click("#confirmOk");
  await poll(() => app.text("#pageCount")).toBe("/ 5");
  expect(await app.visible("#tabbar")).toBe(false);
  expect(await app.exec("return window.palimpsest.tabCount")).toBe(1);
  // The last one closes to the start screen.
  await app.press(Key.Control, "w");
  await poll(() => app.attr("#app", "class")).toMatch(/\bno-doc\b/);
  expect(await app.title()).toBe("Palimpsest");
  expect((await readPdf(a)).pages).toHaveLength(5); // never touched
});

test("closing the window asks about unsaved changes in any tab", async () => {
  const dir = workDir();
  const a = await sampleIn(dir, "a.pdf");
  const b = await sampleIn(dir, "b.pdf");
  const app = await launch(a);
  await opened(app);
  await app.type('.page[data-page-number="1"] .annotationLayer input[type="text"]', "Changed");
  await poll(() => dirty(app)).toBe(true);
  answer({ pdf: [b] });
  await app.click("#btnOpen");
  await poll(() => tabs(app)).toEqual(["a.pdf ●", "*b.pdf"]);
  // a, not showing, has unsaved form values: closing the window asks.
  void app.exec("window.palimpsest.confirmDiscard().then((ok) => (window.__answer = ok))");
  await poll(() => app.exec("return document.querySelector('#confirmDialog').open")).toBe(true);
  expect(await app.text("#confirmMsg")).toBe("a.pdf has changes that have not been saved.");
  await app.click('#confirmDialog button[value="cancel"]');
  await poll(() => app.exec("return window.__answer")).toBe(false);
});
