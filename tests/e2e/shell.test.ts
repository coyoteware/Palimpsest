/**
 * The desktop shell (src-tauri): command-line open, native dialogs, saving in
 * place, what the page may do, links, closing with unsaved changes, printing.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PNG_RED } from "../fixtures/pdf";
import { answer, closed, launch, opened, poll, readPdf, sampleIn, shellLog, useApp, workDir } from "./harness";
import { Key, type Session } from "./webdriver";

useApp();

/** Same as pressing the window's close button. */
const requestClose = (app: Session) => app.exec("window.__TAURI_INTERNALS__.invoke('request_close')");

test("opens a PDF from the command line and saves it in place", async () => {
  const dir = workDir();
  const path = await sampleIn(dir, "doc.pdf");
  const app = await launch(path);
  await opened(app);
  expect(await app.title()).toMatch(/doc\.pdf — Palimpsest/);

  await app.click('.thumb[data-index="1"]');
  await app.click("#pgDelete");
  await poll(() => app.text("#pageCount")).toBe("/ 4");
  await app.press(Key.Control, "s");
  await poll(() => app.text(".toast")).toContain("Saved doc.pdf");

  const doc = await readPdf(path);
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 3", "Page 4", "Page 5"]);
  expect(readdirSync(dir)).toEqual(["doc.pdf"]); // no temp files left behind
});

test("open, image and save-as go through native dialogs", async () => {
  const dir = workDir();
  const source = await sampleIn(dir, "source.pdf");
  const png = join(dir, "stamp.png");
  writeFileSync(png, Buffer.from(PNG_RED, "base64"));
  answer({ pdf: [source], image: png, save: join(dir, "copy") });
  const app = await launch();

  await app.click("#btnOpenEmpty");
  await opened(app);
  await app.click('.toolbar .tool[data-tool="image"]');
  await poll(() => app.count(".stampEditor")).toBe(1);
  await app.click('.toolbar .tool[data-tool="none"]');

  await app.press(Key.Control, Key.Shift, "s");
  await poll(() => app.text("#docTitle")).toContain("copy.pdf"); // extension added
  const saved = await readPdf(join(dir, "copy.pdf"));
  expect(saved.pages[0].annotations.map((a) => a.subtype)).toContain("Stamp");
  // The original is untouched.
  const original = await readPdf(source);
  expect(original.pages[0].annotations.some((a) => a.subtype === "Stamp")).toBe(false);
  expect(shellLog().flatMap((e) => e.dialog ?? [])).toEqual(["pdf", "image", "save"]);
});

test("the page gets no Tauri APIs and can only touch files the user chose", async () => {
  const notChosen = await sampleIn(workDir(), "not-chosen.pdf");
  const target = join(workDir(), "new.pdf");
  const app = await launch();

  const probe = await app.exec(`return {
    require: typeof window.require,
    process: typeof window.process,
    tauri: typeof window.__TAURI__,
    bridge: Object.keys(window.palimpsestDesktop).sort(),
  }`);
  expect(probe).toEqual({
    require: "undefined",
    process: "undefined",
    tauri: "undefined",
    // Release builds have `print` on macOS only; test builds route printing through the shell everywhere.
    bridge: ["initialFile", "onCloseRequested", "openImage", "openPdfs", "platform", "print", "saveAs", "saveToFolder", "write"],
  });

  /** Runs an async function in the page and reports "ok" or its error. */
  const attempt = (fn: string, ...args: unknown[]) =>
    app.execAsync<string>(
      `const done = arguments[arguments.length - 1];
       (${fn})(...Array.prototype.slice.call(arguments, 0, -1)).then(() => done("ok"), (e) => done(String(e?.message ?? e)));`,
      ...args,
    );
  expect(await attempt("(p) => window.palimpsestDesktop.write(p, new Uint8Array([37, 80, 68, 70]))", target)).toMatch(
    /not authorised/,
  );
  expect(existsSync(target)).toBe(false);
  expect(await attempt("(p) => window.__TAURI_INTERNALS__.invoke('read_file', { path: p })", notChosen)).toMatch(
    /not authorised/,
  );
  // Plugin commands are not granted to the page (capabilities/default.json).
  expect(await attempt("() => window.__TAURI_INTERNALS__.invoke('plugin:dialog|open', { options: {} })")).toMatch(
    /not allowed/,
  );
  expect(
    await attempt("() => window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url', { url: 'https://example.org/' })"),
  ).toMatch(/not allowed/);
  expect(shellLog()).toEqual([]);

  // Picking a folder allows writing the named PDFs there, and nothing else.
  const folder = workDir();
  answer({ folder });
  const save = (names: string[]) =>
    app.execAsync<string>(
      `const done = arguments[arguments.length - 1];
       window.palimpsestDesktop.saveToFolder(arguments[0]).then((r) => done(JSON.stringify(r)), (e) => done(String(e?.message ?? e)));`,
      names,
    );
  for (const bad of [["../escape.pdf"], ["sub/part.pdf"], ["sub\\part.pdf"], ["C:part.pdf"], ["notes.txt"], [".."], []]) {
    expect(await save(bad)).toMatch(/Not a PDF file name|No files/);
  }
  const granted = JSON.parse(await save(["part 1.pdf"])) as { files: { name: string; path: string; exists: boolean }[] };
  expect(granted.files).toEqual([{ name: "part 1.pdf", path: join(folder, "part 1.pdf"), exists: false }]);
  expect(await attempt("(p) => window.palimpsestDesktop.write(p, new Uint8Array([37, 80, 68, 70]))", granted.files[0].path)).toBe("ok");
  expect(await attempt("(p) => window.palimpsestDesktop.write(p, new Uint8Array([37, 80, 68, 70]))", join(folder, "other.pdf"))).toMatch(
    /not authorised/,
  );
  expect(readdirSync(folder)).toEqual(["part 1.pdf"]);
  // Invalid names are refused before a folder is asked for.
  expect(shellLog().flatMap((e) => e.dialog ?? [])).toEqual(["folder"]);
});

