/**
 * A minimal W3C WebDriver client, enough to drive the app through the
 * platform's own driver: WebKitWebDriver on Linux, msedgedriver (WebView2) on
 * Windows. It does what tauri-driver does (map the app binary into the
 * driver's capabilities) without a separate install.
 */
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export const Key = { Control: "", Shift: "", Escape: "", Enter: "" } as const;

type Json = Record<string, unknown>;
type Point = readonly [number, number];

/** No WebDriver command should take this long; without a limit a stuck driver hangs the run silently. */
const COMMAND_TIMEOUT = 60_000;

async function call<T>(base: string, method: string, path: string, body?: Json, timeout = COMMAND_TIMEOUT): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }).catch((e: unknown) => {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`WebDriver ${method} ${path}: no answer within ${timeout / 1000} s`);
    }
    throw e;
  });
  const { value } = (await res.json()) as { value: T & { error?: string; message?: string } };
  if (!res.ok) throw new Error(`WebDriver ${method} ${path}: ${value?.error} ${value?.message ?? ""}`.trim());
  return value;
}

/** Capabilities that make the driver launch `binary` with `args` (the same mapping as tauri-driver). */
function capabilities(binary: string, args: string[]): Json {
  if (process.platform === "win32") {
    return { browserName: "webview2", "ms:edgeChromium": true, "ms:edgeOptions": { binary, args } };
  }
  return { "webkitgtk:browserOptions": { binary, args } };
}

const keyStrokes = (keys: string[]) => [
  ...keys.map((value) => ({ type: "keyDown", value })),
  ...keys.toReversed().map((value) => ({ type: "keyUp", value })),
];
const pause = { type: "pause", duration: 0 };

export class Session {
  readonly #base: string;

  private constructor(driver: string, id: string) {
    this.#base = `${driver}/session/${id}`;
  }

  static async start(driver: string, binary: string, args: string[] = []) {
    const body = { capabilities: { alwaysMatch: capabilities(binary, args) } };
    try {
      const { sessionId } = await call<{ sessionId: string }>(driver, "POST", "/session", body, 45_000);
      return new Session(driver, sessionId);
    } catch (e) {
      if (!/no answer within/.test((e as Error).message)) throw e;
      throw new Error(
        "The WebDriver did not connect to the app within 45 s." +
          (process.platform === "win32" ? " msedgedriver hangs like this when its version differs from the WebView2 runtime's." : ""),
      );
    }
  }

  #cmd<T>(method: string, path: string, body?: Json, timeout?: number) {
    return call<T>(this.#base, method, path, body, timeout);
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

  /** Type into an element, as the user would. */
  async type(css: string, text: string) {
    await this.#cmd("POST", `/element/${await this.#find(css)}/value`, { text });
  }

  /** Set an input's or select's value at once and fire input and change, like a paste or a pick. */
  async fill(css: string, value: string) {
    await this.exec(
      `const el = document.querySelector(arguments[0]);
       el.focus();
       Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, arguments[1]);
       el.dispatchEvent(new Event("input", { bubbles: true }));
       el.dispatchEvent(new Event("change", { bubbles: true }));`,
      css,
      value,
    );
  }

  async #perform(actions: Json[]) {
    await this.#cmd("POST", "/actions", { actions });
    await this.#cmd("DELETE", "/actions");
  }

  /** Press keys together, e.g. `press(Key.Control, "s")`. */
  async press(...keys: string[]) {
    await this.#perform([{ type: "key", id: "keyboard", actions: keyStrokes(keys) }]);
  }

  /** Type text into whatever has focus. */
  async keys(text: string) {
    await this.#perform([{ type: "key", id: "keyboard", actions: [...text].flatMap((c) => keyStrokes([c])) }]);
  }

  /** Mouse down at the first point (viewport coordinates), through the others, up at the last. */
  async drag(points: Point[], stepMs = 20) {
    const [[x, y], ...rest] = points.map(([px, py]) => [Math.round(px), Math.round(py)]);
    await this.#perform([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x, y, origin: "viewport" },
          { type: "pointerDown", button: 0 },
          ...rest.map(([mx, my]) => ({ type: "pointerMove", x: mx, y: my, origin: "viewport", duration: stepMs })),
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
  }

  /** Click at a point (viewport coordinates), optionally holding a modifier key. */
  async clickAt([x, y]: Point, modifier?: string) {
    const pointer = [
      { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ];
    const sources: Json[] = [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [pause, ...pointer, pause] }];
    if (modifier) {
      sources.push({
        type: "key",
        id: "keyboard",
        actions: [{ type: "keyDown", value: modifier }, ...pointer.map(() => pause), { type: "keyUp", value: modifier }],
      });
    }
    await this.#perform(sources);
  }

  /** Centre of the first element matching `css`, scrolled into view. */
  center(css: string) {
    return this.exec<Point>(
      `const el = document.querySelector(arguments[0]);
       el.scrollIntoView({ block: "center" });
       const r = el.getBoundingClientRect();
       return [r.left + r.width / 2, r.top + r.height / 2];`,
      css,
    );
  }

  /** Text content of the first element matching `css`, or null. */
  text(css: string) {
    return this.exec<string | null>("return document.querySelector(arguments[0])?.textContent ?? null", css);
  }

  value(css: string) {
    return this.exec<string | null>("return document.querySelector(arguments[0])?.value ?? null", css);
  }

  attr(css: string, name: string) {
    return this.exec<string | null>("return document.querySelector(arguments[0])?.getAttribute(arguments[1]) ?? null", css, name);
  }

  count(css: string) {
    return this.exec<number>("return document.querySelectorAll(arguments[0]).length", css);
  }

  visible(css: string) {
    return this.exec<boolean>("return !!document.querySelector(arguments[0])?.checkVisibility()", css);
  }

  /** End the session; the driver quits the app. Best effort: the app may already be gone. */
  async end() {
    await this.#cmd("DELETE", "", undefined, 15_000).catch(() => {});
  }
}
