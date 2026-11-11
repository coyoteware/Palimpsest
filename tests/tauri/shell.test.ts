/**
 * The Tauri shell, driven over WebDriver: the same checks as the Electron
 * tests in tests/desktop, plus printing. Native dialogs are answered and the
 * shell's side effects observed through the test hooks in src-tauri/src/e2e.rs.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, inject, test } from "vitest";
import { PNG_RED, inspect, sampleFile } from "../fixtures/pdf";
import { Key, Session } from "./webdriver";

const hooks = inject("hooks");
let app: Session | null = null;

async function launch(...files: string[]) {
  app = await Session.start(inject("driver"), inject("binary"), files);
  return app;
}

/** Answers for the shell's next dialogs: file paths, and whether to discard unsaved changes. */
function answer(answers: { pdf?: string[]; image?: string; save?: string; discard?: boolean }) {
  writeFileSync(join(hooks, "answers.json"), JSON.stringify(answers));
}

type ShellEvent = { dialog?: string; answer?: unknown; open?: string; print?: string; closed?: string };

/** What the shell did: dialogs, links opened, print requests, windows closed. */
function shellLog(): ShellEvent[] {
  const path = join(hooks, "log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ShellEvent);
}

const poll = <T>(fn: () => T | Promise<T>, timeout = 10_000) => expect.poll(fn, { timeout, interval: 100 });
/** First launch on a cold machine (software GL, empty caches) can take a while. */
const STARTUP = 30_000;

const workDir = () => mkdtempSync(join(tmpdir(), "palimpsest-tauri-doc-"));
async function samplePdfIn(dir: string, name = "doc.pdf") {
  const path = join(dir, name);
  copyFileSync(await sampleFile(), path);
  return path;
}

/** Same as pressing the window's close button. */
const requestClose = (s: Session) => s.exec("window.__TAURI_INTERNALS__.invoke('request_close')");

/** For tests that close the app themselves: end the session without checking the page. */
async function closed() {
  await app?.end();
  app = null;
}

beforeEach(() => {
  answer({});
  writeFileSync(join(hooks, "log.jsonl"), "");
});

afterEach(async () => {
  if (!app) return;
  const errors = await app.exec<string[]>("return window.__e2eErrors");
  await app.end();
  app = null;
  expect(errors, "errors in the page").toEqual([]);
});

test("opens a PDF from the command line and saves it in place", async () => {
  const dir = workDir();
  const path = await samplePdfIn(dir);
  const app = await launch(path);
  await poll(() => app.text("#pageCount"), STARTUP).toBe("/ 5");
  expect(await app.title()).toMatch(/doc\.pdf — Palimpsest/);

  await app.click('.thumb[data-index="1"]');
  await app.click("#pgDelete");
  await poll(() => app.text("#pageCount")).toBe("/ 4");
  await app.press(Key.Control, "s");
  await poll(() => app.text(".toast")).toContain("Saved doc.pdf");

  const doc = await inspect(new Uint8Array(readFileSync(path)));
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 3", "Page 4", "Page 5"]);
  expect(readdirSync(dir)).toEqual(["doc.pdf"]); // no temp files left behind
});

test("open, image and save-as go through native dialogs", async () => {
  const dir = workDir();
  const source = await samplePdfIn(dir, "source.pdf");
  const png = join(dir, "stamp.png");
  writeFileSync(png, Buffer.from(PNG_RED, "base64"));
  answer({ pdf: [source], image: png, save: join(dir, "copy") });
  const app = await launch();

  await app.click("#btnOpenEmpty");
  await poll(() => app.text("#pageCount"), STARTUP).toBe("/ 5");
  await app.click('.toolbar .tool[data-tool="image"]');
  await poll(() => app.count(".stampEditor")).toBe(1);
  await app.click('.toolbar .tool[data-tool="none"]');

  await app.press(Key.Control, Key.Shift, "s");
  await poll(() => app.text("#docTitle")).toContain("copy.pdf"); // extension added
  const saved = await inspect(new Uint8Array(readFileSync(join(dir, "copy.pdf"))));
  expect(saved.pages[0].annotations.map((a) => a.subtype)).toContain("Stamp");
  // The original is untouched.
  const original = await inspect(new Uint8Array(readFileSync(source)));
  expect(original.pages[0].annotations.some((a) => a.subtype === "Stamp")).toBe(false);
  expect(shellLog().map((e) => e.dialog)).toEqual(["pdf", "image", "save"]);
});

test("the page gets no Tauri APIs and can only touch files the user chose", async () => {
  const notChosen = await samplePdfIn(workDir(), "not-chosen.pdf");
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
    bridge: ["initialFile", "openImage", "openPdfs", "platform", "print", "saveAs", "write"],
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
  const app = await launch(await samplePdfIn(workDir()));
  await poll(() => app.text("#pageCount"), STARTUP).toBe("/ 5");
  await app.click('.thumb[data-index="1"]');
  await app.click("#pgDelete");
  await poll(() => app.text("#pageCount")).toBe("/ 4");

  answer({ discard: false }); // Cancel keeps the window
  await requestClose(app);
  await poll(() => shellLog()).toContainEqual({ dialog: "discard", answer: false });
  expect(await app.text("#pageCount")).toBe("/ 4");
  expect(shellLog().some((e) => e.closed)).toBe(false);

  answer({ discard: true }); // Discard lets it close
  await requestClose(app);
  await poll(() => shellLog().some((e) => e.closed)).toBe(true);
  expect(shellLog().filter((e) => e.dialog)).toHaveLength(2);
  await closed();
});

test("closes without asking when there are no unsaved changes", async () => {
  const app = await launch(await samplePdfIn(workDir()));
  await poll(() => app.text("#pageCount"), STARTUP).toBe("/ 5");
  await requestClose(app);
  await poll(() => shellLog().some((e) => e.closed)).toBe(true);
  expect(shellLog().filter((e) => e.dialog)).toEqual([]);
  await closed();
});

test("a print the shell hands to the native dialog keeps its pages until printing ends", async () => {
  const app = await launch(await samplePdfIn(workDir()));
  await poll(() => app.text("#pageCount"), STARTUP).toBe("/ 5");

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
