/**
 * Starts the platform's WebDriver for the end-to-end tests. The driver launches the
 * app per session; the environment it passes on enables automation in the
 * webview and points the app's test hooks (src-tauri/src/e2e.rs) at a
 * scratch folder the tests share with it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { Session } from "./webdriver";

declare module "vitest" {
  export interface ProvidedContext {
    /** WebDriver base URL. */
    driver: string;
    /** App binary built with `--features e2e`. */
    binary: string;
    /** Folder for answers.json (scripted dialogs) and log.jsonl (what the app did). */
    hooks: string;
  }
}

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = Number(process.env.WEBDRIVER_PORT ?? 4444);

function driverCommand() {
  if (process.platform === "linux") return process.env.WEBKIT_WEBDRIVER ?? "WebKitWebDriver";
  if (process.platform === "win32") return process.env.MSEDGEDRIVER ?? "msedgedriver";
  throw new Error("There is no WebDriver for the macOS system webview (WKWebView); run these tests on Linux or Windows.");
}

async function waitUntilReady(url: string, failed: Promise<never>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = fetch(`${url}/status`, { signal: AbortSignal.timeout(2_000) })
      .then(async (r) => ((await r.json()) as { value: { ready: boolean } }).value.ready)
      .catch(() => false);
    if (await Promise.race([ready, failed])) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`WebDriver did not start on ${url}`);
}

export default async function setup(project: TestProject) {
  const exe = process.platform === "win32" ? "palimpsest.exe" : "palimpsest";
  const binary = resolve(process.env.PALIMPSEST_APP ?? join(ROOT, "src-tauri", "target", "debug", exe));
  if (!existsSync(binary)) throw new Error(`No app at ${binary}. \`npm run test:e2e\` builds it.`);

  const hooks = mkdtempSync(join(tmpdir(), "palimpsest-tauri-"));
  const command = driverCommand();
  const driver = spawn(command, [`--port=${PORT}`], {
    env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: "true", PALIMPSEST_E2E_DIR: hooks },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const failed = new Promise<never>((_, reject) => {
    driver.once("error", (e) =>
      reject(new Error(`Could not start ${command}: ${e.message}. On Debian/Ubuntu: apt install webkit2gtk-driver.`)),
    );
    driver.once("exit", (code) => reject(new Error(`${command} exited with code ${code}`)));
  });
  failed.catch(() => {}); // only awaited during startup
  const url = `http://127.0.0.1:${PORT}`;
  const step = (what: string) => console.log(`[e2e setup ${new Date().toISOString().slice(11, 19)}] ${what}`);
  step(`starting ${command}`);
  await waitUntilReady(url, failed);
  step("driver ready");

  // One trial session, so a driver that cannot reach the app fails the run
  // at once instead of every test timing out in turn. Not for a given build
  // (PALIMPSEST_APP): with single-instance on, a lingering trial app would
  // take over the next launch.
  if (!process.env.PALIMPSEST_APP) {
    try {
      step("trial session: launching the app");
      const trial = await Session.start(url, binary);
      step("trial session: connected, closing");
      await trial.end();
      step("trial session: done");
    } catch (e) {
      driver.kill();
      const hint =
        process.platform === "win32"
          ? " On Windows, run the tests without administrator rights: an elevated WebView2 ignores the debugging switch msedgedriver needs (scripts/windows-unelevated.ps1)."
          : "";
      throw new Error(`The WebDriver could not start the app: ${(e as Error).message}${hint}`);
    }
  }

  project.provide("driver", url);
  project.provide("binary", binary);
  project.provide("hooks", hooks);
  return () => {
    driver.kill();
    rmSync(hooks, { recursive: true, force: true });
  };
}
