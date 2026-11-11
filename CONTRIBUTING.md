# Contributing

Thanks for helping. Bug reports with a sample PDF (or a description of how to make one) are the most useful thing you can send.

## Setup

You need Node.js 22.13 or later and a Rust toolchain; on Linux also the WebKitGTK packages listed in the README.

```bash
npm install
npm run app        # the app, with hot reload of the web code
```

## Before opening a pull request

```bash
npm run typecheck
npm test           # unit tests (Vitest, runs pdf.js in Node)
npm run test:e2e   # end-to-end tests: the real app over WebDriver (Linux without a display: xvfb-run -a …)
```

New behaviour needs a test. Page operations get a unit test in `tests/unit/`; anything a user clicks gets an end-to-end test in `tests/e2e/`. Those tests answer the app's file dialogs through test hooks (`src-tauri/src/e2e.rs`) and decode saved files with pdf.js, so assert on the saved PDF, not only on the screen.

## Ground rules

- Files never leave the device. No network calls other than loading the app's own assets.
- `pdfjs-dist` is pinned to an exact version: the app uses the viewer component and the page-assembly API, which change between releases. Upgrade deliberately and run the full suite.
- Keep dependencies few. The web app uses two libraries (pdf.js, pdf-lib), bundled by Vite into `dist/`, so every npm package is a devDependency. The shell uses Tauri and its dialog, opener and single-instance plugins.
- The shell (`src-tauri/`) is the only code with file system access. Keep the bridge (`src-tauri/src/bridge.js`, typed in `src/desktop.ts`) narrow, and only read or write paths the user chose. The page gets no Tauri or plugin permissions (`src-tauri/capabilities/default.json`); keep it that way.
- The app runs on three web engines (WebView2, WebKitGTK, WKWebView). Use web platform features they all support.
- Icons are original SVG: the app icon in `src-tauri/icons/icon.svg` (regenerate the PNG and ICO files with `npm run icons`), toolbar icons in `src/icons.ts`. Don't paste in third-party icon sets without checking their licence.
