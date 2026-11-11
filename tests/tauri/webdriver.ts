/**
 * A minimal W3C WebDriver client, enough to drive the Tauri shell through the
 * platform's own driver: WebKitWebDriver on Linux, msedgedriver (WebView2) on
 * Windows. It does what tauri-driver does (map the app binary into the
 * driver's capabilities) without a separate install.
 */
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export const Key = { Control: "", Shift: "", Escape: "" } as const;

type Json = Record<string, unknown>;

async function call<T>(base: string, method: string, path: string, body?: Json): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body && JSON.stringify(body),
  });
  const { value } = (await res.json()) as { value: T & { error?: string; message?: string } };
  if (!res.ok) throw new Error(`WebDriver ${method} ${path}: ${value?.error} ${value?.message ?? ""}`.trim());
  return value;
}

/** Capabilities that make the driver launch `binary` with `args`. */
function capabilities(binary: string, args: string[]): Json {
  if (process.platform === "win32") {
    return {
      browserName: "webview2",
      "ms:edgeChromium": true,
      "ms:edgeOptions": { binary, args, webviewOptions: {} },
    };
  }
  return { "webkitgtk:browserOptions": { binary, args } };
}

export class Session {
  readonly #base: string;

  private constructor(driver: string, id: string) {
    this.#base = `${driver}/session/${id}`;
  }

  static async start(driver: string, binary: string, args: string[] = []) {
    const { sessionId } = await call<{ sessionId: string }>(driver, "POST", "/session", {
      capabilities: { alwaysMatch: capabilities(binary, args) },
    });
    return new Session(driver, sessionId);
  }

  #cmd<T>(method: string, path: string, body?: Json) {
    return call<T>(this.#base, method, path, body);
  }

  /** Run `script` (a function body; use `return`) in the page. */
  exec<T = unknown>(script: string, ...args: unknown[]): Promise<T> {
    return this.#cmd<T>("POST", "/execute/sync", { script, args });
  }

  /** Run `script` with a `done` callback as its last argument. */
  execAsync<T = unknown>(script: string, ...args: unknown[]): Promise<T> {
    return this.#cmd<T>("POST", "/execute/async", { script, args });
  }

  title() {
    return this.#cmd<string>("GET", "/title");
  }

  windows() {
    return this.#cmd<string[]>("GET", "/window/handles");
  }

  async #find(css: string) {
    const ref = await this.#cmd<Record<string, string>>("POST", "/element", { using: "css selector", value: css });
    return ref[ELEMENT];
  }

  async click(css: string) {
    await this.#cmd("POST", `/element/${await this.#find(css)}/click`, {});
  }

  async type(css: string, text: string) {
    await this.#cmd("POST", `/element/${await this.#find(css)}/value`, { text });
  }

  /** Press keys together, e.g. `press(Key.Control, "s")`. */
  async press(...keys: string[]) {
    const down = keys.map((value) => ({ type: "keyDown", value }));
    const up = keys.toReversed().map((value) => ({ type: "keyUp", value }));
    await this.#cmd("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions: [...down, ...up] }] });
    await this.#cmd("DELETE", "/actions");
  }

  /** Text content of the first element matching `css`, or null. */
  text(css: string) {
    return this.exec<string | null>("return document.querySelector(arguments[0])?.textContent ?? null", css);
  }

  count(css: string) {
    return this.exec<number>("return document.querySelectorAll(arguments[0]).length", css);
  }

  /** End the session; the driver quits the app. */
  async end() {
    await this.#cmd("DELETE", "").catch(() => {});
  }
}
