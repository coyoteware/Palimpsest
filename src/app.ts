import "pdfjs-dist/web/pdf_viewer.css";
import { AnnotationEditorParamsType as P, AnnotationEditorType as T, AnnotationMode, PDFDateString } from "pdfjs-dist";
import {
  EventBus,
  FindState,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFScriptingManager,
  PDFViewer,
  ScrollMode,
  SpreadMode,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import { desktop, type RecentFile } from "./desktop";
import { describePermissions, fontInfo, uniqueFonts, yesNo, type FontInfo } from "./docinfo";
import * as files from "./files";
import { DocHistory, type Snapshot } from "./history";
import { icon } from "./icons";
import { checkRadio, closeMenus, menuIsOpen, wireMenu } from "./menu";
import * as comments from "./comments";
import * as marks from "./marks";
import type { EditorData, Markup, Shape } from "./marks";
import { NavHistory, type Place } from "./navhistory";
import * as ops from "./pageops";
import { collectComments, commentKind, Panels, renderComments, useIcons, type Attachment, type CommentItem } from "./panels";
import { PDFJS_ASSETS, openPdf, type PDFDocumentProxy } from "./pdfjs";
import { printPdf, type PrintOptions } from "./print";
import { askSignature, forgetSignatures, savedSignatures, type SavedSignature } from "./signatures";
import { Thumbnails } from "./thumbnails";

const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;

/**
 * The toolbar's tools. Text, draw, highlight and image are pdf.js's own
 * editors; the others leave pdf.js in its plain mode and handle the pointer
 * here, creating pdf.js editors (ink, text, images) from what the user does.
 */
type Tool = "none" | "hand" | "zoom" | "snapshot" | "text" | "note" | "ink" | "shape" | "highlight" | "markup" | "image" | "sign";
const MODE: Record<Tool, number> = {
  none: T.NONE,
  hand: T.NONE,
  zoom: T.NONE,
  snapshot: T.NONE,
  text: T.FREETEXT,
  note: T.NONE,
  ink: T.INK,
  shape: T.NONE,
  highlight: T.HIGHLIGHT,
  markup: T.NONE,
  image: T.STAMP,
  sign: T.NONE,
};
const TOOL_OF_MODE = new Map<number, Tool>([
  [T.NONE, "none"],
  [T.FREETEXT, "text"],
  [T.INK, "ink"],
  [T.HIGHLIGHT, "highlight"],
  [T.STAMP, "image"],
]);
/** Tools that work by dragging or clicking on a page (rather than selecting text). */
const POINTER_TOOLS: ReadonlySet<Tool> = new Set(["hand", "zoom", "snapshot", "note", "shape", "sign"]);
const TOOL_KEYS: Record<string, Tool> = {
  v: "none",
  z: "zoom",
  t: "text",
  n: "note",
  d: "ink",
  s: "shape",
  h: "highlight",
  u: "markup",
  i: "image",
  g: "sign",
};
const HIGHLIGHT_COLORS = "yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F";

interface UIManager {
  undo(): void;
  redo(): void;
  commitOrRemove(): void;
  unselectAll(): void;
  readonly hasSelection: boolean;
  getLayer(pageIndex: number): EditorLayer | undefined;
  addCommands(params: { cmd: () => void; undo: () => void; mustExec: boolean }): void;
}

/** pdf.js's annotation editor layer for one page (the parts used here). */
interface EditorLayer {
  readonly div: HTMLElement;
  deserialize(data: EditorData): Promise<Editor | null>;
  addOrRebuild(editor: Editor): void;
}

interface Editor {
  remove(): void;
}

/** An open document. The showing one's state lives in the app's fields; the others keep it here. */
interface Tab {
  id: number;
  name: string;
  target: files.SaveTarget | null;
  password: string | undefined;
  dirty: boolean;
  history: DocHistory;
  /** The file as it was left, pending edits folded in (null while it is the one showing). */
  bytes: Uint8Array | null;
  view: { page: number; scale: string; rotation: number };
}

/** Where a pointer event landed on a page: CSS pixels from the page's top left. */
interface PageHit {
  el: HTMLElement;
  pageIndex: number;
  x: number;
  y: number;
  rect: DOMRect;
}

/** What the Fill & Sign tool puts down where the user clicks next. */
type Placing =
  | { kind: "mark"; mark: marks.Mark }
  | { kind: "date" }
  | { kind: "image"; signature: SavedSignature };

/** Defaults for new annotations; what the tool options show when nothing is selected. */
interface ToolParams {
  textColor: string;
  textSize: number;
  inkColor: string;
  inkThickness: number;
  inkOpacity: number;
  highlightColor: string;
  highlightThickness: number;
  shapeKind: Shape;
  shapeColor: string;
  shapeThickness: number;
  shapeOpacity: number;
  markupKind: Markup;
  markupColor: string;
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
/** The pdf.js parameters each pdf.js tool starts with. */
const TOOL_PARAMS: Record<Tool, (keyof ToolParams)[]> = {
  none: [],
  hand: [],
  zoom: [],
  snapshot: [],
  text: ["textColor", "textSize"],
  note: [],
  ink: ["inkColor", "inkThickness", "inkOpacity"],
  shape: [],
  highlight: ["highlightColor", "highlightThickness"],
  markup: [],
  image: [],
  sign: [],
};
/** Which parameter the shared colour, width and opacity controls set, per tool. */
const COLOR_KEY: Partial<Record<Tool, keyof ToolParams>> = { text: "textColor", ink: "inkColor", shape: "shapeColor", markup: "markupColor" };
const WIDTH_KEY: Partial<Record<Tool, keyof ToolParams>> = { ink: "inkThickness", shape: "shapeThickness" };
const OPACITY_KEY: Partial<Record<Tool, keyof ToolParams>> = { ink: "inkOpacity", shape: "shapeOpacity" };
const toPdfjs = (key: keyof ToolParams, v: string | number) => (key === "inkOpacity" ? Number(v) / 100 : v);
const pdfjsParam = (key: keyof ToolParams) => PARAM_KEYS.find(([, k]) => k === key)?.[0];
const fromPdfjs = (key: keyof ToolParams, v: unknown) =>
  key === "inkOpacity" ? Math.round(Number(v) * 100) : typeof v === "number" ? v : String(v);

interface EditorStates {
  isEditing?: boolean;
  hasSomethingToUndo?: boolean;
  hasSomethingToRedo?: boolean;
  hasSelectedEditor?: boolean;
}

/** One file in the merge list: a picked file, or the open document as it is now. */
type MergeEntry = { name: string; file: files.OpenedFile | null };

/** Another PDF, open in pdf.js, to take pages from (an `ops.ExtraDoc`). */
type Source = { doc: PDFDocumentProxy; data: Uint8Array; password?: string };

interface LoadOptions {
  /** A different file (resets history, save target, password). */
  fresh?: { name: string; target: files.SaveTarget | null };
  page?: number;
  /** Zoom and view rotation (otherwise a fresh file starts at "auto" and 0, a reload keeps them). */
  scale?: string;
  rotation?: number;
  selection?: number[];
}

/** Page layouts in the View menu ↔ pdf.js scroll and spread modes. */
const SCROLL_MODES = { vertical: ScrollMode.VERTICAL, page: ScrollMode.PAGE, wrapped: ScrollMode.WRAPPED, horizontal: ScrollMode.HORIZONTAL };
const SPREAD_MODES = { none: SpreadMode.NONE, odd: SpreadMode.ODD, even: SpreadMode.EVEN };
type ScrollName = keyof typeof SCROLL_MODES;
type SpreadName = keyof typeof SPREAD_MODES;
const nameOf = <K extends string>(modes: Record<K, number>, mode: number) =>
  (Object.entries(modes) as [K, number][]).find(([, m]) => m === mode)?.[0];

/** Where the view was before presentation mode, to go back to. */
interface ViewBeforePresenting {
  scroll: number;
  spread: number;
  scale: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const dialogOpen = () => document.querySelector("dialog[open]") !== null;

const isTyping = (el: Element | null) =>
  !!el && (el.matches("input, textarea, select, [contenteditable=''], [contenteditable='true']") || !!el.closest("[contenteditable='true']"));

export class App {
  readonly eventBus = new EventBus();
  readonly linkService: PDFLinkService;
  readonly findController: PDFFindController;
  readonly viewer: PDFViewer;
  /** Runs the document's JavaScript: calculated, formatted and validated form fields. */
  readonly scripting: PDFScriptingManager;
  readonly thumbs: Thumbnails;
  /** Document-level undo for the document showing (each tab keeps its own). */
  history = new DocHistory();
  /** Back / forward through link, bookmark and page-number jumps. */
  readonly nav: NavHistory;
  readonly panels: Panels;

  doc: PDFDocumentProxy | null = null;
  /** Page labels ("iv", "A-3"), or null when the pages are just numbered. */
  #labels: string[] | null = null;
  #presenting: ViewBeforePresenting | null = null;
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
  #pendingView: { page: number; scale: string; rotation: number } | null = null;
  #params: ToolParams = {
    textColor: "#000000",
    textSize: 12,
    inkColor: "#1d4ed8",
    inkThickness: 2,
    inkOpacity: 100,
    highlightColor: "#FFFF98",
    highlightThickness: 12,
    shapeKind: "rect",
    shapeColor: "#e5484d",
    shapeThickness: 2,
    shapeOpacity: 100,
    markupKind: "underline",
    markupColor: "#e5484d",
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
    this.scripting = new PDFScriptingManager({
      eventBus: this.eventBus,
      sandboxBundleSrc: PDFJS_ASSETS.sandboxBundleSrc,
      // Supported by the component but missing from its type declarations.
      ...({ wasmUrl: PDFJS_ASSETS.wasmUrl } as object),
    });
    this.viewer = new PDFViewer({
      container,
      viewer: $<HTMLDivElement>("viewer"),
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      scriptingManager: this.scripting,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: T.NONE,
      annotationEditorHighlightColors: HIGHLIGHT_COLORS,
      imageResourcesPath: PDFJS_ASSETS.imageResourcesPath,
      // Supported by the viewer but missing from its type declarations.
      ...({ enableHighlightFloatingButton: true } as object),
    });
    this.linkService.setViewer(this.viewer);
    this.scripting.setViewer(this.viewer);
    this.nav = new NavHistory(
      (place) => this.#goTo(place),
      () => this.#renderNav(),
    );
    // PDFLinkService records link and bookmark jumps through this.
    this.linkService.setHistory(this.nav as unknown as Parameters<PDFLinkService["setHistory"]>[0]);

    this.thumbs = new Thumbnails($("thumbs"), {
      navigate: (i) => (this.viewer.currentPageNumber = i + 1),
      move: (pages, before) => void this.movePages(pages, before),
      insertFiles: (list, before) => void this.insertFiles(list, before),
      selectionChanged: (sel) => this.#renderSelection(sel),
    });

    useIcons(icon);
    this.panels = new Panels(this.linkService, this.viewer, {
      saveAttachment: (file) => void this.saveAttachment(file),
      tabsChanged: () => this.#showPanel(readPref("panel") ?? "panelPages", false),
    });

    this.#wireViewerEvents();
    this.#wireToolbar();
    this.#wireFind();
    this.#wireKeyboard();
    this.#wireDragAndDrop();
    this.#wireDialogs();
    this.#wireViewMenu();
    this.#wireSidebar();
    this.#wirePageTools();
    this.#wireSignMenu();
    this.#wireRecent();
    this.#wireTabs();
    wrapFocus();
    this.#wirePresentation();
    container.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    window.addEventListener("beforeunload", (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = ""; // WebKit still looks at this
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

  /** Open a file in a new tab (or show the tab it is already open in). */
  async openFile(file: files.OpenedFile) {
    const path = file.target?.path;
    const already = path ? this.#tabs.find((t) => this.#tabTarget(t)?.path === path) : undefined;
    if (already) {
      await this.activateTab(already);
      return true;
    }
    // Back where the reader left off last time.
    await this.#recentReady;
    const last = path ? this.#recent.find((r) => r.path === path) : undefined;
    const ok = await this.#openInNewTab(file.bytes, { name: file.name, target: file.target }, { page: last?.page, scale: last?.zoom });
    if (ok && path) await this.#remember(path);
    return ok;
  }

  // ----------------------------------------------------------------- tabs

  #tabs: Tab[] = [];
  #active: Tab | null = null;
  #tabIds = 0;

  get tabCount() {
    return this.#tabs.length;
  }

  /** The tab's save target; the showing tab's lives in the app's own fields. */
  #tabTarget(tab: Tab) {
    return tab === this.#active ? this.target : tab.target;
  }

  /** Load `bytes` as a new document in a new tab after the current one. */
  async #openInNewTab(bytes: Uint8Array, fresh: NonNullable<LoadOptions["fresh"]>, at: { page?: number; scale?: string } = {}) {
    const prev = this.#active;
    const undoPoint = prev ? await this.#stash(prev) : null;
    if (!(await this.#load(bytes, { fresh, page: at.page, scale: at.scale }))) {
      if (prev) prev.bytes = null; // still showing, as it was
      return false;
    }
    if (prev && undoPoint) prev.history.push(undoPoint);
    const tab: Tab = {
      id: ++this.#tabIds,
      name: fresh.name,
      target: fresh.target,
      password: this.#password,
      dirty: false,
      history: this.history,
      bytes: null,
      view: { page: 1, scale: "auto", rotation: 0 },
    };
    this.#tabs.splice(prev ? this.#tabs.indexOf(prev) + 1 : this.#tabs.length, 0, tab);
    this.#active = tab;
    this.#renderTabs();
    return true;
  }

  /**
   * Put the showing document away in its tab: the file as it would be saved
   * (pending annotation and form edits folded in), its view and its state.
   * Returns an undo step for those edits, to add once the switch succeeds.
   */
  async #stash(tab: Tab): Promise<Snapshot | null> {
    const doc = this.#requireDoc();
    if (this.presenting) await this.present(false);
    if (!$("findbar").hidden) this.#closeFind();
    closeMenus();
    if (this.#tool !== "none") await this.setTool("none");
    const pending = this.#annotDirty;
    const bytes = await this.currentBytes();
    const undoPoint = pending ? { bytes: await doc.getData(), label: "annotation and form edits", page: this.page } : null;
    Object.assign(tab, {
      name: this.fileName,
      target: this.target,
      password: this.#password,
      dirty: this.dirty,
      history: this.history,
      bytes,
      view: { page: this.page, scale: this.viewer.currentScaleValue || "auto", rotation: this.viewer.pagesRotation },
    });
    return undoPoint;
  }

  /** Show another tab's document. With `closing`, the showing one is closed, not kept. */
  async activateTab(tab: Tab, closing = false) {
    if (tab === this.#active || !this.#tabs.includes(tab) || this.#busy) return;
    const prev = this.#active;
    await this.#withBusy("Opening…", async () => {
      const undoPoint = prev && !closing ? await this.#stash(prev) : null;
      const before = { fileName: this.fileName, target: this.target, password: this.#password, history: this.history, docDirty: this.#docDirty };
      this.fileName = tab.name;
      this.target = tab.target;
      this.#password = tab.password;
      this.history = tab.history;
      this.#docDirty = tab.dirty;
      const { page, scale, rotation } = tab.view;
      if (!(await this.#load(tab.bytes!, { page, scale, rotation }))) {
        this.fileName = before.fileName;
        this.target = before.target;
        this.#password = before.password;
        this.history = before.history;
        this.#docDirty = before.docDirty;
        if (prev) prev.bytes = null;
        return;
      }
      if (prev && undoPoint) prev.history.push(undoPoint);
      if (prev && closing) this.#tabs.splice(this.#tabs.indexOf(prev), 1);
      tab.bytes = null;
      this.#active = tab;
      this.#renderTitle();
      this.#renderUndo();
    });
  }

  /** Close a tab (the showing one by default), asking first if it has unsaved changes. */
  async closeTab(tab = this.#active) {
    if (!tab || this.#busy) return;
    const active = tab === this.#active;
    const name = active ? this.fileName || "Untitled" : tab.name;
    if (
      (active ? this.dirty : tab.dirty) &&
      !(await confirmDialog("Close without saving?", `${name} has changes that have not been saved.`, "Close without saving"))
    ) {
      return;
    }
    if (!active) {
      this.#tabs.splice(this.#tabs.indexOf(tab), 1);
      return this.#renderTabs();
    }
    const i = this.#tabs.indexOf(tab);
    const next = this.#tabs[i + 1] ?? this.#tabs[i - 1];
    if (next) await this.activateTab(next, true);
    else await this.#unload();
  }

  /** Close the last document: back to the start screen. */
  async #unload() {
    const doc = this.doc;
    if (!doc) return;
    if (this.presenting) await this.present(false);
    if (!$("findbar").hidden) this.#closeFind();
    await this.setTool("none");
    await Promise.allSettled(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    this.viewer.setDocument(null as unknown as PDFDocumentProxy);
    this.linkService.setDocument(null as unknown as PDFDocumentProxy, null);
    await this.thumbs.setDocument(null);
    await this.panels.setDocument(null);
    this.doc = null;
    this.#tabs = [];
    this.#active = null;
    this.fileName = "";
    this.target = null;
    this.#password = undefined;
    this.history = new DocHistory();
    this.#docDirty = this.#annotDirty = false;
    this.#ui = null;
    this.#editor = {};
    this.nav.reset();
    $("app").classList.add("no-doc");
    this.#renderTitle();
    this.#renderUndo();
    await doc.loadingTask.destroy();
  }

  #renderTabs() {
    const bar = $("tabbar");
    // One document needs no tabs.
    bar.hidden = this.#tabs.length < 2;
    bar.replaceChildren(
      ...this.#tabs.map((t) => {
        const active = t === this.#active;
        const name = (active ? this.fileName : t.name) || "Untitled";
        const el = Object.assign(document.createElement("div"), { className: "doc-tab", tabIndex: active ? 0 : -1, title: this.#tabTarget(t)?.path ?? name });
        el.setAttribute("role", "tab");
        el.setAttribute("aria-selected", String(active));
        el.dataset.tab = String(t.id);
        el.append(Object.assign(document.createElement("span"), { className: "name", textContent: name }));
        if (active ? this.dirty : t.dirty) {
          el.append(Object.assign(document.createElement("span"), { className: "dirty", title: "Unsaved changes", textContent: "●" }));
        }
        const close = Object.assign(document.createElement("button"), { type: "button", className: "close", title: "Close (Ctrl+W)", tabIndex: -1 });
        close.setAttribute("aria-label", `Close ${name}`);
        close.innerHTML = icon("close");
        el.append(close);
        return el;
      }),
    );
  }

  #wireTabs() {
    const bar = $("tabbar");
    const tabOf = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".doc-tab");
      return el ? this.#tabs.find((t) => String(t.id) === el.dataset.tab) : undefined;
    };
    bar.addEventListener("click", (e) => {
      const tab = tabOf(e);
      if (!tab) return;
      if ((e.target as HTMLElement).closest(".close")) void this.closeTab(tab);
      else void this.activateTab(tab);
    });
    // Middle click closes, as in a browser.
    bar.addEventListener("auxclick", (e) => {
      const tab = tabOf(e);
      if (tab && e.button === 1) void this.closeTab(tab);
    });
    bar.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      void this.#cycleTab(e.key === "ArrowRight" ? 1 : -1, true);
    });
  }

  async #cycleTab(step: number, focus = false) {
    if (this.#tabs.length < 2 || !this.#active) return;
    const i = this.#tabs.indexOf(this.#active);
    await this.activateTab(this.#tabs[(i + step + this.#tabs.length) % this.#tabs.length]);
    if (focus) $("tabbar").querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }

  /** Add a file to the recent files list (the shell keeps it). */
  async #remember(path: string) {
    await desktop.addRecent(path).catch((e: unknown) => console.warn("recent files", e));
    await this.#loadRecent();
  }

  /** Recently opened files, as the shell last listed them. */
  #recent: RecentFile[] = [];

  async #loadRecent() {
    this.#recent = await desktop.recentFiles().catch(() => []);
    this.#renderRecent();
  }

  async openRecent(path: string) {
    if (this.#busy) return;
    try {
      await this.openFile(files.fromDesktop(await desktop.openRecent(path)));
    } catch (e) {
      toast(errorText(e), "error");
      await this.#loadRecent();
    }
  }

  /** The recent files on the start screen. */
  #renderRecent() {
    const list = $("recentList");
    list.replaceChildren(
      ...this.#recent.slice(0, 8).map((f) => {
        const li = document.createElement("li");
        const b = Object.assign(document.createElement("button"), { type: "button", className: "recent-file", title: f.path });
        b.append(
          Object.assign(document.createElement("span"), { className: "file-name", textContent: f.name }),
          Object.assign(document.createElement("span"), { className: "muted file-dir", textContent: dirName(f.path) }),
        );
        b.addEventListener("click", () => void this.openRecent(f.path));
        li.append(b);
        return li;
      }),
    );
    $("recentSection").hidden = this.#recent.length === 0;
  }

  #wireRecent() {
    wireMenu($("btnRecent"), {
      beforeOpen: (menu) => {
        const item = (label: string, data: Record<string, string>, title = "") => {
          const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title });
          b.setAttribute("role", "menuitem");
          Object.assign(b.dataset, data);
          return b;
        };
        const files = this.#recent.map((f) => item(f.name, { path: f.path }, f.path));
        menu.replaceChildren(
          ...(files.length ? files : [Object.assign(item("No recent files", {}), { disabled: true })]),
          Object.assign(document.createElement("hr"), { role: "separator" }),
          Object.assign(item("Clear recent files", { act: "clear" }), { disabled: !files.length }),
        );
      },
      choose: async (el) => {
        if (el.dataset.path) return void this.openRecent(el.dataset.path);
        if (el.dataset.act === "clear") {
          await desktop.forgetRecent().catch(() => {});
          await this.#loadRecent();
        }
      },
    });
    this.#recentReady = this.#loadRecent();
  }

  /** Settles once the recent files list has been read at startup. */
  #recentReady: Promise<void> = Promise.resolve();

  /** Remember where the reader is in the current file, to come back to it. */
  #savePosition() {
    const path = this.target?.path;
    if (!this.doc || !path || this.#presenting || this.#pendingView) return;
    clearTimeout(this.#positionTimer);
    this.#positionTimer = window.setTimeout(() => {
      if (this.target?.path !== path) return;
      const place = { page: this.page, zoom: this.viewer.currentScaleValue || "auto" };
      void desktop.addRecent(path, place).catch(() => {});
      const entry = this.#recent.find((r) => r.path === path);
      if (entry) Object.assign(entry, place);
    }, 400);
  }

  #positionTimer = 0;

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
    if (old) {
      // The viewer fills its page slots from getPage() requests that may still
      // be in flight; if they land after it switches documents, pdf.js throws.
      // getPage() returns those same cached requests, so let them settle (and
      // their callbacks run) first.
      await Promise.allSettled(Array.from({ length: old.numPages }, (_, i) => old.getPage(i + 1)));
      await new Promise((resolve) => setTimeout(resolve));
    }
    const doc = (this.doc = opened.doc);
    this.#password = opened.password;
    if (opts.fresh) {
      this.fileName = opts.fresh.name;
      this.target = opts.fresh.target;
      // A new object: another tab may hold the old one.
      this.history = new DocHistory();
      this.#docDirty = false;
    }
    this.#annotDirty = false;
    this.#ui = null;
    this.#editor = {};
    this.#tool = "none";
    const view = (this.#pendingView = {
      page: Math.min(opts.page ?? 1, doc.numPages),
      scale: opts.scale ?? (opts.fresh ? "auto" : this.viewer.currentScaleValue || "auto"),
      rotation: opts.rotation ?? (opts.fresh ? 0 : this.viewer.pagesRotation),
    });
    this.nav.reset();
    this.#labels = null;
    const storage = doc.annotationStorage as unknown as {
      onSetModified: (() => void) | null;
      onResetModified: (() => void) | null;
    };
    storage.onSetModified = () => {
      this.#annotDirty = true;
      this.#renderTitle();
      this.#commentsChanged();
    };
    storage.onResetModified = () => {
      this.#annotDirty = false;
      this.#renderTitle();
    };

    this.viewer.setDocument(doc);
    this.linkService.setDocument(doc, null);
    const labels = await pageLabels(doc);
    if (this.doc !== doc) return false; // another load overtook this one
    this.#labels = labels;
    this.viewer.setPageLabels(labels);
    void this.thumbs.setDocument(doc, { current: view.page - 1, selection: opts.selection, labels });
    void this.panels.setDocument(doc);
    this.#commentsChanged();
    if (old) await old.loadingTask.destroy();

    $("app").classList.remove("no-doc");
    this.#renderPageNumber(view.page);
    this.#renderTitle();
    this.#renderTool();
    this.#renderUndo();
    return true;
  }

  async #askPassword(incorrect: boolean, name?: string): Promise<string | null> {
    const dialog = $<HTMLDialogElement>("passwordDialog");
    const input = $<HTMLInputElement>("passwordInput");
    $("passwordMsg").textContent = incorrect
      ? `That password is not correct${name ? ` for ${name}` : ""}. Try again.`
      : name
        ? `${name} is protected. Enter its password.`
        : "This PDF is protected. Enter its password to open it.";
    input.value = "";
    const result = await showDialog(dialog);
    return result === "ok" ? input.value : null;
  }

  // ----------------------------------------------------------- file ops

  async open() {
    if (this.#busy) return;
    try {
      const [file] = await files.pickPdfs();
      if (file) await this.openFile(file);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  /** Before the window closes: ask if any open document has unsaved changes. */
  async confirmDiscard() {
    const dirty = this.#tabs.length
      ? this.#tabs.filter((t) => (t === this.#active ? this.dirty : t.dirty)).map((t) => (t === this.#active ? this.fileName : t.name) || "Untitled")
      : this.dirty
        ? [this.fileName]
        : [];
    if (!dirty.length) return true;
    const what = dirty.length === 1 ? `${dirty[0]} has` : `${listNames(dirty)} have`;
    return confirmDialog("Discard unsaved changes?", `${what} changes that have not been saved.`, "Discard");
  }

  async save(saveAs = false) {
    if (!this.doc || this.#busy) return;
    await this.#withBusy("Saving…", async () => {
      const bytes = await this.currentBytes();
      if (this.target && !saveAs) {
        await this.target.write(bytes);
      } else {
        const target = await files.saveAs(this.fileName || "document.pdf", bytes);
        if (!target) return; // cancelled
        this.target = target;
        this.fileName = target.name;
        if (target.path) void this.#remember(target.path);
      }
      this.#docDirty = false;
      this.#annotDirty = false;
      this.#renderTitle();
      toast(`Saved ${this.fileName}`);
    });
  }

  /** Print, after asking which pages and how (the print dialog). */
  async print() {
    if (!this.doc || this.#busy) return;
    const opts = await this.#askPrint();
    if (!opts) return;
    await this.#withBusy("Preparing to print…", async () => {
      await printPdf(
        await this.currentBytes(),
        this.#password,
        (done, total) => {
          $("busyLabel").textContent = `Preparing to print… ${done}/${total}`;
        },
        opts,
      );
    });
  }

  /**
   * The "which pages" choice in the print and export dialogs (radio buttons
   * named `${prefix}Pages`, and a `${prefix}Range` field). Fills in the counts
   * and returns a function giving the chosen pages, 0-based, in order; it
   * throws a UserError for a range that is not valid.
   */
  #pageChoice(dialog: HTMLDialogElement, prefix: string) {
    const n = this.pageCount;
    const range = $<HTMLInputElement>(`${prefix}Range`);
    const radio = (value: string) => dialog.querySelector<HTMLInputElement>(`input[name="${prefix}Pages"][value="${value}"]`)!;
    const selection = this.thumbs.selection;
    const label = (i: number) => this.#labels?.[i] ?? String(i + 1);
    $(`${prefix}AllCount`).textContent = `(${plural(n, "page")})`;
    $(`${prefix}CurrentPage`).textContent = `(${label(this.page - 1)})`;
    $(`${prefix}SelectedChoice`).hidden = selection.length < 2;
    $(`${prefix}SelectedCount`).textContent = `(${plural(selection.length, "page")})`;
    if (radio("selected").checked && selection.length < 2) radio("all").checked = true;
    for (const r of dialog.querySelectorAll<HTMLInputElement>(`input[name="${prefix}Pages"]`)) r.autofocus = r.checked;
    const choose = () => {
      radio("range").checked = true;
      range.dispatchEvent(new Event("change", { bubbles: true }));
    };
    range.oninput = range.onfocus = choose;
    return {
      typed: () => range.value.trim() !== "",
      pages: (): number[] => {
        switch (dialog.querySelector<HTMLInputElement>(`input[name="${prefix}Pages"]:checked`)!.value) {
          case "current":
            return [this.page - 1];
          case "selected":
            return selection;
          case "range":
            return ops.parseRanges(range.value, n).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k));
          default:
            return Array.from({ length: n }, (_, i) => i);
        }
      },
    };
  }

  /** Run a dialog whose OK button is enabled while `check` (re-run on every change) does not throw. */
  async #choiceDialog(dialog: HTMLDialogElement, ok: HTMLButtonElement, preview: HTMLElement, describe: () => string, typed: () => boolean) {
    const update = () => {
      try {
        preview.textContent = describe();
        preview.classList.remove("error");
        ok.disabled = false;
      } catch (e) {
        preview.textContent = errorText(e);
        preview.classList.toggle("error", typed());
        ok.disabled = true;
      }
    };
    const ac = new AbortController();
    dialog.addEventListener("change", update, { signal: ac.signal });
    dialog.addEventListener("input", update, { signal: ac.signal });
    update();
    try {
      return (await showDialog(dialog)) === "ok";
    } finally {
      ac.abort();
    }
  }

  /** The print dialog: what to print, or null if cancelled. */
  async #askPrint(): Promise<PrintOptions | null> {
    const dialog = $<HTMLDialogElement>("printDialog");
    const choice = this.#pageChoice(dialog, "print");
    const chosen = (name: string) => dialog.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;
    const ok = await this.#choiceDialog(dialog, $<HTMLButtonElement>("printOk"), $("printPreview"), () => `${plural(choice.pages().length, "page")} to print`, choice.typed);
    if (!ok) return null;
    return {
      pages: choice.pages(),
      annotations: $<HTMLInputElement>("printComments").checked,
      size: chosen("printSize") as PrintOptions["size"],
    };
  }

  /** Save pages as PNG or JPEG images: one file, or one per page in a folder. */
  async exportImages() {
    const doc = this.doc;
    if (!doc || this.#busy) return;
    const dialog = $<HTMLDialogElement>("exportDialog");
    const choice = this.#pageChoice(dialog, "export");
    const format = () => dialog.querySelector<HTMLInputElement>('input[name="exportFormat"]:checked')!.value as "png" | "jpeg";
    const names = () => {
      const ext = format() === "png" ? "png" : "jpg";
      const base = (this.fileName || "document").replace(/\.pdf$/i, "");
      return choice.pages().map((i) => `${base}-p${i + 1}.${ext}`);
    };
    const ok = await this.#choiceDialog(
      dialog,
      $<HTMLButtonElement>("exportOk"),
      $("exportPreview"),
      () => {
        const list = names();
        return list.length === 1 ? `1 image: ${list[0]}` : `${plural(list.length, "image")}: ${summarise(list)}`;
      },
      choice.typed,
    );
    if (!ok) return;
    const pages = choice.pages();
    const list = names();
    const kind = format();
    const dpi = Number($<HTMLSelectElement>("exportDpi").value) || 150;
    let targets: files.SaveTarget[];
    let where = "";
    try {
      if (pages.length === 1) {
        // One image: the user names it. It is written once rendered.
        const chosen = await desktop.saveAs(list[0], kind);
        if (!chosen) return;
        targets = [{ name: chosen.name, write: (bytes) => desktop.write(chosen.path, bytes) }];
      } else {
        const dest = await files.saveToFolder(list, kind);
        if (!dest) return;
        const existing = dest.files.filter((f) => f.exists).map((f) => f.name);
        if (
          existing.length &&
          !(await confirmDialog("Replace existing files?", `${listNames(existing)} ${existing.length === 1 ? "is" : "are"} already in ${dest.folder}.`, "Replace"))
        ) {
          return;
        }
        targets = dest.files;
        where = ` in ${dest.folder}`;
      }
    } catch (e) {
      return toast(errorText(e), "error");
    }
    await this.#withBusy("Exporting…", async () => {
      await this.#withSavedDoc(async (source) => {
        for (const [k, index] of pages.entries()) {
          $("busyLabel").textContent = `Exporting… ${k + 1}/${pages.length}`;
          await targets[k].write(await renderImage(source, index, dpi, kind));
        }
      });
      toast(pages.length === 1 ? `Saved ${targets[0].name}` : `Saved ${plural(pages.length, "image")}${where}`);
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

  #structural(label: string, plan: ops.PlanPage[], extras: ops.ExtraDoc[] = [], after: { page?: number; selection?: number[] } = {}) {
    const doc = this.#requireDoc();
    if (extras.length === 0 && ops.isIdentity(plan, doc.numPages)) return Promise.resolve();
    return this.#edit(label, (current) => this.#assemble(plan, extras, current), after);
  }

  /**
   * Run `fn` on the document as it would be saved now. pdf.js's page
   * assembler takes new annotations from the pending edits but not changed
   * form values, so when anything is pending it works from the saved bytes
   * (`current`, or computed here) instead of the open document.
   */
  async #withSavedDoc<R>(fn: (doc: PDFDocumentProxy) => Promise<R>, current?: Uint8Array): Promise<R> {
    const doc = this.#requireDoc();
    if (doc.annotationStorage.size === 0) return fn(doc);
    const { doc: saved } = await openPdf(current ?? (await this.currentBytes()), { password: this.#password });
    try {
      return await fn(saved);
    } finally {
      await saved.loadingTask.destroy();
    }
  }

  /** Assemble pages from the document as it would be saved now (see #withSavedDoc). */
  #assemble(plan: ops.PlanPage[], extras: ops.ExtraDoc[] = [], current?: Uint8Array) {
    return this.#withSavedDoc((doc) => ops.assemble(doc, plan, extras), current);
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
      const picked = await files.pickPdfs(true);
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
    try {
      await this.#withSources(docs, async (sources) => {
        const plan = ops.identityPlan(this.pageCount);
        // Every page of each source; source 0, the open document, gives none.
        const inserted = ops.mergePlan([0, ...sources.map((s) => s.doc.numPages)]);
        plan.splice(before, 0, ...inserted);
        const total = inserted.length;
        await this.#structural(`Insert ${plural(total, "page")}`, plan, sources, {
          page: before + 1,
          selection: Array.from({ length: total }, (_, k) => before + k),
        });
      });
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  /**
   * Open other PDFs to take pages from, asking for their passwords, and run
   * `fn` with them. Does nothing if a password is not given.
   */
  async #withSources(docs: files.OpenedFile[], fn: (sources: Source[]) => Promise<void>) {
    const sources: Source[] = [];
    try {
      for (const d of docs) {
        let opened;
        try {
          opened = await openPdf(d.bytes, { askPassword: (incorrect) => this.#askPassword(incorrect, d.name) });
        } catch (e) {
          if (e instanceof Error && e.name === "PasswordException") return; // password not given
          throw new ops.UserError(`${d.name}: ${errorText(e)}`);
        }
        sources.push({ doc: opened.doc, data: d.bytes, password: opened.password });
        if (opened.doc.isPureXfa) throw xfaError(d.name);
      }
      await fn(sources);
    } finally {
      await Promise.all(sources.map((s) => s.doc.loadingTask.destroy()));
    }
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

  // -------------------------------------------------------- split / merge

  /** Save the document as several PDFs, one per page range, in a folder the user picks. */
  async split() {
    const doc = this.doc;
    if (!doc || this.#busy) return;
    const n = doc.numPages;
    const ranges = await this.#askSplit(n);
    if (!ranges) return;
    let dest;
    try {
      dest = await files.saveToFolder(ops.splitNames(this.fileName, ranges, n));
    } catch (e) {
      return toast(errorText(e), "error");
    }
    if (!dest) return;
    const existing = dest.files.filter((f) => f.exists).map((f) => f.name);
    if (
      existing.length &&
      !(await confirmDialog(
        "Replace existing files?",
        `${listNames(existing)} ${existing.length === 1 ? "is" : "are"} already in ${dest.folder}.`,
        "Replace",
      ))
    ) {
      return;
    }
    const parts = dest.files;
    await this.#withBusy("Splitting…", async () => {
      await this.#withSavedDoc(async (source) => {
        for (const [k, range] of ranges.entries()) {
          $("busyLabel").textContent = `Splitting… ${k + 1}/${ranges.length}`;
          await parts[k].write(await ops.assemble(source, ops.rangePlan(range)));
        }
      });
      toast(`Saved ${plural(ranges.length, "file")} in ${dest.folder}`);
    });
  }

  /** The split dialog: the page ranges to save, or null if cancelled. */
  async #askSplit(n: number): Promise<ops.PageRange[] | null> {
    const dialog = $<HTMLDialogElement>("splitDialog");
    const every = $<HTMLInputElement>("splitEvery");
    const typed = $<HTMLInputElement>("splitRanges");
    const preview = $("splitPreview");
    const ok = $<HTMLButtonElement>("splitOk");
    const radio = (mode: string) => dialog.querySelector<HTMLInputElement>(`input[name="splitMode"][value="${mode}"]`)!;
    const ranges = () =>
      radio("every").checked ? ops.everyRanges(n, Number(every.value)) : ops.parseRanges(typed.value, n);
    const update = () => {
      $("splitEveryUnit").textContent = every.value === "1" ? "page" : "pages";
      try {
        const names = ops.splitNames(this.fileName, ranges(), n);
        preview.textContent = `${plural(names.length, "file")}: ${summarise(names)}`;
        preview.classList.remove("error");
        ok.disabled = false;
      } catch (e) {
        preview.textContent = errorText(e);
        // Nothing typed yet is a prompt, not a mistake.
        preview.classList.toggle("error", radio("every").checked || typed.value.trim() !== "");
        ok.disabled = true;
      }
    };
    const ac = new AbortController();
    const on = (el: HTMLElement, type: string, fn: (e: Event) => void) => el.addEventListener(type, fn, { signal: ac.signal });
    for (const [input, mode] of [[every, "every"], [typed, "ranges"]] as const) {
      const choose = () => {
        radio(mode).checked = true;
        update();
      };
      on(input, "input", choose);
      on(input, "focus", choose);
    }
    for (const mode of ["every", "ranges"]) on(radio(mode), "change", update);
    // Start on the chosen mode's button: focusing a field would switch to its mode.
    for (const mode of ["every", "ranges"]) radio(mode).autofocus = radio(mode).checked;
    update();
    try {
      return (await showDialog(dialog)) === "ok" ? ranges() : null;
    } finally {
      ac.abort();
    }
  }

  /**
   * Combine PDFs into a new, unsaved document: the files the user picks and,
   * unless they take it out of the list, the open document as it is now.
   */
  async merge() {
    if (this.#busy) return;
    let picked: files.OpenedFile[];
    try {
      picked = await files.pickPdfs(true);
    } catch (e) {
      return toast(errorText(e), "error");
    }
    if (!picked.length) return;
    const entries: MergeEntry[] = picked.map((file) => ({ name: file.name, file }));
    if (this.doc) entries.unshift({ name: this.fileName || "Untitled", file: null });
    const order = await this.#askMerge(entries);
    if (!order) return;

    await this.#withBusy("Merging…", async () => {
      // The open document (at `at`, if listed) is already open; the files are
      // opened to count their pages, asking for passwords where needed.
      const at = order.findIndex((e) => !e.file);
      if (at >= 0 && this.#requireDoc().isPureXfa) throw xfaError(order[at].name);
      await this.#withSources(order.flatMap((e) => (e.file ? [e.file] : [])), async (picked) => {
        const wasProtected = picked.some((s) => s.password !== undefined) || (at >= 0 && this.#password !== undefined);
        let merged: Uint8Array;
        if (at === 0) {
          // The open document is the base the others are added to.
          const counts = picked.map((s) => s.doc.numPages);
          merged = await this.#withSavedDoc((doc) => ops.assemble(doc, ops.mergePlan([doc.numPages, ...counts]), picked));
        } else {
          const sources = picked.map((s) => ({ data: s.data, password: s.password, pages: s.doc.numPages }));
          if (at > 0) sources.splice(at, 0, { data: await this.currentBytes(), password: this.#password, pages: this.pageCount });
          merged = await ops.assemble(picked[0].doc, ops.mergePlan(sources.map((s) => s.pages)), sources.slice(1));
        }
        const name = files.withSuffix(order[0].name, "-merged");
        // A new document, in a new tab.
        if (await this.#openInNewTab(merged, { name, target: null })) {
          this.#docDirty = true; // a new document, not saved anywhere yet
          this.#renderTitle();
          toast(`Merged ${plural(order.length, "file")} into ${plural(this.pageCount, "page")}`);
          // pdf.js writes a document assembled from several files without encryption.
          if (wasProtected) toast("The merged document is not password-protected.", "error");
        }
      });
    });
  }

  /** The merge dialog: the files in the order to merge them, or null if cancelled. */
  async #askMerge(entries: MergeEntry[]): Promise<MergeEntry[] | null> {
    const dialog = $<HTMLDialogElement>("mergeDialog");
    const list = $("mergeList");
    const ok = $<HTMLButtonElement>("mergeOk");
    const items = [...entries];
    const span = (className: string, text: string) =>
      Object.assign(document.createElement("span"), { className, textContent: text, title: text });
    const button = (act: string, label: string, name: string, disabled: boolean) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "icon", title: label, disabled });
      b.dataset.act = act;
      b.setAttribute("aria-label", `${label}: ${name}`);
      b.innerHTML = icon(act === "remove" ? "close" : act);
      return b;
    };
    const render = (focus?: { index: number; act: string }) => {
      list.replaceChildren(
        ...items.map((e, i) => {
          const li = document.createElement("li");
          li.dataset.index = String(i);
          li.append(span("file-name", e.name));
          if (!e.file) li.append(span("tag muted", "open document"));
          li.append(
            button("up", "Move up", e.name, i === 0),
            button("down", "Move down", e.name, i === items.length - 1),
            button("remove", "Remove", e.name, false),
          );
          return li;
        }),
      );
      ok.disabled = items.length < 2;
      ok.title = items.length < 2 ? "Add at least two files" : "";
      if (!focus) return;
      const row = list.querySelector(`li[data-index="${Math.min(focus.index, items.length - 1)}"]`);
      const target =
        row?.querySelector<HTMLButtonElement>(`button[data-act="${focus.act}"]:not(:disabled)`) ??
        row?.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
        $("mergeAdd");
      target.focus();
    };
    const ac = new AbortController();
    list.addEventListener(
      "click",
      (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
        if (!btn) return;
        const i = Number(btn.closest("li")!.dataset.index);
        const act = btn.dataset.act!;
        if (act === "remove") {
          items.splice(i, 1);
          return render({ index: i, act });
        }
        const j = act === "up" ? i - 1 : i + 1;
        [items[i], items[j]] = [items[j], items[i]];
        render({ index: j, act });
      },
      { signal: ac.signal },
    );
    $("mergeAdd").addEventListener(
      "click",
      async () => {
        try {
          const more = await files.pickPdfs(true);
          items.push(...more.map((file) => ({ name: file.name, file })));
          render();
        } catch (e) {
          toast(errorText(e), "error");
        }
      },
      { signal: ac.signal },
    );
    render();
    try {
      return (await showDialog(dialog)) === "ok" && items.length >= 2 ? items : null;
    } finally {
      ac.abort();
    }
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
    const date = (v: unknown) => (typeof v === "string" && PDFDateString.toDateObject(v)?.toLocaleString()) || "—";
    const flags = info as unknown as Record<string, unknown>;
    const [permissions, markInfo] = await Promise.all([doc.getPermissions().catch(() => null), doc.getMarkInfo().catch(() => null)]);
    const facts: [string, string][] = [
      ["File", this.fileName],
      ["Size", `${(bytes / 1024).toFixed(bytes > 10240 ? 0 : 1)} KB`],
      ["Pages", String(doc.numPages)],
      ["Page size", size],
      ["Created", date(info.CreationDate)],
      ["Modified", date(info.ModDate)],
      ["PDF version", info.PDFFormatVersion ?? "—"],
      ["Creator", info.Creator || "—"],
      ["Producer", info.Producer || "—"],
      ["Security", flags.EncryptFilterName ? (this.#password ? "Encrypted, password to open" : "Encrypted") : "None"],
      ["Permissions", describePermissions(permissions && [...permissions])],
      ["Forms", flags.IsXFAPresent ? "XFA" : flags.IsAcroFormPresent ? "Yes" : "No"],
      ["Digital signatures", flags.IsSignaturesPresent ? "Yes (any change makes them invalid)" : "No"],
      ["Tagged (accessible)", yesNo(markInfo?.Marked)],
      ["Fast web view", yesNo(flags.IsLinearized)],
    ];
    const dl = $("propsFacts");
    dl.textContent = "";
    for (const [k, v] of facts) {
      dl.append(Object.assign(document.createElement("dt"), { textContent: k }));
      dl.append(Object.assign(document.createElement("dd"), { textContent: v }));
    }
    // Fonts are listed on demand: finding them means reading every page.
    const fontsBox = $<HTMLDetailsElement>("propsFonts");
    fontsBox.open = false;
    $("fontList").replaceChildren();
    const scan = new AbortController();
    fontsBox.addEventListener("toggle", () => fontsBox.open && void this.#listFonts(doc, scan.signal), { once: true, signal: scan.signal });

    const answer = await showDialog($<HTMLDialogElement>("propsDialog"));
    scan.abort();
    if (answer !== "ok") return;
    const next = {
      title: inputs.title.value.trim(),
      author: inputs.author.value.trim(),
      subject: inputs.subject.value.trim(),
      keywords: inputs.keywords.value.trim(),
    };
    if (Object.entries(next).every(([k, v]) => v === original[k])) return;
    await this.#edit("Edit properties", (b) => ops.writeInfo(b, next));
  }

  /** Fill the properties dialog's font list, reading each page; stops if `signal` aborts. */
  async #listFonts(doc: PDFDocumentProxy, signal: AbortSignal) {
    const list = $("fontList");
    const status = (text: string) => list.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: text }));
    status("Looking for fonts…");
    let fontsDoc: PDFDocumentProxy | null = null;
    try {
      ({ doc: fontsDoc } = await openPdf(await doc.getData(), { password: this.#password, fontExtraProperties: true }));
      const found: FontInfo[] = [];
      for (let n = 1; n <= fontsDoc.numPages && !signal.aborted; n++) {
        if (fontsDoc.numPages > 20) status(`Looking for fonts… page ${n} of ${fontsDoc.numPages}`);
        const page = await fontsDoc.getPage(n);
        await page.getOperatorList();
        for (const [, obj] of (page as unknown as { commonObjs: Iterable<[string, unknown]> }).commonObjs) {
          const font = fontInfo(obj);
          if (font) found.push(font);
        }
      }
      if (signal.aborted) return;
      const fonts = uniqueFonts(found);
      if (!fonts.length) return status("No fonts: the pages have no text.");
      list.replaceChildren(
        ...fonts.map((f) => {
          const li = document.createElement("li");
          const note = f.embedded ? (f.subset ? "embedded subset" : "embedded") : "not embedded";
          li.append(Object.assign(document.createElement("span"), { className: "font-name", textContent: f.name }));
          li.append(Object.assign(document.createElement("span"), { className: "muted", textContent: `${f.type} · ${note}` }));
          return li;
        }),
      );
    } catch (e) {
      if (!signal.aborted) status(`Could not read the fonts: ${errorText(e)}`);
    } finally {
      await fontsDoc?.loadingTask.destroy();
    }
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
    if (tool === "sign" && !this.#placing) {
      // Choose what to add first.
      document.querySelector<HTMLElement>('.toolbar .tool[data-tool="sign"]')!.click();
      return;
    }
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
    const file = await files.pickImage().catch((e) => {
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
  async #editorLayerReady(pageNumber = this.page) {
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
    const type = pdfjsParam(key);
    // Options of the tools handled here have no pdf.js selection to restyle.
    if (type === undefined || !this.#ui?.hasSelection) (this.#params as unknown as Record<string, unknown>)[key] = value;
    (this.#shown as unknown as Record<string, unknown>)[key] = value;
    if (type !== undefined) this.#dispatchParam(type, toPdfjs(key, value));
    this.#renderTool();
  }

  // ------------------------------------------------------------- comments

  /** The note dialog: comment text (and the author's name), or null if cancelled. */
  async #askComment(title: string, text: string, ok: string): Promise<{ text: string; author: string } | null> {
    $("noteTitle").textContent = title;
    $("noteOk").textContent = ok;
    const field = $<HTMLTextAreaElement>("noteText");
    const author = $<HTMLInputElement>("noteAuthor");
    field.value = text;
    author.value = readPref("author") ?? "";
    if ((await showDialog($<HTMLDialogElement>("noteDialog"))) !== "ok") return null;
    writePref("author", author.value.trim());
    return { text: field.value.trim(), author: author.value.trim() };
  }

  /** Add a sticky note with its icon's top left at `at` (PDF points). */
  async addNote(pageIndex: number, at: marks.Point) {
    const answer = await this.#askComment("Add note", "", "Add");
    if (!answer?.text) return;
    await this.#edit("Add note", (b) => comments.addNote(b, pageIndex, at, answer.text, { author: answer.author }), {
      page: pageIndex + 1,
    });
  }

  async editComment(item: CommentItem) {
    const answer = await this.#askComment(`Edit ${commentKind(item.subtype).toLowerCase()} comment`, item.text, "Save");
    if (!answer || answer.text === item.text) return;
    await this.#edit("Edit comment", (b) => comments.setComment(b, item, answer.text), { page: item.pageIndex + 1 });
  }

  async deleteComment(item: CommentItem) {
    const kind = commentKind(item.subtype).toLowerCase();
    if (!(await confirmDialog(`Delete this ${kind}?`, item.text ? `“${item.text.slice(0, 120)}”` : "It has no comment.", "Delete"))) return;
    await this.#edit(`Delete ${kind}`, (b) => comments.deleteAnnotation(b, item), { page: item.pageIndex + 1 });
  }

  #commentsTimer = 0;

  /** The document's comments may have changed: refresh the panel if it is showing. */
  #commentsChanged() {
    clearTimeout(this.#commentsTimer);
    if ($("panelComments").hidden || !$("app").classList.contains("sidebar-open")) return;
    this.#commentsTimer = window.setTimeout(() => void this.#refreshComments(), 300);
  }

  async #refreshComments() {
    const doc = this.doc;
    if (!doc) return;
    // Unsaved annotations count too: list them from the document as it would be saved.
    const items = await this.#withSavedDoc(collectComments).catch((e: unknown) => {
      console.warn("comments", e);
      return null;
    });
    if (!items || doc !== this.doc) return;
    renderComments(items, (i) => this.#labels?.[i] ?? String(i + 1), {
      show: (item) =>
        this.viewer.scrollPageIntoView({
          pageNumber: item.pageIndex + 1,
          destArray: [null, { name: "XYZ" }, item.rect[0] - 20, item.rect[3] + 20, null],
          allowNegativeOffset: true,
        }),
      edit: (item) => void this.editComment(item),
      remove: (item) => void this.deleteComment(item),
    });
    $("tabComments").title = items.length ? `Comments (${items.length})` : "Comments";
  }

  // ------------------------------------ shapes, text markup, Fill & Sign

  /** Add pdf.js editors to a rendered page, as one step pdf.js can undo. */
  async addEditors(pageIndex: number, datas: EditorData[]) {
    const ui = this.#ui;
    // A page just scrolled to may still be rendering its editor layer.
    if (ui && !ui.getLayer(pageIndex)) await this.#editorLayerReady(pageIndex + 1);
    const layer = ui?.getLayer(pageIndex);
    if (!ui || !layer) {
      toast("Annotations can't be added to this page.", "error");
      return false;
    }
    const editors: Editor[] = [];
    for (const data of datas) {
      const editor = await layer.deserialize(data);
      if (!editor) continue;
      // Restored as a copy (to show its text), but where it was put, not offset like a paste.
      if (data.isCopy) (editor as Editor & { isClone?: boolean }).isClone = true;
      editors.push(editor);
    }
    if (!editors.length) return false;
    // pdf.js selects what it adds and asks to switch to that editor's mode; stay in this tool.
    this.#adding = true;
    try {
      this.#addCommands(ui, layer, editors);
    } finally {
      this.#adding = false;
    }
    if (MODE[this.#tool] === T.NONE) ui.unselectAll();
    return true;
  }

  /** Set while the app adds editors itself (see addEditors). */
  #adding = false;

  #addCommands(ui: UIManager, layer: EditorLayer, editors: Editor[]) {
    ui.addCommands({
      cmd: () => {
        // Outside pdf.js's editing modes a layer that was empty stays hidden;
        // ink shows anyway (it is drawn elsewhere), text and images would not.
        layer.div.hidden = false;
        editors.forEach((e) => layer.addOrRebuild(e));
      },
      undo: () => editors.forEach((e) => e.remove()),
      mustExec: true,
    });
  }

  /** The page under a pointer event, and where on it (CSS pixels from its top left). */
  #pageAt(e: { target: EventTarget | null; clientX: number; clientY: number }): PageHit | null {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("#viewer .page");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { el, pageIndex: Number(el.dataset.pageNumber) - 1, x: e.clientX - r.left, y: e.clientY - r.top, rect: r };
  }

  /** A point on a page's view in PDF points. */
  #toPdf(pageIndex: number, x: number, y: number): marks.Point {
    const [px, py] = this.viewer.getPageView(pageIndex).viewport.convertToPdfPoint(x, y) as number[];
    return [px, py];
  }

  #wirePageTools() {
    const container = $("viewerContainer");
    container.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.doc || this.presenting || !POINTER_TOOLS.has(this.#tool)) return;
      if (this.#tool === "hand") return this.#pan(e);
      const hit = this.#pageAt(e);
      if (!hit) return;
      e.preventDefault();
      // Take focus from the tool options, so keys (undo, Escape) reach the app.
      container.focus({ preventScroll: true });
      if (this.#tool === "sign") void this.#place(hit.pageIndex, hit.x, hit.y);
      else if (this.#tool === "shape") this.#dragShape(e, hit);
      else if (this.#tool === "zoom" || this.#tool === "snapshot") this.#dragArea(e, hit);
      else if (this.#tool === "note") void this.addNote(hit.pageIndex, this.#toPdf(hit.pageIndex, hit.x, hit.y));
    });
    // Text markup applies to the text selected with the tool on.
    container.addEventListener("pointerup", () => {
      if (this.#tool === "markup") setTimeout(() => void this.markSelection());
    });
  }

  /** Drag out a shape, previewed as it is drawn. */
  #dragShape(down: PointerEvent, hit: PageHit) {
    const { el, pageIndex, rect } = hit;
    const params = this.#params;
    const scale = this.viewer.getPageView(pageIndex).viewport.scale;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("draw-preview");
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", params.shapeColor);
    path.setAttribute("stroke-opacity", String(params.shapeOpacity / 100));
    path.setAttribute("stroke-width", String(params.shapeThickness * scale));
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
    el.append(svg);
    const start: marks.Point = [hit.x, hit.y];
    let end = start;
    const clamp = (e: PointerEvent): marks.Point => [
      Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
    ];
    const container = $("viewerContainer");
    container.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent) => {
      end = clamp(e);
      const d = marks
        .shapePaths(params.shapeKind, start, end, params.shapeThickness * scale)
        .map((pts) => "M" + pts.map(([x, y]) => `${x},${y}`).join("L"))
        .join("");
      path.setAttribute("d", d);
    };
    const up = () => {
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerup", up);
      container.removeEventListener("pointercancel", up);
      svg.remove();
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 4) return; // a click, not a drag
      const a = this.#toPdf(pageIndex, ...start);
      const b = this.#toPdf(pageIndex, ...end);
      const stroke = { color: params.shapeColor, thickness: params.shapeThickness, opacity: params.shapeOpacity / 100 };
      void this.addEditors(pageIndex, [marks.inkData(pageIndex, marks.shapePaths(params.shapeKind, a, b, stroke.thickness), stroke)]);
    };
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerup", up);
    container.addEventListener("pointercancel", up);
  }

  /** Hand tool: drag to scroll. */
  #pan(down: PointerEvent) {
    const container = $("viewerContainer");
    down.preventDefault();
    container.setPointerCapture(down.pointerId);
    container.classList.add("panning");
    let [x, y] = [down.clientX, down.clientY];
    const move = (e: PointerEvent) => {
      container.scrollLeft -= e.clientX - x;
      container.scrollTop -= e.clientY - y;
      [x, y] = [e.clientX, e.clientY];
    };
    const up = () => {
      container.classList.remove("panning");
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerup", up);
      container.removeEventListener("pointercancel", up);
    };
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerup", up);
    container.addEventListener("pointercancel", up);
  }

  /**
   * Marquee zoom and snapshot: drag out a rectangle on a page. Zoom fits it to
   * the window (a click zooms in a step, Alt+click out); snapshot copies it as
   * an image.
   */
  #dragArea(down: PointerEvent, hit: PageHit) {
    const { el, pageIndex, rect } = hit;
    const box = document.createElement("div");
    box.className = "area-preview";
    el.append(box);
    const start: marks.Point = [hit.x, hit.y];
    let end = start;
    const container = $("viewerContainer");
    container.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent) => {
      end = [Math.max(0, Math.min(rect.width, e.clientX - rect.left)), Math.max(0, Math.min(rect.height, e.clientY - rect.top))];
      Object.assign(box.style, {
        left: `${Math.min(start[0], end[0])}px`,
        top: `${Math.min(start[1], end[1])}px`,
        width: `${Math.abs(end[0] - start[0])}px`,
        height: `${Math.abs(end[1] - start[1])}px`,
      });
    };
    const up = (e: PointerEvent) => {
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerup", up);
      container.removeEventListener("pointercancel", up);
      box.remove();
      const area = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1])] as const;
      const isClick = area[2] < 6 && area[3] < 6;
      if (this.#tool === "zoom") {
        if (isClick) this.viewer.updateScale({ steps: e.altKey ? -1 : 1, origin: [e.clientX, e.clientY] });
        else this.#zoomTo(pageIndex, ...area);
      } else if (!isClick) void this.snapshot(pageIndex, ...area);
    };
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerup", up);
    container.addEventListener("pointercancel", up);
  }

  /** Zoom so the area (CSS pixels on the page's view) fills the window. */
  #zoomTo(pageIndex: number, x: number, y: number, width: number, height: number) {
    const view = this.viewer.getPageView(pageIndex);
    const container = $("viewerContainer");
    const factor = Math.min(container.clientWidth / width, container.clientHeight / height) * 0.95;
    const scale = Math.min(10, this.viewer.currentScale * factor);
    // The area's centre in PDF points, and the window's size in points at the new scale.
    const [cx, cy] = this.#toPdf(pageIndex, x + width / 2, y + height / 2);
    const cssPerPoint = (view.viewport.scale / this.viewer.currentScale) * scale;
    const [w, h] = [container.clientWidth / cssPerPoint, container.clientHeight / cssPerPoint];
    this.viewer.scrollPageIntoView({
      pageNumber: pageIndex + 1,
      destArray: [null, { name: "XYZ" }, cx - w / 2, cy + h / 2, scale],
      allowNegativeOffset: true,
    });
  }

  /** The last snapshot's size in pixels (for the tests). */
  lastSnapshot: { width: number; height: number } | null = null;

  /**
   * Copy an area of a page (CSS pixels on its view) to the clipboard as a PNG,
   * at twice the screen's resolution. Where the clipboard refuses, offer to save it.
   */
  async snapshot(pageIndex: number, x: number, y: number, width: number, height: number) {
    const view = this.viewer.getPageView(pageIndex).viewport;
    const ratio = 2 * (window.devicePixelRatio || 1);
    const blob = await this.#withSavedDoc(async (doc) => {
      const page = await doc.getPage(pageIndex + 1);
      const viewport = page.getViewport({
        scale: view.scale * ratio,
        rotation: view.rotation,
        offsetX: -x * ratio,
        offsetY: -y * ratio,
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE_STORAGE }).promise;
      this.lastSnapshot = { width: canvas.width, height: canvas.height };
      return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not make the image."))), "image/png"));
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Copied to the clipboard");
    } catch {
      const name = files.withSuffix(this.fileName || "document", `-p${pageIndex + 1}-snapshot`).replace(/\.pdf$/i, ".png");
      const saved = await files.saveAs(name, new Uint8Array(await blob.arrayBuffer()), "png").catch((e: unknown) => {
        toast(errorText(e), "error");
        return undefined;
      });
      if (saved) toast(`The clipboard is not available here; saved ${saved.name}`);
    }
  }

  /** Underline, strike out or squiggle the selected text, with the markup tool's settings. */
  async markSelection() {
    const sel = window.getSelection();
    if (!this.doc || !sel || sel.isCollapsed || !sel.rangeCount) return;
    // Boxes of the selected text itself, per page (not of the elements around it).
    const byPage = new Map<number, marks.Rect[]>();
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const root = range.commonAncestorContainer;
      const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode! : root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (!range.intersectsNode(node) || !node.parentElement?.closest(".textLayer")) continue;
        const page = node.parentElement.closest<HTMLElement>(".page")!;
        const part = document.createRange();
        part.setStart(node, node === range.startContainer ? range.startOffset : 0);
        part.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
        const origin = page.getBoundingClientRect();
        const pageIndex = Number(page.dataset.pageNumber) - 1;
        const list = byPage.get(pageIndex) ?? [];
        for (const r of part.getClientRects()) {
          list.push([r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top]);
        }
        byPage.set(pageIndex, list);
      }
    }
    sel.removeAllRanges();
    const { markupKind, markupColor } = this.#params;
    for (const [pageIndex, boxes] of byPage) {
      const pdfBoxes = marks.lineBoxes(boxes).map(([l, t, r, b]): marks.Rect => {
        const [x1, y1] = this.#toPdf(pageIndex, l, t);
        const [x2, y2] = this.#toPdf(pageIndex, r, b);
        return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
      });
      if (!pdfBoxes.length) continue;
      const { paths, thickness } = marks.markupPaths(markupKind, pdfBoxes);
      await this.addEditors(pageIndex, [marks.inkData(pageIndex, paths, { color: markupColor, thickness, opacity: 1 })]);
    }
  }

  #placing: Placing | null = null;

  /** Fill & Sign: what the next click on a page adds. */
  #setPlacing(placing: Placing) {
    this.#placing = placing;
    const what =
      placing.kind === "mark"
        ? { check: "a check mark", cross: "a cross", dot: "a dot" }[placing.mark]
        : placing.kind === "date"
          ? "today's date"
          : placing.signature.kind === "initials"
            ? "your initials"
            : "your signature";
    $("signHint").textContent = `Click on the page to add ${what}`;
    void this.setTool("sign");
  }

  async #place(pageIndex: number, x: number, y: number) {
    const p = this.#placing;
    if (!p) return;
    const at = this.#toPdf(pageIndex, x, y);
    let data: EditorData;
    if (p.kind === "mark") {
      data = marks.inkData(pageIndex, marks.markPaths(p.mark, at, 12), {
        color: "#000000",
        thickness: p.mark === "dot" ? 4 : 1.5,
        opacity: 1,
      });
    } else if (p.kind === "date") {
      data = marks.textData(pageIndex, marks.today(), at, 12, "#000000");
    } else {
      // Signatures at most 160 × 48 points, initials 64 × 32, keeping their shape.
      const sig = p.signature;
      const [maxW, maxH] = sig.kind === "initials" ? [64, 32] : [160, 48];
      const k = Math.min(maxW / sig.width, maxH / sig.height);
      data = marks.imageData(pageIndex, sig.url, at, sig.width * k, sig.height * k);
    }
    await this.addEditors(pageIndex, [data]);
  }

  #wireSignMenu() {
    const button = document.querySelector<HTMLElement>('.toolbar .tool[data-tool="sign"]')!;
    const item = (label: string, data: Record<string, string>) => {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
      b.setAttribute("role", "menuitem");
      Object.assign(b.dataset, data);
      return b;
    };
    wireMenu(button, {
      beforeOpen: (menu) => {
        const saved = savedSignatures().map((sig, i) => {
          const b = item("", { act: "saved", index: String(i) });
          // Sized now, so the menu is placed knowing its width.
          const k = Math.min(1, 44 / sig.height, 220 / sig.width);
          const img = Object.assign(document.createElement("img"), {
            src: sig.url,
            alt: sig.kind === "initials" ? "Saved initials" : "Saved signature",
            width: Math.round(sig.width * k),
            height: Math.round(sig.height * k),
          });
          b.append(img);
          b.classList.add("signature-item");
          return b;
        });
        const sep = () => Object.assign(document.createElement("hr"), { role: "separator" });
        menu.replaceChildren(
          ...saved,
          item("Add signature…", { act: "new", kind: "signature" }),
          item("Add initials…", { act: "new", kind: "initials" }),
          sep(),
          item("✓  Check mark", { act: "mark", mark: "check" }),
          item("✗  Cross", { act: "mark", mark: "cross" }),
          item("•  Dot", { act: "mark", mark: "dot" }),
          item(`Date (${marks.today()})`, { act: "date" }),
          ...(saved.length ? [sep(), item("Forget saved signatures", { act: "forget" })] : []),
        );
      },
      choose: async (el) => {
        const { act } = el.dataset;
        if (!this.doc) return;
        if (act === "saved") {
          const sig = savedSignatures()[Number(el.dataset.index)];
          if (sig) this.#setPlacing({ kind: "image", signature: sig });
        } else if (act === "new") {
          const sig = await askSignature(el.dataset.kind as "signature" | "initials", showDialog);
          if (sig) this.#setPlacing({ kind: "image", signature: sig });
        } else if (act === "mark") this.#setPlacing({ kind: "mark", mark: el.dataset.mark as marks.Mark });
        else if (act === "date") this.#setPlacing({ kind: "date" });
        else if (act === "forget") {
          forgetSignatures();
          toast("Saved signatures forgotten");
        }
      },
    });
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
    this.#renderTabs();
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
    const tool = this.#tool;
    const colorKey = COLOR_KEY[tool];
    if (colorKey) $<HTMLInputElement>("optColor").value = normalizeHex(String(shown[colorKey]));
    $<HTMLInputElement>("optFontSize").value = String(shown.textSize);
    $<HTMLInputElement>("optThickness").value = String(shown[WIDTH_KEY[tool] ?? "inkThickness"]);
    $<HTMLInputElement>("optOpacity").value = String(shown[OPACITY_KEY[tool] ?? "inkOpacity"]);
    $<HTMLInputElement>("optHlThickness").value = String(shown.highlightThickness);
    for (const [selector, value] of [["[data-shape]", shown.shapeKind], ["[data-markup]", shown.markupKind]] as const) {
      for (const b of document.querySelectorAll<HTMLElement>(`#toolOptions ${selector}`)) {
        const on = (b.dataset.shape ?? b.dataset.markup) === value;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      }
    }
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

  /** The page box: the page's label (or number), and where it is in the document. */
  #renderPageNumber(pageNumber: number) {
    const n = this.pageCount;
    const label = this.#labels?.[pageNumber - 1];
    $<HTMLInputElement>("pageNumber").value = label ?? String(pageNumber);
    $("pageCount").textContent = label !== undefined ? `(${pageNumber} of ${n})` : `/ ${n}`;
    $<HTMLButtonElement>("btnPrev").disabled = pageNumber <= 1;
    $<HTMLButtonElement>("btnNext").disabled = pageNumber >= n;
  }

  /** Go to what was typed in the page box: a page label, else a page number. */
  goToTyped(typed: string) {
    const value = typed.trim();
    const byLabel = this.#labels?.indexOf(value) ?? -1;
    const n = byLabel >= 0 ? byLabel + 1 : Number.parseInt(value, 10);
    if (n >= 1 && n <= this.pageCount && String(n) !== "NaN") {
      if (n !== this.page) this.linkService.goToPage(n);
      else this.#renderPageNumber(n);
      return true;
    }
    this.#renderPageNumber(this.page);
    return false;
  }

  #renderNav() {
    $<HTMLButtonElement>("btnBack").disabled = !this.nav.canGoBack;
    $<HTMLButtonElement>("btnForward").disabled = !this.nav.canGoForward;
  }

  #goTo(place: Place) {
    this.viewer.scrollPageIntoView({
      pageNumber: place.pageNumber,
      destArray: place.top === undefined ? undefined : [null, { name: "XYZ" }, place.left ?? null, place.top, null],
      allowNegativeOffset: true,
    });
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

  async saveAttachment(file: Attachment) {
    try {
      const content = await file.content();
      if (!content) throw new Error(`${file.name} is empty or could not be read.`);
      const saved = await files.saveAs(file.name, content, "any");
      if (saved) toast(`Saved ${saved.name}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  /** Show a sidebar panel; one whose tab is hidden (nothing in it) falls back to Pages. */
  #showPanel(id: string, remember = true) {
    const tabs = [...document.querySelectorAll<HTMLElement>("#sidebar [role=tab]")];
    const tab = tabs.find((t) => t.dataset.panel === id && !t.hidden) ?? tabs[0];
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.dataset.panel!).hidden = !on;
    }
    if (remember) writePref("panel", tab.dataset.panel!);
    if (tab.dataset.panel === "panelComments") this.#commentsChanged();
  }

  #wireSidebar() {
    const tablist = document.querySelector<HTMLElement>("#sidebar [role=tablist]")!;
    tablist.addEventListener("click", (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>("[role=tab]");
      if (tab) this.#showPanel(tab.dataset.panel!);
    });
    tablist.addEventListener("keydown", (e) => {
      const tabs = [...tablist.querySelectorAll<HTMLElement>("[role=tab]")].filter((t) => !t.hidden);
      const at = tabs.indexOf(document.activeElement as HTMLElement);
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!step || at < 0) return;
      e.preventDefault();
      const to = tabs[(at + step + tabs.length) % tabs.length];
      this.#showPanel(to.dataset.panel!);
      to.focus();
    });

    // Drag the sidebar's edge (or use the arrow keys on it) to resize it.
    const app = $("app");
    const resizer = $("sidebarResizer");
    const setWidth = (w: number) => {
      const width = Math.round(Math.max(150, Math.min(480, w)));
      app.style.setProperty("--sidebar-w", `${width}px`);
      writePref("sidebarWidth", String(width));
      this.#refit();
    };
    const saved = Number(readPref("sidebarWidth"));
    if (saved) app.style.setProperty("--sidebar-w", `${Math.max(150, Math.min(480, saved))}px`);
    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      const left = $("sidebar").getBoundingClientRect().left;
      const move = (ev: PointerEvent) => setWidth(ev.clientX - left);
      const up = () => {
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", up);
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up);
    });
    resizer.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setWidth($("sidebar").offsetWidth + (e.key === "ArrowRight" ? 16 : -16));
    });
  }

  #setSidebar(open: boolean) {
    $("app").classList.toggle("sidebar-open", open);
    if (open) this.#commentsChanged();
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
      const v = this.#pendingView ?? { page: 1, scale: "auto", rotation: 0 };
      const layout = this.#presenting ? { scroll: ScrollMode.PAGE, spread: SpreadMode.NONE } : savedLayout();
      this.viewer.scrollMode = layout.scroll;
      this.viewer.spreadMode = layout.spread;
      if (v.rotation) this.viewer.pagesRotation = v.rotation;
      this.viewer.currentScaleValue = this.#presenting ? "page-fit" : v.scale;
      if (v.page > 1) this.viewer.currentPageNumber = v.page;
      this.#pendingView = null;
    });
    bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      this.#renderPageNumber(pageNumber);
      this.thumbs.setCurrent(pageNumber - 1);
      this.#savePosition();
    });
    bus.on("updateviewarea", ({ location }: { location: Place }) => {
      this.nav.update({ pageNumber: location.pageNumber, left: location.left, top: location.top });
    });
    bus.on("scalechanging", ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
      this.#renderZoom(scale, presetValue);
      this.#savePosition();
    });
    // Requests from the document's JavaScript (print(), saveAs()).
    bus.on("print", () => void this.print());
    bus.on("download", () => void this.save(true));
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
      // Not for what the app adds itself (pdf.js selects new editors, an image again once
      // it loads), nor while a page tool has the pointer (no editor can be double-clicked then).
      if (this.#adding || POINTER_TOOLS.has(this.#tool)) return;
      this.viewer.annotationEditorMode = evt;
    });
    bus.on("annotationeditormodechanged", ({ mode }: { mode: number }) => {
      // The tools handled here run in pdf.js's plain mode: stay in them.
      if (mode === T.NONE && MODE[this.#tool] === T.NONE) return;
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
    on("btnMerge", () => this.merge());
    on("btnMergeEmpty", () => this.merge());
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
    on("pgSplit", () => this.split());
    on("pgExport", () => this.exportImages());
    on("pgDelete", () => this.deletePages());

    for (const b of document.querySelectorAll<HTMLElement>(".toolbar .tool:not([aria-controls])")) {
      b.addEventListener("click", () => void this.setTool(b.dataset.tool as Tool));
    }
    for (const s of document.querySelectorAll<HTMLElement>("#toolOptions .swatch")) {
      s.addEventListener("click", () => this.#setParam("highlightColor", s.dataset.color!));
    }
    $<HTMLInputElement>("optColor").addEventListener("input", (e) => {
      const key = COLOR_KEY[this.#tool];
      if (key) this.#setParam(key, (e.target as HTMLInputElement).value);
    });
    const num = (id: string, key: (tool: Tool) => keyof ToolParams | undefined) =>
      $<HTMLInputElement>(id).addEventListener("input", (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        const k = key(this.#tool);
        if (k && Number.isFinite(v) && v > 0) this.#setParam(k, v);
      });
    num("optFontSize", () => "textSize");
    num("optThickness", (tool) => WIDTH_KEY[tool]);
    num("optOpacity", (tool) => OPACITY_KEY[tool]);
    num("optHlThickness", () => "highlightThickness");
    for (const b of document.querySelectorAll<HTMLElement>("#toolOptions [data-shape]")) {
      b.addEventListener("click", () => this.#setParam("shapeKind", b.dataset.shape!));
    }
    for (const b of document.querySelectorAll<HTMLElement>("#toolOptions [data-markup]")) {
      b.addEventListener("click", () => this.#setParam("markupKind", b.dataset.markup!));
    }

    on("btnBack", () => this.nav.back());
    on("btnForward", () => this.nav.forward());
    const pageInput = $<HTMLInputElement>("pageNumber");
    pageInput.addEventListener("change", () => this.goToTyped(pageInput.value));
    pageInput.addEventListener("focus", () => pageInput.select());
    $<HTMLSelectElement>("zoomSelect").addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v !== "custom") this.viewer.currentScaleValue = v;
    });
  }

  // ----------------------------------------------------------------- view

  setLayout(scroll: ScrollName, spread: SpreadName) {
    if (!this.doc || this.#presenting) return;
    this.viewer.scrollMode = SCROLL_MODES[scroll];
    this.viewer.spreadMode = SPREAD_MODES[spread];
    writePref("scroll", scroll);
    writePref("spread", spread);
    this.#refit();
  }

  /** Turn the view (not the file) by `delta` degrees. */
  rotateView(delta: number) {
    if (!this.doc) return;
    this.viewer.pagesRotation = (this.viewer.pagesRotation + delta + 360) % 360;
  }

  #wireViewMenu() {
    wireMenu($("btnView"), {
      beforeOpen: (menu) => {
        checkRadio(menu, "scroll", nameOf(SCROLL_MODES, this.viewer.scrollMode) ?? "vertical");
        checkRadio(menu, "spread", nameOf(SPREAD_MODES, this.viewer.spreadMode) ?? "none");
      },
      choose: (item) => {
        const { group, value, act } = item.dataset;
        const scroll = nameOf(SCROLL_MODES, this.viewer.scrollMode) ?? "vertical";
        const spread = nameOf(SPREAD_MODES, this.viewer.spreadMode) ?? "none";
        if (group === "scroll") this.setLayout(value as ScrollName, spread);
        else if (group === "spread") this.setLayout(scroll, value as SpreadName);
        else if (act === "rotateViewCw") this.rotateView(90);
        else if (act === "rotateViewCcw") this.rotateView(-90);
        else if (act === "present") void this.present(true);
      },
    });
  }

  get presenting() {
    return this.#presenting !== null;
  }

  /**
   * Presentation mode: full screen, one page at a time fitted to the screen,
   * no toolbars. Arrows, Space, Page Up/Down and clicks turn pages; Escape ends it.
   */
  async present(on: boolean) {
    if (!this.doc || on === this.presenting) return;
    const app = $("app");
    if (on) {
      closeMenus();
      await this.setTool("none");
      this.#presenting = {
        scroll: this.viewer.scrollMode,
        spread: this.viewer.spreadMode,
        scale: this.viewer.currentScaleValue || "auto",
      };
      app.classList.add("presenting");
      if (!$("findbar").hidden) this.#closeFind();
      await desktop.setFullscreen(true).catch(() => {});
      this.viewer.scrollMode = ScrollMode.PAGE;
      this.viewer.spreadMode = SpreadMode.NONE;
      // Fit once the window has its full-screen size.
      requestAnimationFrame(() => (this.viewer.currentScaleValue = "page-fit"));
      $("viewerContainer").focus();
    } else {
      const before = this.#presenting!;
      this.#presenting = null;
      app.classList.remove("presenting");
      await desktop.setFullscreen(false).catch(() => {});
      this.viewer.scrollMode = before.scroll;
      this.viewer.spreadMode = before.spread;
      requestAnimationFrame(() => (this.viewer.currentScaleValue = before.scale));
    }
  }

  #wirePresentation() {
    const container = $("viewerContainer");
    container.addEventListener("click", (e) => {
      if (!this.presenting || (e.target as HTMLElement).closest("a, input, textarea, select, button, .annotationLayer section")) return;
      this.viewer.nextPage();
    });
    let lastWheel = 0;
    container.addEventListener(
      "wheel",
      (e) => {
        if (!this.presenting || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        if (Math.abs(e.deltaY) < 4 || e.timeStamp - lastWheel < 250) return;
        lastWheel = e.timeStamp;
        if (e.deltaY > 0) this.viewer.nextPage();
        else this.viewer.previousPage();
      },
      { passive: false },
    );
  }

  /** Keys during presentation. Returns true if the key was used. */
  #presentationKey(e: KeyboardEvent) {
    const next = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"];
    const previous = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"];
    if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l")) void this.present(false);
    else if (next.includes(e.key) && !e.shiftKey) this.viewer.nextPage();
    else if (previous.includes(e.key) || (e.key === " " && e.shiftKey)) this.viewer.previousPage();
    else if (e.key === "Home") this.viewer.currentPageNumber = 1;
    else if (e.key === "End") this.viewer.currentPageNumber = this.pageCount;
    else return false;
    return true;
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
      // An open dialog keeps its own keys; nothing may change the document under it.
      if (dialogOpen()) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const typing = isTyping(document.activeElement);
      const inThumbs = $("thumbs").contains(document.activeElement);
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (menuIsOpen()) return; // the menu handles its own keys
      if (this.presenting) {
        if (this.#presentationKey(e)) handled();
        return;
      }
      if (mod && key === "o") return handled(), void this.open();
      if (!this.doc) return;
      if (mod && key === "l") return handled(), void this.present(true);
      if (mod && e.key === "Tab") return handled(), void this.#cycleTab(e.shiftKey ? -1 : 1);
      if ((mod && key === "w") || (mod && e.key === "F4")) return handled(), void this.closeTab();
      if (mod && e.shiftKey && e.code === "Equal") return handled(), this.rotateView(90);
      if (mod && e.shiftKey && e.code === "Minus") return handled(), this.rotateView(-90);
      if (e.altKey && !mod && e.key === "ArrowLeft" && !typing) return handled(), this.nav.back();
      if (e.altKey && !mod && e.key === "ArrowRight" && !typing) return handled(), this.nav.forward();
      if (mod && key === "s") return handled(), void this.save(e.shiftKey);
      if (mod && key === "p") return handled(), void this.print();
      if (mod && key === "f") return handled(), this.#openFind();
      if (mod && (key === "=" || key === "+")) return handled(), this.viewer.increaseScale();
      if (mod && key === "-") return handled(), this.viewer.decreaseScale();
      if (mod && key === "0") return handled(), (this.viewer.currentScaleValue = "auto");
      if (e.key === "F4") return handled(), this.#setSidebar(!$("app").classList.contains("sidebar-open"));
      if (typing) return;

      // In pdf.js's own editing modes its keyboard handling undoes annotation edits.
      const editorOwnsUndo = MODE[this.#tool] !== T.NONE;
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
        // In pdf.js's editing modes Escape first deselects; the tools handled here have nothing to deselect.
        if (this.#tool !== "none" && (MODE[this.#tool] === T.NONE || !this.#editor.hasSelectedEditor)) {
          if (MODE[this.#tool] === T.NONE) this.#ui?.unselectAll();
          return handled(), void this.setTool("none");
        }
        if (inThumbs) return handled(), this.thumbs.clearSelection();
      }
      if (!mod && !e.altKey && TOOL_KEYS[key] && !this.#editor.hasSelectedEditor) {
        return handled(), void this.setTool(TOOL_KEYS[key]);
      }
    });
  }

  /**
   * Cancel buttons are plain buttons that close their dialog, so Enter in a
   * field (the form's implicit submission) presses the first submit button:
   * the primary one (Open, Apply, Choose folder…), and only while it is enabled.
   */
  #wireDialogs() {
    for (const cancel of document.querySelectorAll<HTMLButtonElement>('dialog button[value="cancel"]')) {
      cancel.addEventListener("click", () => cancel.closest("dialog")!.close("cancel"));
    }
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
      if (this.#busy || dialogOpen()) return;
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

/** "a.pdf", "a.pdf and b.pdf", "a.pdf, b.pdf and 3 other files". */
function listNames(names: string[]) {
  if (names.length <= 3) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(", ")} and ${plural(names.length - 2, "other file")}`;
}

/** Page `index` of `doc` as a PNG or JPEG at `dpi`, annotations and form values included. */
async function renderImage(doc: PDFDocumentProxy, index: number, dpi: number, kind: "png" | "jpeg") {
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  // Nearest pixel, not up: 11 in at 150 dpi is 1650 pixels, though the arithmetic gives 1650.0000001.
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // JPEG has no transparency; PNG pages are white too
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport, intent: "print", annotationMode: AnnotationMode.ENABLE_STORAGE }).promise;
  page.cleanup();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not make the image."))), `image/${kind}`, 0.92),
  );
  canvas.width = canvas.height = 0; // free its memory now
  return new Uint8Array(await blob.arrayBuffer());
}

