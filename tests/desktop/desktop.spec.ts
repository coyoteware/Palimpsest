import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG_RED, inspect, sampleFile } from "../e2e/helpers";

const ROOT = resolve(import.meta.dirname, "../..");
const EXE = process.env.PALIMPSEST_EXE;

test.beforeAll(() => {
  if (!EXE && !existsSync(join(ROOT, "dist", "index.html"))) throw new Error("Run `npm run build` first.");
});

let app: ElectronApplication;
let page: Page;
let errors: string[];

async function launch(...files: string[]) {
  app = await electron.launch({
    executablePath: EXE,
    args: [...(EXE ? [] : ["."]), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...files],
    cwd: ROOT,
  });
  page = await app.firstWindow();
  errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForLoadState("domcontentloaded");
}

test.afterEach(async () => {
  expect(errors, "errors in the renderer").toEqual([]);
  await app?.close().catch(() => {});
});

/** First launch on a cold CI machine (software GL, no code cache) can take several seconds. */
const STARTUP = { timeout: 30_000 };

const workDir = () => mkdtempSync(join(tmpdir(), "palimpsest-desktop-"));
async function samplePdfIn(dir: string, name = "doc.pdf") {
  const path = join(dir, name);
  copyFileSync(await sampleFile(), path);
  return path;
}

test("opens a PDF from the command line and saves it in place", async () => {
  const dir = workDir();
  const path = await samplePdfIn(dir);
  await launch(path);
  await expect(page.locator("#pageCount")).toHaveText("/ 5", STARTUP);
  await expect(page).toHaveTitle(/doc\.pdf — Palimpsest/);

  await page.locator('.thumb[data-index="1"]').click();
  await page.locator("#pgDelete").click();
  await expect(page.locator("#pageCount")).toHaveText("/ 4");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".toast")).toContainText("Saved doc.pdf");

  const doc = await inspect(new Uint8Array(readFileSync(path)));
  expect(doc.pages.map((p) => p.heading)).toEqual(["Page 1", "Page 3", "Page 4", "Page 5"]);
  expect(readdirSync(dir)).toEqual(["doc.pdf"]); // no temp files left behind
});

test("open, image and save-as go through native dialogs", async () => {
  const dir = workDir();
  const source = await samplePdfIn(dir, "source.pdf");
  const png = join(dir, "stamp.png");
  writeFileSync(png, Buffer.from(PNG_RED, "base64"));
  await launch();
  await app.evaluate(({ dialog }, { source, png, out }) => {
    dialog.showOpenDialog = (async (_w: unknown, opts: { filters?: { extensions: string[] }[] }) => ({
      canceled: false,
      filePaths: [opts.filters?.[0].extensions.includes("pdf") ? source : png],
    })) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: out })) as typeof dialog.showSaveDialog;
  }, { source, png, out: join(dir, "copy") });

  await page.locator("#btnOpenEmpty").click();
  await expect(page.locator("#pageCount")).toHaveText("/ 5", STARTUP);
  await page.locator('.toolbar .tool[data-tool="image"]').click();
  await expect(page.locator(".stampEditor")).toHaveCount(1);
  await page.locator('.toolbar .tool[data-tool="none"]').click();

  await page.keyboard.press("Control+Shift+s");
  await expect(page.locator("#docTitle")).toContainText("copy.pdf"); // extension added
  const saved = await inspect(new Uint8Array(readFileSync(join(dir, "copy.pdf"))));
  expect(saved.pages[0].annotations.map((a) => a.subtype)).toContain("Stamp");
  // The original is untouched.
  expect((await inspect(new Uint8Array(readFileSync(source)))).pages[0].annotations.some((a) => a.subtype === "Stamp")).toBe(false);
});

test("the page is sandboxed and can only write where the user chose", async () => {
  await launch();
  const probe = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: Object.keys((window as unknown as { palimpsestDesktop: object }).palimpsestDesktop).sort(),
  }));
  expect(probe).toEqual({
    require: "undefined",
    process: "undefined",
    bridge: ["initialFile", "openImage", "openPdfs", "platform", "saveAs", "write"],
  });
  const target = join(workDir(), "not-chosen.pdf");
  const result = await page.evaluate(
    (p) =>
      (window as unknown as { palimpsestDesktop: { write(p: string, b: Uint8Array): Promise<void> } }).palimpsestDesktop
        .write(p, new Uint8Array([37, 80, 68, 70]))
        .then(() => "written", (e: Error) => e.message),
    target,
  );
  expect(result).toMatch(/not authorised/);
  expect(existsSync(target)).toBe(false);
});

test("links open in the default browser, never inside the app", async () => {
  await launch();
  await app.evaluate(({ shell }) => {
    (globalThis as unknown as { opened: string[] }).opened = [];
    shell.openExternal = (async (url: string) => void (globalThis as unknown as { opened: string[] }).opened.push(url)) as typeof shell.openExternal;
  });
  const popup = await page.evaluate(() => window.open("https://example.org/") === null);
  expect(popup).toBe(true);
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual(["https://example.org/"]);
  expect(app.windows()).toHaveLength(1);
});

test("asks before discarding unsaved changes on close", async () => {
  await launch();
  // Playwright answers beforeunload dialogs itself, so drive the main-process
  // handler with a synthetic event; the page side (cancelling unload while
  // dirty) is covered by the web tests.
  const run = (choice: number) =>
    app.evaluate(({ BrowserWindow, dialog }, choice) => {
      let asked = 0;
      let allowed = false;
      dialog.showMessageBoxSync = (() => (asked++, choice)) as typeof dialog.showMessageBoxSync;
      BrowserWindow.getAllWindows()[0].webContents.emit("will-prevent-unload", { preventDefault: () => (allowed = true) });
      return { asked, allowed };
    }, choice);
  expect(await run(1)).toEqual({ asked: 1, allowed: false }); // Cancel keeps the window
  expect(await run(0)).toEqual({ asked: 1, allowed: true }); // Discard lets it close
});
