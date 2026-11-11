#!/usr/bin/env node
/**
 * Serve the built app on localhost and open it in a Chromium "app" window
 * (no tabs or address bar). Usage:
 *
 *   npm run app                 # empty window
 *   npm run app -- file.pdf     # open a file on start
 *
 * Env: PALIMPSEST_PORT (default 4317), CHROME_PATH (browser binary).
 * Installing the PWA from the browser (address bar → Install) gives the same
 * window plus OS file associations, without this script.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, createReadStream } from "node:fs";
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const basePort = Number(process.env.PALIMPSEST_PORT ?? 4317);
const pdfPath = process.argv[2] ? resolve(process.argv[2]) : null;
if (pdfPath && !existsSync(pdfPath)) {
  console.error(`No such file: ${pdfPath}`);
  process.exit(1);
}

if (!existsSync(join(dist, "index.html"))) {
  console.log("Building Palimpsest…");
  const r = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: platform() === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".map": "application/json",
};

// The file passed on the command line is served under an unguessable path.
const openRoute = pdfPath ? `/__open/${randomBytes(12).toString("hex")}/${encodeURIComponent(basename(pdfPath))}` : null;

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file;
  if (openRoute && path === decodeURIComponent(openRoute)) file = pdfPath;
  else {
    file = resolve(dist, `.${path.endsWith("/") ? `${path}index.html` : path}`);
    if (file !== dist && !file.startsWith(dist + sep)) return void res.writeHead(403).end();
  }
  if (!existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end("Not found");
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": /[/\\]assets[/\\]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
});

function listen(port, attempts = 10) {
  return new Promise((ok, fail) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE" && attempts > 1) ok(listen(port + 1, attempts - 1));
      else fail(e);
    });
    server.listen(port, "127.0.0.1", () => ok(port));
  });
}

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const os = platform();
  if (os === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ].find(existsSync);
  }
  if (os === "win32") {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean);
    const rel = ["Google/Chrome/Application/chrome.exe", "Chromium/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe", "BraveSoftware/Brave-Browser/Application/brave.exe"];
    return roots.flatMap((r) => rel.map((p) => join(r, p))).find(existsSync);
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

function profileDir() {
  const os = platform();
  if (os === "darwin") return join(homedir(), "Library", "Application Support", "Palimpsest", "Chromium");
  if (os === "win32") return join(process.env.APPDATA ?? homedir(), "Palimpsest", "Chromium");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "palimpsest", "chromium");
}

const port = await listen(basePort);
const url = `http://127.0.0.1:${port}/${openRoute ? `?file=${encodeURIComponent(openRoute)}` : ""}`;
const browser = findBrowser();
if (!browser) {
  console.log(`No Chromium-based browser found (set CHROME_PATH). Open ${url} yourself; Ctrl+C to stop.`);
} else {
  console.log(`Palimpsest running at http://127.0.0.1:${port}/`);
  const child = spawn(
    browser,
    [`--app=${url}`, `--user-data-dir=${profileDir()}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,900"],
    { stdio: "ignore" },
  );
  child.on("exit", () => {
    server.close();
    process.exit(0);
  });
  child.on("error", (e) => {
    console.error(`Could not start ${browser}: ${e.message}. Open ${url} yourself.`);
  });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