test("links open in the default browser, never inside the app", async () => {
  const app = await launch();
  // pdf.js renders links in PDFs with target=_blank; clicking one is a user gesture.
  await app.exec(`[["web", "https://example.org/"], ["file", "file:///etc/hosts"]].forEach(([id, href], i) => {
    const a = Object.assign(document.createElement("a"), { id, href, target: "_blank", textContent: id });
    a.style.cssText = "position: fixed; left: 300px; z-index: 9999; top: " + (200 + 40 * i) + "px";
    document.body.append(a);
  })`);
  await app.click("#web");
  await app.click("#file"); // neither opened nor shown
  await app.exec(`location.href = "mailto:someone@example.org"`);
  await poll(() => shellLog().flatMap((e) => e.open ?? []).sort()).toEqual([
    "https://example.org/",
    "mailto:someone@example.org",
  ]);
  expect(await app.windows()).toHaveLength(1);
  expect(await app.exec("return location.href")).toMatch(/^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)(\/|$)/);
});

test("asks before discarding unsaved changes on close", async () => {
  const app = await launch(await sampleIn(workDir()));
  await opened(app);
  await app.click('.thumb[data-index="1"]');
  await app.click("#pgDelete");
  await poll(() => app.text("#pageCount")).toBe("/ 4");

  const dialogOpen = () => app.exec<boolean>("return document.querySelector('#confirmDialog').open");
  await requestClose(app);
  await poll(dialogOpen).toBe(true);
  // Focus starts on Cancel, so Enter keeps the changes.
  expect(await app.exec("return document.activeElement?.value")).toBe("cancel");
  // Pressing close again while the user decides does not force the window shut.
  await requestClose(app);
  await app.click('#confirmDialog button[value="cancel"]');
  await poll(dialogOpen).toBe(false);
  expect(await app.text("#pageCount")).toBe("/ 4");
  expect(shellLog().some((e) => e.closed)).toBe(false);

  await requestClose(app);
  await poll(dialogOpen).toBe(true);
  // Discard. Clicked from the page so the app can quit without cutting off the driver's reply.
  await app.exec("setTimeout(() => document.querySelector('#confirmOk').click(), 50)");
  await poll(() => shellLog().some((e) => e.closed)).toBe(true);
  await closed();
});

test("closes without asking when there are no unsaved changes", async () => {
  const app = await launch(await sampleIn(workDir()));
  await opened(app);
  await requestClose(app);
  await poll(() => shellLog().some((e) => e.closed)).toBe(true);
  await closed();
});

test("a print the shell hands to the native dialog keeps its pages until printing ends", async () => {
  const app = await launch(await sampleIn(workDir()));
  await opened(app);

  await app.click("#btnPrint");
  await poll(() => shellLog().filter((e) => e.print).length).toBe(1);
  expect(await app.count("#printContainer .print-page")).toBe(5); // the dialog is still reading them
  // Printing again replaces them rather than adding to them.
  await app.click("#btnPrint");
  await poll(() => shellLog().filter((e) => e.print).length).toBe(2);
  expect(await app.count("#printContainer .print-page")).toBe(5);

  await app.exec("window.dispatchEvent(new Event('afterprint'))");
  expect(await app.count("#printContainer .print-page")).toBe(0);
});
