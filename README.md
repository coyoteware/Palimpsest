# Palimpsest

An open source PDF viewer and editor that runs as an installable Chromium app. Everything happens on your device; files are never uploaded.

![Palimpsest editing a PDF: highlighted text, a drawn ellipse and a text note, with the page list on the left](docs/screenshot.png)

## Features

- **View**: fast rendering, text selection, search (match case / whole words), links, zoom presets and Ctrl+wheel zoom, page thumbnails.
- **Annotate**: add text, draw, highlight (select text, or draw freely), place images and signature scans. Annotations are saved as standard PDF annotations, so other viewers show them and Palimpsest can edit them again later.
- **Fill forms**: AcroForm fields render as editable inputs and their values are saved into the file.
- **Organise pages**: rotate, delete, duplicate, reorder by dragging, insert blank pages, insert pages from other PDFs (drop them on the page list), save a selection as a new PDF.
- **Document properties**: edit title, author, subject and keywords.
- **Undo/redo** across both annotation edits and page operations.
- **Save in place**: a file opened from disk (or from the OS "Open with" menu once installed) is written back to the same file. Save as and print are also included.
- **Works offline** once the app has been used, with light and dark themes.

## Download (Windows)

Get `Palimpsest-<version>-portable.exe` from [Releases](https://github.com/coyoteware/Palimpsest/releases). It is a single file that needs no installation and no admin rights: run it, or drag a PDF onto it, or use **Open with → Choose another app** on a PDF.

- The build isn't code-signed yet, so on first run Windows SmartScreen says "Windows protected your PC". Choose **More info → Run anyway**.
- Each launch unpacks the app to a temporary folder first, so startup takes a few seconds. Settings live in `%APPDATA%\Palimpsest`.

## Run from source

Requires Node.js 22.13 or later. The browser options below also need a Chromium-based browser (Chrome, Chromium, Edge, Brave).

```bash
npm install
```

**As a desktop app window:**

```bash
npm run app
```

```bash
npm run app -- path/to/file.pdf
```

This builds the app if needed, serves it on `127.0.0.1:4317`, and opens it in a Chromium `--app` window with its own profile. Set `CHROME_PATH` if your browser isn't found.

**Installed as a PWA** (the recommended way): run `npm run build && npm run preview`, open http://localhost:4173 in Chrome or Edge, and choose **Install** in the address bar. You get a standalone window, a launcher icon, and Palimpsest appears under "Open with" for PDF files. Any static host works for `dist/`. Installing needs HTTPS, except on localhost.

**As the desktop (Electron) app:**

```bash
npm run desktop
```

**As the lightweight desktop (Tauri) app** (in testing): the same app in the operating system's own webview (WebView2 on Windows, WebKit on macOS and Linux) instead of a bundled Chromium, so the build is a single file of about 6–8 MB. It needs a [Rust toolchain](https://rustup.rs/) and, on Linux, the WebKitGTK 4.1 development packages (Debian/Ubuntu: `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev`). Windows 11 has WebView2 built in; on Windows 10 it is usually present, or install the [Evergreen runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

```bash
npm run tauri dev
```

```bash
npm run dist:tauri
```

The first runs the app against the Vite dev server with hot reload. The second writes `src-tauri/target/release/palimpsest` (`palimpsest.exe` on Windows), which runs without installing. `npm run tauri build` makes installers instead.

**For development:**

```bash
npm run dev
```

## Building the portable .exe

```bash
npm run dist:win
```

This writes `release/Palimpsest-<version>-portable.exe`. Run it on Windows. On Linux or macOS the same command needs Wine to stamp the icon and version info into the exe. Without Wine, add `-- -c.win.signAndEditExecutable=false` to get a working exe with Electron's default icon.

To publish a release, set `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The [Release workflow](.github/workflows/release.yml) builds the exe on a Windows runner, runs the desktop tests against it, and attaches it to a GitHub release. Running the workflow by hand (Actions → Release → Run workflow) builds and tests the exe without publishing; the exe is attached to the run as an artifact.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Open / Save / Save as / Print | Ctrl+O / Ctrl+S / Ctrl+Shift+S / Ctrl+P |
| Find | Ctrl+F, then Enter / Shift+Enter |
| Zoom in / out / reset | Ctrl+= / Ctrl+− / Ctrl+0 (or Ctrl+wheel) |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y |
| Tools: select, text, draw, highlight, image | V, T, D, H, I (Esc returns to select) |
| Page list: move, extend selection, select all | Arrows, Shift+Arrows, Ctrl+A |
| Page list: delete / duplicate selected | Delete / Ctrl+D |
| Toggle page list | F4 |

## How it works

| Concern | Implementation |
| --- | --- |
| Rendering, text layer, search, links, forms | [pdf.js](https://github.com/mozilla/pdf.js) viewer component (`pdfjs-dist/web/pdf_viewer.mjs`) |
| Annotation editing and saving | pdf.js annotation editor; `saveDocument()` appends edits as an incremental update |
| Reorder, delete, duplicate, insert, extract | pdf.js page assembler (`PDFDocumentProxy.extractPages`), which writes a new file containing only reachable objects, so deleted pages are really gone. It keeps forms, outlines, named destinations, page labels and the structure tree. |
| Rotation, metadata, blank pages | [pdf-lib](https://github.com/Hopding/pdf-lib) |
| File access | File System Access API with `<input type=file>` and download fallbacks; `launchQueue` for OS file handling |
| Offline | A small service worker (`public/sw.js`) |
| Desktop / portable exe | [Electron](https://www.electronjs.org/) shell (`desktop/`) serving `dist/` from a private `app://` origin with a strict CSP; native open/save dialogs through a sandboxed preload bridge; packaged by [electron-builder](https://www.electron.build/) |
| Lightweight desktop build | [Tauri](https://tauri.app/) shell (`src-tauri/`) with the same contract: `dist/` embedded and served from the app's own origin with the same CSP, no Tauri APIs granted to the page, and the same `window.palimpsestDesktop` bridge backed by Rust commands |

In both desktop builds the page can only read and write files the user picked in a dialog or passed on the command line. Saves go to a temporary file beside the target and are then renamed over it, so a failed save never truncates the original.

A page operation first folds pending annotations into the current bytes, transforms them, and reloads the result. Each step keeps a snapshot for undo. Annotation edits between page operations use pdf.js's own undo stack.

```
src/
  app.ts          UI controller: viewer wiring, tools, page ops, save, undo
  pageops.ts      page plans → pdf.js extractPages(); pdf-lib edits
  thumbnails.ts   page list: lazy thumbnails, selection, drag and drop
  files.ts        open/save: desktop bridge, File System Access API, or fallbacks
  desktop.ts      types for the desktop bridge (Electron and Tauri)
  history.ts      document-level undo/redo snapshots
  print.ts        rasterised printing
  pdfjs.ts        pdf.js setup (worker, fonts, CMaps, WASM)
desktop/
  main.mjs        Electron main process: window, app:// protocol, dialogs, file writes
  preload.cjs     the narrow bridge exposed to the page
src-tauri/
  src/main.rs     Tauri shell: windows, dialogs, file reads/writes, links, close prompt
  src/bridge.js   the same bridge as preload.cjs, built on the shell's commands
  src/e2e.rs      test hooks (scripted dialogs, event log), only in `--features e2e` builds
scripts/
  launch.mjs      `npm run app`: local server + Chromium app window
tests/
  unit/           Vitest: page plans and assembly, run against pdf.js in Node
  e2e/            Playwright: the real app in Chromium; saved files are decoded and checked
  desktop/        Playwright + Electron: command-line open, save in place, dialogs, sandboxing
  tauri/          Vitest + WebDriver: the same checks against the Tauri shell, plus printing
```

## Testing

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build && npm run test:desktop
```

On Linux without a display, run the desktop tests as `xvfb-run -a npm run test:desktop`. To test a packaged build, set `PALIMPSEST_EXE` to its executable.

```bash
npm run test:tauri
```

This builds the Tauri shell with its test hooks and drives it through the platform's WebDriver: WebKitWebDriver on Linux (package `webkit2gtk-driver`; use `xvfb-run -a` without a display) or msedgedriver on Windows (set `MSEDGEDRIVER`; its version must match the WebView2 runtime). macOS has no WebDriver for its webview.

The end-to-end tests stub the native file pickers, drive the UI, and parse each saved PDF with pdf.js to check pages, rotation, annotations, form values and metadata. The desktop tests stub Electron's dialogs and check the files written to disk; the Tauri tests script the shell's dialogs the same way. CI runs everything on every push (`.github/workflows/ci.yml`). The release workflow also runs the desktop tests against the Windows build.

## Known limitations

- Text that is already in the PDF can't be edited in place. You can annotate over it, or cover it with an image.
- Reorganising pages (delete, move, insert, duplicate) rebuilds the file without optional-content layers, the document-level XMP metadata, and document JavaScript.
- Rotation and property edits use pdf-lib, which can't write encrypted PDFs. These actions show an error on encrypted files. Opening (with the password), annotating, form filling and page reorganisation still work, and the saved file stays encrypted.
- Signatures are visual (drawn or image) only. There is no cryptographic signing, and changing a digitally signed PDF flags or invalidates its signatures.
- The annotation tools are unavailable on pure XFA forms.
- `pdfjs-dist` is pinned to an exact version because the app uses its viewer and page-assembly APIs.
- CI tests the Tauri build on Linux and Windows. macOS is untested: printing there goes through the native print sheet, and files opened from Finder are not handled yet (macOS passes them as an event, not on the command line).
- In the Tauri build on Linux, printing uses the paper size chosen in the print dialog rather than the PDF's page size.

## License

MIT, see [LICENSE](LICENSE). Bundles pdf.js (Apache-2.0) and pdf-lib (MIT). The Electron build also ships Electron and Chromium, and their licence files are packaged with it. The Tauri build uses the system webview and ships none.