/** A few file names to stand for a longer list. */
function summarise(names: string[]) {
  return names.length <= 3 ? names.join(", ") : `${names[0]}, ${names[1]}, …, ${names.at(-1)}`;
}

/** pdf.js leaves out the pages of a file that is only an XFA form. */
function xfaError(name: string) {
  return new ops.UserError(`${name}: XFA forms cannot be combined with other PDFs.`);
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

/**
 * Keep Tab inside the app. Past the last control, WebView2 moves focus out of
 * the page (in an app window, to nowhere): focus is lost, and a form field left
 * that way is not committed (pdf.js takes a blur to nowhere for the window
 * losing focus). Two stops at the ends of the page send focus round to the
 * other end instead, as WebKitGTK does by itself.
 */
function wrapFocus() {
  const tabbable = () =>
    [...$("app").querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")].filter(
      (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
    );
  const stop = (where: "start" | "end") => {
    const el = Object.assign(document.createElement("span"), { tabIndex: 0, className: "focus-wrap" });
    el.setAttribute("aria-hidden", "true");
    el.addEventListener("focus", () => {
      const all = tabbable();
      (where === "end" ? all[0] : all.at(-1))?.focus();
    });
    return el;
  };
  document.body.prepend(stop("start"));
  document.body.append(stop("end"));
}

/** The folder part of a path, for showing beside a file name. */
const dirName = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/** The page layout last chosen in the View menu. */
function savedLayout() {
  const scroll = readPref("scroll") as ScrollName | null;
  const spread = readPref("spread") as SpreadName | null;
  return {
    scroll: scroll && scroll in SCROLL_MODES ? SCROLL_MODES[scroll] : ScrollMode.VERTICAL,
    spread: spread && spread in SPREAD_MODES ? SPREAD_MODES[spread] : SpreadMode.NONE,
  };
}

/** The document's page labels, or null if it has none or they just count 1, 2, 3… */
async function pageLabels(doc: PDFDocumentProxy) {
  const labels = await doc.getPageLabels().catch(() => null);
  if (!labels || labels.length !== doc.numPages || labels.every((l, i) => l === String(i + 1))) return null;
  return labels;
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
