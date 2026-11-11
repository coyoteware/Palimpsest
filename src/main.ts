import { App, toast } from "./app";
// After app.ts so these rules follow pdf_viewer.css in the cascade.
import "./styles.css";
import { desktop, inDesktopShell } from "./desktop";
import { fromDesktop } from "./files";
import { hydrateIcons } from "./icons";

if (!inDesktopShell) {
  // File access goes through the shell, so the page alone cannot do anything useful.
  document.getElementById("app")!.replaceWith("Palimpsest runs in its desktop app. Start it with `npm run app`.");
} else {
  hydrateIcons();
  const app = new App();
  // Handy for debugging and used by the end-to-end tests.
  (window as unknown as { palimpsest: App }).palimpsest = app;

  // Ask before closing a window with unsaved changes.
  desktop.onCloseRequested(() => app.confirmDiscard());

  // A file passed on the command line or via "Open with".
  desktop
    .initialFile()
    .then((f) => f && app.openFile(fromDesktop(f)))
    .catch((e) => toast(`Could not open the file: ${e.message}`, "error"));
}
