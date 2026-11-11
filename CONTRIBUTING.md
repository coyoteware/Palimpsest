# Contributing

Thanks for helping. Bug reports with a sample PDF (or a description of how to make one) are the most useful thing you can send.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
```

## Before opening a pull request

```bash
npm run typecheck
npm test           # unit tests (Vitest, runs pdf.js in Node)
npm run test:e2e   # end-to-end tests (Playwright, headless Chromium)
```

New behaviour needs a test. Page operations get a unit test in `tests/unit/`; anything a user clicks gets an end-to-end test in `tests/e2e/`. The e2e helpers stub the File System Access pickers and decode saved files with pdf.js, so assert on the saved PDF, not only on the DOM.

## Ground rules

- Files never leave the device. No network calls other than loading the app's own assets.
- `pdfjs-dist` is pinned to an exact version: the app uses the viewer component and the page-assembly API, which change between releases. Upgrade deliberately and run the full suite.
- Keep dependencies few. Two runtime dependencies today (pdf.js, pdf-lib).
- Icons are original SVG in `src/icons.ts`; don't paste in third-party icon sets without checking their licence.
