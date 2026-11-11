// Injected into the page before its own scripts (see main.rs). Exposes
// window.palimpsestDesktop (typed in src/desktop.ts), built on the shell's
// commands. The shell fills in the two placeholders below.
(() => {
  const PLATFORM = "__PLATFORM__";
  const NATIVE_PRINT = __NATIVE_PRINT__;

  const invoke = (cmd, args, options) => window.__TAURI_INTERNALS__.invoke(cmd, args, options);
  const baseName = (path) => path.split(/[\\/]/).pop();
  const readBytes = async (path) => new Uint8Array(await invoke("read_file", { path }));
  const readPdf = async (path) => ({ name: baseName(path), path, bytes: await readBytes(path) });
  const IMAGE_TYPES = { svg: "image/svg+xml", jpg: "image/jpeg" };

  const bridge = {
    platform: PLATFORM,
    async initialFile() {
      const path = await invoke("initial_file");
      return path ? readPdf(path) : null;
    },
    async openPdfs(multiple) {
      return Promise.all((await invoke("pick_pdfs", { multiple: !!multiple })).map(readPdf));
    },
    async openImage() {
      const path = await invoke("pick_image");
      if (!path) return null;
      const ext = path.split(".").pop().toLowerCase();
      return { name: baseName(path), type: IMAGE_TYPES[ext] ?? `image/${ext}`, bytes: await readBytes(path) };
    },
    async saveAs(suggestedName) {
      const path = await invoke("save_as", { suggestedName: String(suggestedName) });
      return path ? { name: baseName(path), path } : null;
    },
    // The bytes travel as the raw request body; the path goes in a header.
    write: (path, bytes) => invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(String(path)) } }),
  };
  // WKWebView has no window.print(); the shell opens the native print sheet,
  // which returns before printing ends (see src/print.ts).
  if (NATIVE_PRINT) bridge.print = () => invoke("print_page");

  // The app's answer to "may this window close?" (src/main.ts registers it).
  let closeGuard = null;
  bridge.onCloseRequested = (guard) => {
    closeGuard = guard;
  };
  Object.defineProperty(window, "palimpsestDesktop", { value: Object.freeze(bridge) });

  // Called by the shell when the window's close button is pressed. "asking"
  // tells it the page is handling the request (so a second click waits for
  // the answer); then "close" or "stay".
  Object.defineProperty(window, "__palimpsestCloseRequested", {
    async value() {
      if (!closeGuard) return invoke("close_window", { decision: "close" });
      await invoke("close_window", { decision: "asking" });
      let close = false;
      try {
        close = await closeGuard();
      } finally {
        await invoke("close_window", { decision: close ? "close" : "stay" });
      }
    },
  });

  // No browser context menu (Back, Reload, Inspect…): this is an app, not a page.
  window.addEventListener("contextmenu", (e) => e.preventDefault());
})();
