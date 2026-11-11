import { App, toast } from "./app";
// After app.ts so these rules follow pdf_viewer.css in the cascade.
import "./styles.css";
import { fromHandle, looksLikePdf } from "./files";
import { hydrateIcons } from "./icons";

hydrateIcons();
const app = new App();
// Handy for debugging and used by the end-to-end tests.
(window as unknown as { palimpsest: App }).palimpsest = app;

interface LaunchParams {
  files: FileSystemHandle[];
}
const launchQueue = (window as unknown as { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } })
  .launchQueue;

// Files opened from the OS ("Open with Palimpsest") once installed as an app.
launchQueue?.setConsumer(async ({ files }) => {
  const handle = files.find((f): f is FileSystemFileHandle => f.kind === "file");
  if (!handle) return;
  if (!(await app.confirmDiscard())) return;
  const file = await fromHandle(handle);
  if (!looksLikePdf(await handle.getFile())) return toast(`${file.name} is not a PDF.`, "error");
  await app.openFile(file);
});

// ?file=<same-origin URL> opens a PDF on start (used by `npm run app -- some.pdf`).
const fileParam = new URLSearchParams(location.search).get("file");
if (fileParam) {
  const url = new URL(fileParam, location.href);
  if (url.origin === location.origin) {
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const name = decodeURIComponent(url.pathname.split("/").pop() || "document.pdf");
        await app.openFile({ name, bytes: new Uint8Array(await res.arrayBuffer()), handle: null });
      })
      .catch((e) => toast(`Could not load ${fileParam}: ${e.message}`, "error"));
  }
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service worker not registered", e));
}
