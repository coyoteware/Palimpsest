// Injected into the page before its own scripts (see main.rs). Exposes
// window.palimpsestDesktop with the same shape as desktop/preload.cjs, built on
// the shell's commands. The shell fills in the two placeholders below.
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
  Object.defineProperty(window, "palimpsestDesktop", { value: Object.freeze(bridge) });

  // Called by the shell when the window's close button is pressed. The page
  // cancels beforeunload while it has unsaved changes; a synthetic event asks it.
  Object.defineProperty(window, "__palimpsestCloseRequested", {
    value() {
      const probe = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(probe);
      return invoke("close_window", { dirty: probe.defaultPrevented });
    },
  });

  // Like the Electron shell: no browser context menu (Back, Reload, Inspect…).
  window.addEventListener("contextmenu", (e) => e.preventDefault());
})();
