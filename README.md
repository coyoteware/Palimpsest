# Palimpsest

An open source PDF viewer and editor for the desktop. It is a small native app built with [Tauri](https://tauri.app/) that uses the operating system's own web engine, so the Windows build is a single file of about 6–8 MB. Everything happens on your device; files are never uploaded.

![Palimpsest editing a PDF: highlighted text, a drawn ellipse and a text note, with the page list on the left](docs/screenshot.png)

## Features

- **View**: fast rendering, text selection, search (match case / whole words), links, zoom presets and Ctrl+wheel zoom, page thumbnails.
- **Annotate**: add text, draw, highlight (select text, or draw freely), place images and signature scans. Annotations are saved as standard PDF annotations, so other viewers show them and Palimpsest can edit them again later.
- **Fill forms**: AcroForm fields render as editable inputs and their values are saved into the file.
- **Organise pages**: rotate, delete, duplicate, reorder by dragging, insert blank pages, insert pages from other PDFs (drop them on the page list), save a selection as a new PDF.
- **Split and merge**: split a document into several PDFs, every N pages or by page ranges such as `1-3, 4, 5-`, saved to a folder you choose. Merge PDFs, in an order you set, into a new document; the open document can be one of them, unsaved edits included. Password-protected files can be merged after you enter their password.
- **Document properties**: edit title, author, subject and keywords.
- **Undo/redo** across both annotation edits and page operations.
- **Save in place**: a file opened from disk, from the command line or with "Open with" is written back to the same file. Save as and print are also included.
- **Works offline**, with light and dark themes.

## Download (Windows)

From [Releases](https://github.com/coyoteware/Palimpsest/releases), get either:

- **`Palimpsest-<version>-setup.exe`**, the installer. It installs for your account only, so it needs no admin rights, and adds Palimpsest to the Start menu and to the **Open with** menu for PDFs. PDFs also get an **Open with Palimpsest** command when you right-click them (on Windows 11, under **Show more options**). It doesn't change your default PDF app; to make Palimpsest the default, pick it in **Settings → Apps → Default apps**. Uninstall it from **Settings → Apps**, which removes all of this again.
- **`Palimpsest-<version>-portable.exe`**, a single file that needs no installation: run it, drag a PDF onto it, or use **Open with → Choose another app** on a PDF.

Both:

- use Microsoft Edge WebView2, which is built into Windows 11. Most Windows 10 PCs have it too; if yours doesn't, the installer downloads it, and for the portable exe install the [WebView2 Evergreen runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
- aren't code-signed yet, so on first run Windows SmartScreen says "Windows protected your PC". Choose **More info → Run anyway**.
- keep settings in `%LOCALAPPDATA%\io.github.coyoteware.palimpsest`.

## Run from source

Requires Node.js 22.13 or later and a [Rust toolchain](https://rustup.rs/). On Linux, also the WebKitGTK 4.1 development packages (Debian/Ubuntu: `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev`); see Tauri's [prerequisites](https://tauri.app/start/prerequisites/) for other systems.

```bash
npm install
```

```bash
npm run app
```

This runs the app against the Vite dev server with hot reload. The first run compiles the Rust shell, which takes a few minutes.

## Building

```bash
npm run dist
```

This writes `src-tauri/target/release/palimpsest` (`palimpsest.exe` on Windows), a single executable that runs without installing.

```bash
npm run dist:installer
```

On Windows this writes the installer to `src-tauri/target/release/bundle/nsis/`. What it registers for PDFs is in `src-tauri/windows/installer-hooks.nsh`, and `scripts/test-installer.ps1` checks it on a CI runner: it installs silently, checks the registry, opens a PDF through **Open with Palimpsest**, and uninstalls. On Linux and macOS, `npm run tauri build` makes the native packages instead (.deb, .rpm and AppImage; .app and .dmg), which declare Palimpsest as a PDF viewer.

To publish a release, set `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The [Release workflow](.github/workflows/release.yml) runs on a Windows runner. It runs the end-to-end tests, builds and smoke-tests the portable exe, builds and tests the installer, and attaches `Palimpsest-<version>-portable.exe` and `Palimpsest-<version>-setup.exe` to a GitHub release. Running the workflow by hand (Actions → Release → Run workflow) builds and tests both without publishing them; they are attached to the run as an artifact.

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
| Reorder, delete, duplicate, insert, extract, split, merge | pdf.js page assembler (`PDFDocumentProxy.extractPages`), which writes a new file containing only reachable objects, so deleted pages are really gone. It keeps forms, outlines, named destinations, page labels and the structure tree. |
| Rotation, metadata, blank pages | [pdf-lib](https://github.com/Hopding/pdf-lib) |
| Desktop shell | [Tauri](https://tauri.app/) (`src-tauri/`): the web app in `dist/` is embedded in the binary and served from the app's own origin with a strict CSP. The page gets no Tauri APIs; it reaches files only through a narrow bridge (`window.palimpsestDesktop`) backed by Rust commands and native dialogs. |
| Web engine | The system webview: WebView2 (Chromium-based Edge) on Windows, WKWebView on macOS, WebKitGTK on Linux |

The page can only read and write files the user picked in a dialog or passed on the command line. Splitting asks for a folder, and the shell then allows writing only the named PDFs there. Saves go to a temporary file beside the target and are then renamed over it, so a failed save never truncates the original.

A page operation first folds pending annotations and form values into the current bytes, transforms them, and reloads the result. Each step keeps a snapshot for undo. Annotation edits between page operations use pdf.js's own undo stack.

```
src/
  app.ts          UI controller: viewer wiring, tools, page ops, save, undo
  pageops.ts      page plans → pdf.js extractPages(); pdf-lib edits
  thumbnails.ts   page list: lazy thumbnails, selection, drag and drop
  files.ts        open/save through the desktop bridge
  desktop.ts      types for the desktop bridge
  history.ts      document-level undo/redo snapshots
  print.ts        rasterised printing
  pdfjs.ts        pdf.js setup (worker, fonts, CMaps, WASM)
src-tauri/
  src/main.rs     the shell: windows, dialogs, file reads/writes, links, close requests
  src/bridge.js   window.palimpsestDesktop, injected into the page
  src/e2e.rs      test hooks (scripted dialogs, event log), only in `--features e2e` builds
  windows/        what the Windows installer registers for PDFs ("Open with")
  icons/          app icons, generated from icon.svg by `npm run icons`
tests/
  unit/           Vitest: page plans and assembly, run against pdf.js in Node
  e2e/            Vitest + WebDriver: the real app; saved files are decoded and checked
```

## Testing

```bash
npm run typecheck
npm test
npm run test:e2e
```

`npm run test:e2e` builds the app with its test hooks and drives it through the platform's WebDriver: WebKitWebDriver on Linux (package `webkit2gtk-driver`; without a display, run `xvfb-run -a npm run test:e2e`) or msedgedriver on Windows (set `MSEDGEDRIVER`; its version must match the WebView2 runtime, see `scripts/edgedriver.ps1`; and run them from a shell without administrator rights, because an elevated WebView2 ignores the debugging switch the driver needs. CI uses `scripts/windows-unelevated.ps1` for this). macOS has no WebDriver for its webview. Set `PALIMPSEST_APP` to run the tests against another build; tests that need the hooks then fail, so pick them with `-t`.

The end-to-end tests answer the app's file dialogs through the test hooks, drive the UI, and parse each saved PDF with pdf.js to check pages, rotation, annotations, form values and metadata. CI runs them on Linux and Windows on every push (`.github/workflows/ci.yml`); the release workflow runs them again and smoke-tests the release build.

## Known limitations

- Text that is already in the PDF can't be edited in place. You can annotate over it, or cover it with an image.
- Reorganising pages (delete, move, insert, duplicate) rebuilds the file without optional-content layers, the document-level XMP metadata, and document JavaScript.
- Rotation and property edits use pdf-lib, which can't write encrypted PDFs. These actions show an error on encrypted files. Opening (with the password), annotating, form filling and page reorganisation still work, and the saved file stays encrypted.
- Signatures are visual (drawn or image) only. There is no cryptographic signing, and changing a digitally signed PDF flags or invalidates its signatures.
- The annotation tools are unavailable on pure XFA forms.
- `pdfjs-dist` is pinned to an exact version because the app uses its viewer and page-assembly APIs.
- macOS is untested: there is no WebDriver for its webview. Printing there goes through the native print sheet, and files opened from Finder are not handled yet (macOS passes them as an event, not on the command line).
- On Linux, printing uses the paper size chosen in the print dialog rather than the PDF's page size.
- Dragging pages in the page list is tested by dispatching the page's drag events; the system's own drag session can't be automated.

## License

MIT, see [LICENSE](LICENSE). Bundles pdf.js (Apache-2.0) and pdf-lib (MIT), and is built with Tauri (MIT/Apache-2.0). It uses the system webview and ships no browser engine.
