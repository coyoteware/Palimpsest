/**
 * Electron shell for the desktop / portable builds.
 *
 * The web app in dist/ is served from a private app:// origin. File access
 * goes through native dialogs in this process: the renderer may only write to
 * paths the user picked in a dialog or passed on the command line.
 */
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "..", "dist");
const ORIGIN = "app://palimpsest";
const ICON = join(DIST, "icons", "icon-512.png");

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /** Paths each window may write to, keyed by webContents id. */
  const writable = new Map();
  /** File to open when a window's page asks for it. */
  const pending = new Map();
  let lastDir = app.getPath("documents");

  const allow = (sender, path) => {
    let set = writable.get(sender.id);
    if (!set) writable.set(sender.id, (set = new Set()));
    set.add(resolve(path));
  };

  const pdfArgs = (argv) =>
    argv
      .filter((a) => !a.startsWith("-") && /\.pdf$/i.test(a))
      .map((a) => resolve(a))
      .filter((p) => existsSync(p) && statSync(p).isFile());

  async function readPdf(path) {
    const bytes = await readFile(path);
    lastDir = dirname(path);
    return { name: basename(path), path, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }

  function createWindow(filePath = null) {
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      show: false,
      icon: ICON,
      title: "Palimpsest",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1d21" : "#f4f5f7",
      webPreferences: {
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    const id = win.webContents.id;
    if (filePath) pending.set(id, filePath);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      writable.delete(id);
      pending.delete(id);
    });

    // Links in PDFs open in the default browser; nothing navigates the app away.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
    });
    // The page cancels unload while there are unsaved changes; ask the user.
    win.webContents.on("will-prevent-unload", (e) => {
      const choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        buttons: ["Discard changes", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: "Discard unsaved changes?",
        detail: "Your changes to this document have not been saved.",
      });
      if (choice === 0) e.preventDefault();
    });

    void win.loadURL(`${ORIGIN}/index.html`);
    return win;
  }

  const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender) ?? undefined;

  ipcMain.handle("desktop:initial-file", async (e) => {
    const path = pending.get(e.sender.id);
    pending.delete(e.sender.id);
    if (!path) return null;
    allow(e.sender, path);
    return readPdf(path);
  });

  ipcMain.handle("desktop:open-pdfs", async (e, multiple) => {
    const r = await dialog.showOpenDialog(senderWindow(e), {
      defaultPath: lastDir,
      filters: [{ name: "PDF documents", extensions: ["pdf"] }],
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    });
    if (r.canceled) return [];
    r.filePaths.forEach((p) => allow(e.sender, p));
    return Promise.all(r.filePaths.map(readPdf));
  });

  ipcMain.handle("desktop:open-image", async (e) => {
    const r = await dialog.showOpenDialog(senderWindow(e), {
      defaultPath: lastDir,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const path = r.filePaths[0];
    const ext = extname(path).slice(1).toLowerCase();
    const type = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    const bytes = await readFile(path);
    return { name: basename(path), type, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  });

  ipcMain.handle("desktop:save-as", async (e, suggestedName) => {
    const r = await dialog.showSaveDialog(senderWindow(e), {
      defaultPath: join(lastDir, basename(String(suggestedName || "document.pdf"))),
      filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    });
    if (r.canceled || !r.filePath) return null;
    const path = /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
    allow(e.sender, path);
    lastDir = dirname(path);
    return { name: basename(path), path };
  });

  ipcMain.handle("desktop:write", async (e, path, bytes) => {
    const target = resolve(String(path));
    if (!writable.get(e.sender.id)?.has(target)) throw new Error("Saving to that location was not authorised.");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected file bytes.");
    // Write beside the target, then swap, so a failed save never truncates the original.
    const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  });

  app.on("second-instance", (_e, argv) => {
    const files = pdfArgs(argv.slice(1));
    if (files.length) files.forEach((f) => createWindow(f));
    else {
      const win = BrowserWindow.getAllWindows()[0];
      if (win?.isMinimized()) win.restore();
      win?.focus();
    }
  });

  app.on("window-all-closed", () => app.quit());

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    protocol.handle("app", async (request) => {
      const { host, pathname } = new URL(request.url);
      const file = resolve(DIST, `.${decodeURIComponent(pathname)}`);
      if (host !== "palimpsest" || !file.startsWith(DIST + sep)) return new Response("Not found", { status: 404 });
      const res = await net.fetch(pathToFileURL(file).toString());
      if (!res.ok) return res;
      const headers = new Headers(res.headers);
      if (file.endsWith(".html")) headers.set("Content-Security-Policy", CSP);
      return new Response(res.body, { status: res.status, headers });
    });
    const files = pdfArgs(process.argv.slice(app.isPackaged ? 1 : 2));
    if (files.length) files.forEach((f) => createWindow(f));
    else createWindow();
  });
}
