import "pdfjs-dist/web/pdf_viewer.css";
import { AnnotationEditorParamsType as P, AnnotationEditorType as T, AnnotationMode } from "pdfjs-dist";
import {
  EventBus,
  FindState,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import * as files from "./files";
import { DocHistory } from "./history";
import * as ops from "./pageops";
import { PDFJS_ASSETS, openPdf, type PDFDocumentProxy } from "./pdfjs";
import { printPdf } from "./print";
import { Thumbnails } from "./thumbnails";

const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;

type Tool = "none" | "text" | "ink" | "highlight" | "image";
const MODE: Record<Tool, number> = {
  none: T.NONE,
  text: T.FREETEXT,
  ink: T.INK,
  highlight: T.HIGHLIGHT,
  image: T.STAMP,
};
const TOOL_OF_MODE = new Map(Object.entries(MODE).map(([tool, mode]) => [mode, tool as Tool]));
const TOOL_KEYS: Record<string, Tool> = { v: "none", t: "text", d: "ink", h: "highlight", i: "image" };
const HIGHLIGHT_COLORS = "yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F";

interface UIManager {
  undo(): void;
  redo(): void;
  commitOrRemove(): void;
  unselectAll(): void;
  readonly hasSelection: boolean;
}

/** Defaults for new annotations; what the tool options show when nothing is selected. */
interface ToolParams {
  textColor: string;
  textSize: number;
  inkColor: string;
  inkThickness: number;
  inkOpacity: number;
  highlightColor: string;
  highlightThickness: number;
}

/** pdf.js parameter type ↔ ToolParams key (opacity is 0–1 in pdf.js, 0–100 here). */
const PARAM_KEYS: [number, keyof ToolParams][] = [
  [P.FREETEXT_COLOR, "textColor"],
  [P.FREETEXT_SIZE, "textSize"],
  [P.INK_COLOR, "inkColor"],
  [P.INK_THICKNESS, "inkThickness"],
  [P.INK_OPACITY, "inkOpacity"],
  [P.HIGHLIGHT_COLOR, "highlightColor"],
  [P.HIGHLIGHT_THICKNESS, "highlightThickness"],
];
const TOOL_PARAMS: Record<Tool, (keyof ToolParams)[]> = {
  none: [],
  text: ["textColor", "textSize"],
  ink: ["inkColor", "inkThickness", "inkOpacity"],
  highlight: ["highlightColor", "highlightThickness"],
  image: [],
};
const toPdfjs = (key: keyof ToolParams, v: string | number) => (key === "inkOpacity" ? Number(v) / 100 : v);
const fromPdfjs = (key: keyof ToolParams, v: unknown) =>
  key === "inkOpacity" ? Math.round(Number(v) * 100) : typeof v === "number" ? v : String(v);

interface EditorStates {
  isEditing?: boolean;
  hasSomethingToUndo?: boolean;
  hasSomethingToRedo?: boolean;
  hasSelectedEditor?: boolean;
}

interface LoadOptions {
  /** A different file (resets history, save target, password). */
  fresh?: { name: string; target: files.SaveTarget | null };
  page?: number;
  selection?: number[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const isTyping = (el: Element | null) =>
  !!el && (el.matches("input, textarea, select, [contenteditable=''], [contenteditable='true']") || !!el.closest("[contenteditable='true']"));

export class App {
  readonly eventBus = new EventBus();
  readonly linkService: PDFLinkService;
  readonly findController: PDFFindController;
  readonly viewer: PDFViewer;
  readonly thumbs: Thumbnails;
  readonly history = new DocHistory();

  doc: PDFDocumentProxy | null = null;
  fileName = "";
  /** Where Save writes; null until the document has a file to go back to. */
  target: files.SaveTarget | null = null;
  #password: string | undefined;
  #docDirty = false;
  #annotDirty = false;
  #busy = false;
  #tool: Tool = "none";
  #ui: UIManager | null = null;
  #editor: EditorStates = {};
  #pendingView: { page: number; scale: string } | null = null;
  #params: ToolParams = {
    textColor: "#000000",
    textSize: 12,
    inkColor: "#1d4ed8",
    inkThickness: 2,
    inkOpacity: 100,
    highlightColor: "#FFFF98",
    highlightThickness: 12,
  };
  /** Values shown in the tool options: #params, or the selected annotation's. */
  #shown: ToolParams = { ...this.#params };

  constructor() {
    const container = $<HTMLDivElement>("viewerContainer");
    this.linkService = new PDFLinkService({
      eventBus: this.eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: "noopener noreferrer nofollow",
    });
    this.findController = new PDFFindController({ eventBus: this.eventBus, linkService: this.linkService });
    this.viewer = new PDFViewer({
      container,
      viewer: $<HTMLDivElement>("viewer"),
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: T.NONE,
      annotationEditorHighlightColors: HIGHLIGHT_COLORS,
      imageResourcesPath: PDFJS_ASSETS.imageResourcesPath,
      // Supported by the viewer but missing from its type declarations.
      ...({ enableHighlightFloatingButton: true } as object),
    });
    this.linkService.setViewer(this.viewer);

    this.thumbs = new Thumbnails($("thumbs"), {
      navigate: (i) => (this.viewer.currentPageNumber = i + 1),
      move: (pages, before) => void this.movePages(pages, before),
      insertFiles: (list, before) => void this.insertFiles(list, before),
      selectionChanged: (sel) => this.#renderSelection(sel),
    });

    this.#wireViewerEvents();
    this.#wireToolbar();
    this.#wireFind();
    this.#wireKeyboard();
    this.#wireDragAndDrop();
    container.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    window.addEventListener("beforeunload", (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = ""; // older Chromium (and Electron) still look at this
    });
    window.addEventListener("resize", () => this.#refit());
    this.#setSidebar(readPref("sidebar") !== "closed");
    this.#renderTool();
  }

  // ---------------------------------------------------------------- state

  get dirty() {
    return this.#docDirty || this.#annotDirty;
  }

  get page() {
    return this.viewer.currentPageNumber || 1;
  }

  get pageCount() {
    return this.doc?.numPages ?? 0;
  }

  /**
   * The document as it would be saved now: the loaded file plus pending
   * annotation and form edits. Leaves the dirty flag untouched.
   */
  async currentBytes(): Promise<Uint8Array> {
    const doc = this.#requireDoc();
    this.#ui?.commitOrRemove();
    if (doc.annotationStorage.size === 0) return doc.getData();
    const wasDirty = this.#annotDirty;
    const bytes = await doc.saveDocument();
    this.#annotDirty = wasDirty;
    return bytes;
  }

  #requireDoc() {
    if (!this.doc) throw new Error("No document is open.");
    return this.doc;
  }

  // ------------------------------------------------------------- loading

  async openFile(file: files.OpenedFile) {
    return this.#load(file.bytes, { fresh: { name: file.name, target: file.target } });
  }

  async #load(bytes: Uint8Array, opts: LoadOptions): Promise<boolean> {
    let opened;
    try {
      opened = await openPdf(bytes, {
        password: opts.fresh ? undefined : this.#password,
        askPassword: (incorrect) => this.#askPassword(incorrect),
      });
    } catch (e) {
      if (!(e instanceof Error && e.name === "PasswordException")) {
        toast(`Could not open the PDF: ${errorText(e)}`, "error");
      }
      return false;
    }
    const old = this.doc;
    const doc = (this.doc = opened.doc);
    this.#password = opened.password;
    if (opts.fresh) {
      this.fileName = opts.fresh.name;
      this.target = opts.fresh.target;
      this.history.clear();
      this.#docDirty = false;
    }
    this.#annotDirty = false;
    this.#ui = null;
    this.#editor = {};
    this.#tool = "none";
    const view = (this.#pendingView = {
      page: Math.min(opts.page ?? 1, doc.numPages),
      scale: opts.fresh ? "auto" : this.viewer.currentScaleValue || "auto",
    });
    const storage = doc.annotationStorage as unknown as {
      onSetModified: (() => void) | null;
      onResetModified: (() => void) | null;
    };
    storage.onSetModified = () => {
      this.#annotDirty = true;
      this.#renderTitle();
    };
    storage.onResetModified = () => {
      this.#annotDirty = false;
      this.#renderTitle();
    };

    this.viewer.setDocument(doc);
    this.linkService.setDocument(doc, null);
    void this.thumbs.setDocument(doc, { current: view.page - 1, selection: opts.selection });
    if (old) await old.loadingTask.destroy();

    $("app").classList.remove("no-doc");
    $("pageCount").textContent = `/ ${doc.numPages}`;
    $<HTMLInputElement>("pageNumber").value = String(view.page);
    this.#renderTitle();
    this.#renderTool();
    this.#renderUndo();
    return true;
  }

  async #askPassword(incorrect: boolean): Promise<string | null> {
    const dialog = $<HTMLDialogElement>("passwordDialog");
    const input = $<HTMLInputElement>("passwordInput");
    $("passwordMsg").textContent = incorrect
      ? "That password is not correct. Try again."
      : "This PDF is protected. Enter its password to open it.";
    input.value = "";
    const result = await showDialog(dialog);
    return result === "ok" ? input.value : null;
  }

  // ----------------------------------------------------------- file ops

  async open() {
    if (this.#busy || !(await this.confirmDiscard())) return;
    try {
      const [file] = await files.pickPdfs($("fileInput"));
      if (file) await this.openFile(file);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async confirmDiscard() {
    if (!this.dirty) return true;
    return confirmDialog("Discard unsaved changes?", `${this.fileName} has changes that have not been saved.`, "Discard");
  }

  async save(saveAs = false) {
    if (!this.doc || this.#busy) return;
    await this.#withBusy("Saving…", async () => {
      const bytes = await this.currentBytes();
      if (this.target && !saveAs) {
        await this.target.write(bytes);
      } else {
        const target = await files.saveAs(this.fileName || "document.pdf", bytes);
        if (target === undefined) return; // cancelled
        if (target) {
          this.target = target;
          this.fileName = target.name;
        }
      }
      this.#docDirty = false;
      this.#annotDirty = false;
      this.#renderTitle();
      toast(`Saved ${this.fileName}`);
    });
  }

  async print() {
    if (!this.doc || this.#busy) return;
    await this.#withBusy("Preparing to print…", async () => {
      await printPdf(await this.currentBytes(), this.#password, (done, total) => {
        $("busyLabel").textContent = `Preparing to print… ${done}/${total}`;
      });
    });
  }

  // ----------------------------------------------------------- page ops

  /**
   * Run a document-level edit: snapshot for undo, produce new bytes from the
   * current ones (pending annotations included), and reload.
   */
  async #edit(
    label: string,
    produce: (current: Uint8Array) => Promise<Uint8Array | null>,
    after: { page?: number; selection?: number[] } = {},
  ) {
    if (!this.doc || this.#busy) return;
    await this.#withBusy(`${label}…`, async () => {
      const before = await this.currentBytes();
      const out = await produce(before);
      if (!out) return;
      this.history.push({ bytes: before, label, page: this.page });
      if (await this.#load(out, { page: after.page ?? this.page, selection: after.selection })) {
        this.#docDirty = true;
        this.#renderTitle();
        this.#renderUndo();
      }
    });
  }

  #structural(label: string, plan: ops.PlanPage[], extras: Uint8Array[] = [], after: { page?: number; selection?: number[] } = {}) {
    const doc = this.#requireDoc();
    if (extras.length === 0 && ops.isIdentity(plan, doc.numPages)) return Promise.resolve();
    return this.#edit(label, (current) => this.#assemble(plan, extras, current), after);
  }

  /**
   * Assemble pages from the document as it would be saved now. pdf.js's page
   * assembler takes new annotations from the pending edits but not changed
   * form values, so when anything is pending it works from the saved bytes
   * (`current`, or computed here) instead of the open document.
   */
  async #assemble(plan: ops.PlanPage[], extras: Uint8Array[] = [], current?: Uint8Array) {
    const doc = this.#requireDoc();
    if (doc.annotationStorage.size === 0) return ops.assemble(doc, plan, extras);
    const { doc: saved } = await openPdf(current ?? (await this.currentBytes()), { password: this.#password });
    try {
      return await ops.assemble(saved, plan, extras);
    } finally {
      await saved.loadingTask.destroy();
    }
  }

  rotate(delta: number) {
    const pages = this.thumbs.targets;
    return this.#edit(`Rotate ${plural(pages.length, "page")}`, (b) => ops.rotatePages(b, pages, delta), {
      selection: this.thumbs.selection,
    });
  }

  deletePages(pages = this.thumbs.targets) {
    const n = this.pageCount;
    if (pages.length >= n) {
      toast("A PDF needs at least one page.", "error");
      return Promise.resolve();
    }
    const nextPage = Math.min(pages[0] + 1, n - pages.length);
    return this.#structural(`Delete ${plural(pages.length, "page")}`, ops.deletePlan(n, pages), [], {
      page: nextPage,
      selection: [],
    });
  }

  duplicatePages() {
    const pages = this.thumbs.targets;
    const copies = pages.map((p, k) => p + k + 1);
    return this.#structural(`Duplicate ${plural(pages.length, "page")}`, ops.duplicatePlan(this.pageCount, pages), [], {
      page: copies[0] + 1,
      selection: copies,
    });
  }

  movePages(pages: number[], before: number) {
    const plan = ops.movePlan(this.pageCount, pages, before);
    const at = before - pages.filter((p) => p < before).length;
    const selection = pages.map((_, k) => at + k);
    return this.#structural(`Move ${plural(pages.length, "page")}`, plan, [], { page: at + 1, selection });
  }

  async insertBlank() {
    const doc = this.#requireDoc();
    const after = Math.max(...this.thumbs.targets);
    const vp = (await doc.getPage(after + 1)).getViewport({ scale: 1 });
    const blank = await ops.blankPagePdf(vp.width, vp.height);
    return this.#structural("Insert blank page", ops.insertPlan(this.pageCount, after + 1, 1, 1), [blank], {
      page: after + 2,
      selection: [after + 1],
    });
  }

  async pickAndInsert() {
    if (!this.doc) return;
    try {
      const picked = await files.pickPdfs($("insertInput"), true);
      if (picked.length) await this.#insertDocs(picked, Math.max(...this.thumbs.targets) + 1);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async insertFiles(list: File[], before: number) {
    const pdfs = list.filter(files.looksLikePdf);
    if (!pdfs.length) return toast("Only PDF files can be inserted.", "error");
    await this.#insertDocs(await Promise.all(pdfs.map((f) => files.fromFile(f))), before);
  }

  async #insertDocs(docs: files.OpenedFile[], before: number) {
    const counts: number[] = [];
    for (const d of docs) {
      try {
        const { doc } = await openPdf(d.bytes);
        counts.push(doc.numPages);
        await doc.loadingTask.destroy();
      } catch (e) {
        return toast(`${d.name}: ${errorText(e)}`, "error");
      }
    }
    const plan = ops.identityPlan(this.pageCount);
    const inserted = docs.flatMap((_, k) =>
      Array.from({ length: counts[k] }, (_, index) => ({ src: k + 1, index })),
    );
    plan.splice(before, 0, ...inserted);
    const total = inserted.length;
    await this.#structural(
      `Insert ${plural(total, "page")}`,
      plan,
      docs.map((d) => d.bytes),
      { page: before + 1, selection: Array.from({ length: total }, (_, k) => before + k) },
    );
  }

  async extractPages() {
    const doc = this.doc;
    if (!doc || this.#busy) return;
    const pages = this.thumbs.targets;
    await this.#withBusy("Extracting pages…", async () => {
      const bytes = await this.#assemble(ops.extractPlan(pages));
      const label = pages.length === 1 ? `p${pages[0] + 1}` : `p${pages[0] + 1}-${pages.at(-1)! + 1}`;
      const saved = await files.saveAs(files.withSuffix(this.fileName || "document", `-${label}`), bytes);
      if (saved !== undefined) toast(`Saved ${plural(pages.length, "page")} to a new file`);
    });
  }

  async editProperties() {
    const doc = this.doc;
    if (!doc) return;
    const { info } = (await doc.getMetadata()) as { info: Record<string, string> };
    const fields = { title: "Title", author: "Author", subject: "Subject", keywords: "Keywords" } as const;
    const inputs = Object.fromEntries(
      Object.entries(fields).map(([k, key]) => {
        const input = $<HTMLInputElement>(`prop${key}`);
        input.value = typeof info[key] === "string" ? info[key] : "";
        return [k, input];
      }),
    ) as Record<keyof typeof fields, HTMLInputElement>;
    const original = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));

    const vp = (await doc.getPage(this.page)).getViewport({ scale: 1 });
    const size = `${(vp.width / 72).toFixed(2)} × ${(vp.height / 72).toFixed(2)} in (${Math.round((vp.width / 72) * 25.4)} × ${Math.round((vp.height / 72) * 25.4)} mm)`;
    const bytes = (await doc.getDownloadInfo()).length;
    const facts: [string, string][] = [
      ["File", this.fileName],
      ["Size", `${(bytes / 1024).toFixed(bytes > 10240 ? 0 : 1)} KB`],
      ["Pages", String(doc.numPages)],
      ["Page size", size],
      ["PDF version", info.PDFFormatVersion ?? "—"],
      ["Creator", info.Creator || "—"],
      ["Producer", info.Producer || "—"],
    ];
    const dl = $("propsFacts");
    dl.textContent = "";
    for (const [k, v] of facts) {
      dl.append(Object.assign(document.createElement("dt"), { textContent: k }));
      dl.append(Object.assign(document.createElement("dd"), { textContent: v }));
    }

    if ((await showDialog($<HTMLDialogElement>("propsDialog"))) !== "ok") return;
    const next = {
      title: inputs.title.value.trim(),
      author: inputs.author.value.trim(),
      subject: inputs.subject.value.trim(),
      keywords: inputs.keywords.value.trim(),
    };
    if (Object.entries(next).every(([k, v]) => v === original[k])) return;
    await this.#edit("Edit properties", (b) => ops.writeInfo(b, next));
  }

  // --------------------------------------------------------- undo / redo

  async undo() {
    if (this.#editor.hasSomethingToUndo && this.#ui) return this.#ui.undo();
    await this.#stepHistory("undo");
  }

  async redo() {
    if (this.#editor.hasSomethingToRedo && this.#ui) return this.#ui.redo();
    await this.#stepHistory("redo");
  }

  async #stepHistory(dir: "undo" | "redo") {
    if (!this.doc || this.#busy) return;
    const can = dir === "undo" ? this.history.canUndo : this.history.canRedo;
    if (!can) return;
    await this.#withBusy(dir === "undo" ? "Undoing…" : "Redoing…", async () => {
      const current = { bytes: await this.currentBytes(), label: "", page: this.page };
      const snap = dir === "undo" ? this.history.undo(current) : this.history.redo(current);
      if (!snap) return;
      await this.#load(snap.bytes, { page: snap.page });
      this.#docDirty = true;
      this.#renderTitle();
      this.#renderUndo();
      toast(`${dir === "undo" ? "Undid" : "Redid"}: ${snap.label}`);
    });
  }

  // ---------------------------------------------------------------- tools

  async setTool(tool: Tool) {
    if (!this.doc) return;
    if (tool !== this.#tool) {
      await this.#setMode(MODE[tool]);
      this.#tool = tool;
      this.#applyToolDefaults(tool);
      this.#renderTool();
    }
    if (tool === "image") await this.addImage();
  }

  async #setMode(mode: number) {
    const current = this.viewer.annotationEditorMode as unknown as number;
    if (current === T.DISABLE || current === mode) return;
    const ac = new AbortController();
    const changed = new Promise<void>((resolve) => {
      this.eventBus.on(
        "annotationeditormodechanged",
        (e: { mode: number }) => e.mode === mode && resolve(),
        { signal: ac.signal },
      );
      setTimeout(resolve, 4000);
    });
    this.viewer.annotationEditorMode = { mode };
    await changed;
    ac.abort();
  }

  async addImage() {
    const file = await files.pickImage($("imageInput")).catch((e) => {
      toast(errorText(e), "error");
      return null;
    });
    if (!file) return;
    if (this.#tool !== "image") await this.setTool("image");
    await this.#editorLayerReady();
    this.#dispatchParam(P.CREATE, { bitmapFile: file });
  }

  /**
   * Wait for the current page's editor layer. The first switch into an editing
   * mode announces the new mode before it creates the layers, and pdf.js drops
   * an annotation created in between.
   */
  async #editorLayerReady() {
    const pageNumber = this.page;
    if (this.viewer.getPageView(pageNumber - 1)?.annotationEditorLayer?.annotationEditorLayer) return;
    const ac = new AbortController();
    await new Promise<void>((resolve) => {
      this.eventBus.on(
        "annotationeditorlayerrendered",
        (e: { pageNumber: number }) => e.pageNumber === pageNumber && resolve(),
        { signal: ac.signal },
      );
      setTimeout(resolve, 4000);
    });
    ac.abort();
  }

  #dispatchParam(type: number, value: unknown) {
    this.eventBus.dispatch("switchannotationeditorparams", { source: this, type, value });
  }

  /** Push the current defaults for `tool` into pdf.js (after a mode switch they are reset). */
  #applyToolDefaults(tool: Tool) {
    // pdf.js applies parameters to the selection when there is one, and an
    // annotation made with the previous tool can survive a direct tool switch.
    // (unselectAll first commits an active editor, so it may need two calls.)
    for (let i = 0; i < 3 && this.#ui?.hasSelection; i++) this.#ui.unselectAll();
    for (const key of TOOL_PARAMS[tool]) {
      const type = PARAM_KEYS.find(([, k]) => k === key)![0];
      this.#dispatchParam(type, toPdfjs(key, this.#params[key]));
    }
  }

  /**
   * A tool option changed: restyle the selected annotations if any,
   * otherwise change the default for new ones.
   */
  #setParam(key: keyof ToolParams, value: string | number) {
    const type = PARAM_KEYS.find(([, k]) => k === key)![0];
    if (!this.#ui?.hasSelection) (this.#params as unknown as Record<string, unknown>)[key] = value;
    (this.#shown as unknown as Record<string, unknown>)[key] = value;
    this.#dispatchParam(type, toPdfjs(key, value));
    this.#renderTool();
  }

  // ------------------------------------------------------------ rendering

  #renderTitle() {
    const name = this.fileName || "Untitled";
    $("docTitle").innerHTML = "";
    $("docTitle").append(
      Object.assign(document.createElement("span"), { className: "name", textContent: name, title: name }),
    );
    if (this.dirty) {
      $("docTitle").append(
        Object.assign(document.createElement("span"), { className: "dirty", title: "Unsaved changes", textContent: "●" }),
      );
    }
    document.title = this.doc ? `${this.dirty ? "• " : ""}${name} — Palimpsest` : "Palimpsest";
  }

  #renderTool() {
    for (const b of document.querySelectorAll<HTMLElement>(".toolbar .tool")) {
      const on = b.dataset.tool === this.#tool;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
    }
    const opts = $("toolOptions");
    opts.hidden = this.#tool === "none";
    for (const o of opts.querySelectorAll<HTMLElement>(".opt")) {
      o.hidden = !o.dataset.for!.split(" ").includes(this.#tool);
    }
    const shown = this.#shown;
    if (this.#tool === "text" || this.#tool === "ink") {
      $<HTMLInputElement>("optColor").value = normalizeHex(this.#tool === "text" ? shown.textColor : shown.inkColor);
    }
    $<HTMLInputElement>("optFontSize").value = String(shown.textSize);
    $<HTMLInputElement>("optThickness").value = String(shown.inkThickness);
    $<HTMLInputElement>("optOpacity").value = String(shown.inkOpacity);
    $<HTMLInputElement>("optHlThickness").value = String(shown.highlightThickness);
    for (const s of document.querySelectorAll<HTMLElement>("#toolOptions .swatch")) {
      const on = s.dataset.color!.toLowerCase() === shown.highlightColor.toLowerCase();
      s.classList.toggle("active", on);
      s.setAttribute("aria-checked", String(on));
    }
    $("viewerContainer").dataset.tool = this.#tool;
  }

  #renderUndo() {
    const undo = $<HTMLButtonElement>("btnUndo");
    const redo = $<HTMLButtonElement>("btnRedo");
    undo.disabled = !(this.#editor.hasSomethingToUndo || this.history.canUndo);
    redo.disabled = !(this.#editor.hasSomethingToRedo || this.history.canRedo);
    undo.title = this.#editor.hasSomethingToUndo
      ? "Undo annotation edit (Ctrl+Z)"
      : this.history.undoLabel
        ? `Undo ${this.history.undoLabel} (Ctrl+Z)`
        : "Undo (Ctrl+Z)";
    redo.title = this.#editor.hasSomethingToRedo
      ? "Redo annotation edit (Ctrl+Shift+Z)"
      : this.history.redoLabel
        ? `Redo ${this.history.redoLabel} (Ctrl+Shift+Z)`
        : "Redo (Ctrl+Shift+Z)";
  }

  #renderSelection(sel: number[]) {
    $("selectionInfo").textContent = sel.length > 1 ? `${sel.length} pages selected` : "";
  }

  #renderZoom(scale: number, preset?: string) {
    const select = $<HTMLSelectElement>("zoomSelect");
    const custom = $<HTMLOptionElement>("zoomCustom");
    const match = [...select.options].find((o) => o !== custom && (o.value === preset || Number(o.value) === scale));
    if (match && (preset || !Number.isNaN(Number(match.value)))) {
      custom.hidden = true;
      select.value = match.value;
    } else {
      custom.hidden = false;
      custom.textContent = `${Math.round(scale * 100)}%`;
      select.value = "custom";
    }
  }

  #setSidebar(open: boolean) {
    $("app").classList.toggle("sidebar-open", open);
    $("btnSidebar").setAttribute("aria-pressed", String(open));
    writePref("sidebar", open ? "open" : "closed");
    this.#refit();
  }

  /** Re-apply fit-to-width style zoom presets after the viewport changes size. */
  #refit() {
    const v = this.viewer.currentScaleValue;
    if (this.doc && v && Number.isNaN(Number(v))) requestAnimationFrame(() => (this.viewer.currentScaleValue = v));
  }

  async #withBusy(label: string, fn: () => Promise<void>) {
    this.#busy = true;
    const busy = $("busy");
    $("busyLabel").textContent = label;
    // Block input at once; only show the spinner if the work takes a moment.
    busy.classList.add("quiet");
    busy.hidden = false;
    const timer = setTimeout(() => busy.classList.remove("quiet"), 150);
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof ops.UserError)) console.error(e);
      toast(errorText(e), "error");
    } finally {
      clearTimeout(timer);
      busy.hidden = true;
      this.#busy = false;
    }
  }

  // --------------------------------------------------------------- wiring

  #wireViewerEvents() {
    const bus = this.eventBus;
    bus.on("pagesinit", () => {
      const v = this.#pendingView ?? { page: 1, scale: "auto" };
      this.viewer.currentScaleValue = v.scale;
      if (v.page > 1) this.viewer.currentPageNumber = v.page;
      this.#pendingView = null;
    });
    bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      $<HTMLInputElement>("pageNumber").value = String(pageNumber);
      this.thumbs.setCurrent(pageNumber - 1);
      $<HTMLButtonElement>("btnPrev").disabled = pageNumber <= 1;
      $<HTMLButtonElement>("btnNext").disabled = pageNumber >= this.pageCount;
    });
    bus.on("scalechanging", ({ scale, presetValue }: { scale: number; presetValue?: string }) =>
      this.#renderZoom(scale, presetValue),
    );
    bus.on("annotationeditoruimanager", ({ uiManager }: { uiManager: UIManager }) => {
      this.#ui = uiManager;
    });
    bus.on("editingstateschanged", ({ details }: { details: EditorStates }) => {
      const hadSelection = this.#editor.hasSelectedEditor;
      this.#editor = { ...details };
      if (hadSelection && !details.hasSelectedEditor) {
        this.#shown = { ...this.#params };
        this.#renderTool();
      }
      this.#renderUndo();
    });
    bus.on("switchannotationeditormode", (evt: { mode: number }) => {
      // Requests from pdf.js itself, e.g. double-clicking an existing annotation.
      this.viewer.annotationEditorMode = evt;
    });
    bus.on("annotationeditormodechanged", ({ mode }: { mode: number }) => {
      this.#tool = TOOL_OF_MODE.get(mode) ?? "none";
      this.#renderTool();
    });
    bus.on("annotationeditorparamschanged", ({ details }: { details: [number, unknown][] }) => {
      // pdf.js reports its own class defaults on mode switches; only mirror
      // values that describe a selected annotation.
      if (!this.#ui?.hasSelection) return;
      for (const [type, value] of details) {
        const key = PARAM_KEYS.find(([t]) => t === type)?.[1];
        if (key) (this.#shown as unknown as Record<string, unknown>)[key] = fromPdfjs(key, value);
      }
      this.#renderTool();
    });
  }

  #wireToolbar() {
    const on = (id: string, fn: () => unknown) => $(id).addEventListener("click", () => void fn());
    on("btnSidebar", () => this.#setSidebar(!$("app").classList.contains("sidebar-open")));
    on("btnOpen", () => this.open());
    on("btnOpenEmpty", () => this.open());
    on("btnSave", () => this.save());
    on("btnSaveAs", () => this.save(true));
    on("btnPrint", () => this.print());
    on("btnPrev", () => this.viewer.previousPage());
    on("btnNext", () => this.viewer.nextPage());
    on("btnZoomIn", () => this.viewer.increaseScale());
    on("btnZoomOut", () => this.viewer.decreaseScale());
    on("btnUndo", () => this.undo());
    on("btnRedo", () => this.redo());
    on("btnFind", () => this.#openFind());
    on("btnProps", () => this.editProperties());
    on("btnAddImage", () => this.addImage());
    on("pgRotL", () => this.rotate(-90));
    on("pgRotR", () => this.rotate(90));
    on("pgDup", () => this.duplicatePages());
    on("pgBlank", () => this.insertBlank());
    on("pgInsert", () => this.pickAndInsert());
    on("pgExtract", () => this.extractPages());
    on("pgDelete", () => this.deletePages());

    for (const b of document.querySelectorAll<HTMLElement>(".toolbar .tool")) {
      b.addEventListener("click", () => void this.setTool(b.dataset.tool as Tool));
    }
    for (const s of document.querySelectorAll<HTMLElement>("#toolOptions .swatch")) {
      s.addEventListener("click", () => this.#setParam("highlightColor", s.dataset.color!));
    }
    $<HTMLInputElement>("optColor").addEventListener("input", (e) => {
      const color = (e.target as HTMLInputElement).value;
      if (this.#tool === "text") this.#setParam("textColor", color);
      else if (this.#tool === "ink") this.#setParam("inkColor", color);
    });
    const num = (id: string, key: keyof ToolParams) =>
      $<HTMLInputElement>(id).addEventListener("input", (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(v) && v > 0) this.#setParam(key, v);
      });
    num("optFontSize", "textSize");
    num("optThickness", "inkThickness");
    num("optOpacity", "inkOpacity");
    num("optHlThickness", "highlightThickness");

    const pageInput = $<HTMLInputElement>("pageNumber");
    pageInput.addEventListener("change", () => {
      const n = Number.parseInt(pageInput.value, 10);
      if (n >= 1 && n <= this.pageCount) this.viewer.currentPageNumber = n;
      else pageInput.value = String(this.page);
    });
    pageInput.addEventListener("focus", () => pageInput.select());
    $<HTMLSelectElement>("zoomSelect").addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v !== "custom") this.viewer.currentScaleValue = v;
    });
    $("fileInput").addEventListener("change", async (e) => {
      // Direct use of the hidden input (e.g. automation, or browsers without the picker API).
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file || input.dataset.picking || this.#busy) return;
      input.value = "";
      if (await this.confirmDiscard()) await this.openFile(await files.fromFile(file));
    });
  }

  // ----------------------------------------------------------------- find

  #openFind() {
    if (!this.doc) return;
    const bar = $("findbar");
    bar.hidden = false;
    const input = $<HTMLInputElement>("findInput");
    const selected = window.getSelection()?.toString().trim();
    if (selected && selected.length < 200 && !selected.includes("\n")) input.value = selected;
    input.focus();
    input.select();
    if (input.value) this.#find("");
  }

  #closeFind() {
    $("findbar").hidden = true;
    this.eventBus.dispatch("findbarclose", { source: this });
    $("viewerContainer").focus();
  }

  #find(type: string, findPrevious = false) {
    this.eventBus.dispatch("find", {
      source: this,
      type,
      query: $<HTMLInputElement>("findInput").value,
      caseSensitive: $<HTMLInputElement>("findCase").checked,
      entireWord: $<HTMLInputElement>("findWord").checked,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  }

  #wireFind() {
    const input = $<HTMLInputElement>("findInput");
    input.addEventListener("input", () => this.#find(""));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#find("again", e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.#closeFind();
      }
    });
    $("findNext").addEventListener("click", () => this.#find("again"));
    $("findPrev").addEventListener("click", () => this.#find("again", true));
    $("findClose").addEventListener("click", () => this.#closeFind());
    $("findCase").addEventListener("change", () => this.#find("casesensitivitychange"));
    $("findWord").addEventListener("change", () => this.#find("entirewordchange"));

    const status = $("findStatus");
    const showCount = ({ current, total }: { current: number; total: number }) => {
      status.textContent = total ? `${current} of ${total}` : "";
    };
    this.eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
      showCount(matchesCount),
    );
    this.eventBus.on(
      "updatefindcontrolstate",
      ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => {
        input.classList.toggle("not-found", state === FindState.NOT_FOUND);
        if (state === FindState.NOT_FOUND) status.textContent = input.value ? "No matches" : "";
        else if (state === FindState.PENDING) status.textContent = "Searching…";
        else showCount(matchesCount);
      },
    );
  }

  // ------------------------------------------------------------- keyboard

  #wireKeyboard() {
    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const typing = isTyping(document.activeElement);
      const inThumbs = $("thumbs").contains(document.activeElement);
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (mod && key === "o") return handled(), void this.open();
      if (!this.doc) return;
      if (mod && key === "s") return handled(), void this.save(e.shiftKey);
      if (mod && key === "p") return handled(), void this.print();
      if (mod && key === "f") return handled(), this.#openFind();
      if (mod && (key === "=" || key === "+")) return handled(), this.viewer.increaseScale();
      if (mod && key === "-") return handled(), this.viewer.decreaseScale();
      if (mod && key === "0") return handled(), (this.viewer.currentScaleValue = "auto");
      if (e.key === "F4") return handled(), this.#setSidebar(!$("app").classList.contains("sidebar-open"));
      if (typing) return;

      const editorOwnsUndo = this.#tool !== "none";
      if (mod && key === "z" && !e.shiftKey) {
        if (editorOwnsUndo && this.#editor.hasSomethingToUndo) return; // pdf.js handles it
        return handled(), void this.undo();
      }
      if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
        if (editorOwnsUndo && this.#editor.hasSomethingToRedo) return;
        return handled(), void this.redo();
      }
      if (inThumbs && (e.key === "Delete" || e.key === "Backspace")) return handled(), void this.deletePages();
      if (inThumbs && mod && key === "d") return handled(), void this.duplicatePages();
      if (e.key === "Escape") {
        if (!$("findbar").hidden) return handled(), this.#closeFind();
        if (this.#tool !== "none" && !this.#editor.hasSelectedEditor) return handled(), void this.setTool("none");
        if (inThumbs) return handled(), this.thumbs.clearSelection();
      }
      if (!mod && !e.altKey && TOOL_KEYS[key] && !this.#editor.hasSelectedEditor) {
        return handled(), void this.setTool(TOOL_KEYS[key]);
      }
    });
  }

  // ----------------------------------------------------------- drag/drop

  #wireDragAndDrop() {
    const hint = $("dropHint");
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    document.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      depth++;
      hint.textContent = this.doc ? "Drop to open · drop on the page list to insert" : "Drop to open";
      hint.hidden = false;
    });
    document.addEventListener("dragleave", (e) => {
      if (hasFiles(e) && --depth <= 0) {
        depth = 0;
        hint.hidden = true;
      }
    });
    document.addEventListener("dragover", (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    document.addEventListener("drop", async (e) => {
      depth = 0;
      hint.hidden = true;
      const file = [...(e.dataTransfer?.files ?? [])].find(files.looksLikePdf);
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!file) return toast("That is not a PDF file.", "error");
      if (this.#busy || !(await this.confirmDiscard())) return;
      await this.openFile(await files.fromFile(file));
    });
    // Thumbnail drops stop propagation, so the hint must be cleared there too.
    $("thumbs").addEventListener("drop", () => {
      depth = 0;
      hint.hidden = true;
    });
  }

  #onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey) || !this.doc) return;
    e.preventDefault();
    const factor = Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) / 100);
    this.viewer.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY] });
  }
}

// ------------------------------------------------------------------ helpers

/** <input type=color> only accepts #rrggbb. */
function normalizeHex(color: string) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "#000000";
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function toast(message: string, kind: "info" | "error" = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = message;
  $("toasts").append(el);
  setTimeout(() => el.classList.add("leaving"), kind === "error" ? 6000 : 2600);
  setTimeout(() => el.remove(), kind === "error" ? 6400 : 3000);
}

function showDialog(dialog: HTMLDialogElement): Promise<string> {
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
}

async function confirmDialog(title: string, message: string, ok: string) {
  $("confirmTitle").textContent = title;
  $("confirmMsg").textContent = message;
  $("confirmOk").textContent = ok;
  return (await showDialog($<HTMLDialogElement>("confirmDialog"))) === "ok";
}

function readPref(key: string) {
  try {
    return localStorage.getItem(`palimpsest:${key}`);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`palimpsest:${key}`, value);
  } catch {
    /* storage unavailable */
  }
}
