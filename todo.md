# To do

Features Adobe Reader (and Acrobat Pro) have that Palimpsest lacks, ordered by cost. Tick an item when it ships with tests.

## Tier 1: pdf.js already provides the machinery

- [x] **Bookmarks panel**: the document outline as a tree in the sidebar (`getOutline()`), with tabs for attachments (`getAttachments()`) and layers (`getOptionalContentConfig()`).
- [x] **Page display modes**: single page, continuous, two-page spreads (odd or even first), wrapped (`PDFViewer.scrollMode` / `spreadMode`).
- [x] **Rotate view**: turn the view without changing the file (`pdfViewer.pagesRotation`).
- [x] **Back / forward**: return after following a link, Alt+Left / Alt+Right (`PDFHistory`).
- [x] **Page labels**: the page box shows labels such as "iv (4 of 120)" (`getPageLabels()`).
- [x] **Comments**: sticky notes and a panel listing every comment (`AnnotationEditorType.COMMENT` / `POPUP`).
- [x] **Fill & Sign**: typed or drawn signatures and initials, saved for reuse; check, cross and date marks (`AnnotationEditorType.SIGNATURE`).
- [x] **Form JavaScript**: calculated fields, formatting and validation (`PDFScriptingManager` and the pdf.js sandbox).
- [x] **Full screen / presentation mode**.

## Tier 2: our own code

- [x] **More markup**: underline, strikethrough, squiggly; rectangle, ellipse, line and arrow.
- [ ] **Recent files**, and reopening a file at its last page and zoom.
- [ ] **Print options**: page range, current page, annotations on or off, fit or actual size.
- [ ] **Hand tool, marquee zoom, snapshot to clipboard**.
- [ ] **Export pages as images** (PNG, JPEG).
- [ ] **Tabs**: several documents in one window.
- [ ] **Fuller properties**: fonts, security and permissions, PDF version, producer.

## Tier 3: Acrobat Pro territory

- [ ] **Digital signatures**: verify existing ones; sign with a certificate.
- [ ] **Redaction** that removes the content (needs content-stream editing, e.g. PDFium).
- [ ] **Edit existing text**.
- [ ] **OCR** (the Windows OCR API through the shell, or Tesseract).
- [ ] **Password protection** (pdf-lib cannot encrypt).
- [ ] **Compress, compare documents, export to Word, measuring tools**.

## Not planned

- Read Out Loud.
- Opening files from Finder on macOS.
