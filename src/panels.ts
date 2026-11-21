/**
 * Sidebar panels other than the page list: the document's bookmarks
 * (outline), its attached files, and its optional-content layers.
 */
import { PDFDateString } from "pdfjs-dist";
import type { PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { AnnotationId } from "./comments";
import type { PDFDocumentProxy } from "./pdfjs";

type OutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];
type OptionalContentConfig = Awaited<PDFViewer["optionalContentConfigPromise"]>;
type OrderEntry = string | { name: string | null; order: OrderEntry[] };

export interface Attachment {
  name: string;
  description: string;
  /** The file's bytes; pdf.js reads them on demand. */
  content(): Promise<Uint8Array | null>;
}

export interface PanelHandlers {
  saveAttachment(file: Attachment): void;
  /** The panels' tabs changed (shown or hidden). */
  tabsChanged(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) =>
  Object.assign(document.createElement(tag), props);

export class Panels {
  #generation = 0;

  constructor(
    private linkService: PDFLinkService,
    private viewer: PDFViewer,
    private h: PanelHandlers,
  ) {
    wireTree(document.getElementById("outlineTree")!, (item) => item.click());
  }

  /** Fill the panels for `doc` (null clears them). */
  async setDocument(doc: PDFDocumentProxy | null) {
    const gen = ++this.#generation;
    const stale = () => gen !== this.#generation;
    const [outline, attachments] = doc
      ? await Promise.all([doc.getOutline().catch(() => null), doc.getAttachments().catch(() => null)])
      : [null, null];
    if (stale()) return;
    this.#renderOutline(outline ?? []);
    this.#renderAttachments(
      [...(attachments ?? new Map())].map(([id, a]) => ({
        name: a.filename || a.rawFilename || "attachment",
        description: a.description ?? "",
        content: async () => a.content ?? (await doc!.getAttachmentContent(id)),
      })),
    );
    const config = doc ? await this.viewer.optionalContentConfigPromise?.catch(() => null) : null;
    if (stale()) return;
    this.#renderLayers(config ?? null);
    this.h.tabsChanged();
  }

  // ----------------------------------------------------------- bookmarks

  #renderOutline(items: OutlineItem[]) {
    const tree = document.getElementById("outlineTree")!;
    tree.replaceChildren(...items.map((item) => this.#outlineItem(item, 1)));
    const first = tree.querySelector<HTMLElement>('[role="treeitem"]');
    if (first) first.tabIndex = 0;
    document.getElementById("outlineEmpty")!.hidden = items.length > 0;
  }

  #outlineItem(item: OutlineItem, level: number): HTMLElement {
    const li = el("li", { tabIndex: -1 });
    li.setAttribute("role", "treeitem");
    li.setAttribute("aria-level", String(level));
    const row = el("div", { className: "tree-row" });
    const twisty = el("span", { className: "twisty" });
    twisty.setAttribute("aria-hidden", "true");
    const title = el("span", { className: "tree-title", textContent: item.title || "Untitled", title: item.title });
    if (item.bold) title.style.fontWeight = "600";
    if (item.italic) title.style.fontStyle = "italic";
    row.append(twisty, title);
    li.append(row);
    const kids = item.items ?? [];
    if (kids.length) {
      const group = el("ul");
      group.setAttribute("role", "group");
      group.append(...kids.map((k) => this.#outlineItem(k, level + 1)));
      li.append(group);
      // A positive count means the PDF wants the item open.
      setExpanded(li, (item.count ?? 0) > 0);
      twisty.addEventListener("click", (e) => {
        e.stopPropagation();
        setExpanded(li, li.getAttribute("aria-expanded") !== "true");
      });
    }
    row.addEventListener("click", () => {
      focusItem(li);
      this.#follow(item);
    });
    // The tree's keyboard handler activates the focused item by calling click().
    li.addEventListener("click", (e) => {
      if (e.target === li) this.#follow(item);
    });
    return li;
  }

  #follow(item: OutlineItem) {
    const it = item as OutlineItem & { action?: string; setOCGState?: object; attachment?: { filename: string; content: Uint8Array } };
    if (it.dest) void this.linkService.goToDestination(it.dest);
    else if (it.url) window.open(it.url, "_blank", "noopener");
    else if (it.action) this.linkService.executeNamedAction(it.action);
    else if (it.setOCGState) void this.linkService.executeSetOCGState(it.setOCGState as never);
    else if (it.attachment) {
      const { filename, content } = it.attachment;
      this.h.saveAttachment({ name: filename, description: "", content: async () => content ?? null });
    }
  }

  // --------------------------------------------------------- attachments

  #renderAttachments(files: Attachment[]) {
    const list = document.getElementById("attachmentList")!;
    list.replaceChildren(
      ...files.map((file) => {
        const li = el("li");
        const button = el("button", { type: "button", className: "file-row", title: `Save ${file.name}…` });
        button.append(el("span", { className: "file-name", textContent: file.name }));
        if (file.description) button.append(el("span", { className: "muted file-note", textContent: file.description }));
        button.addEventListener("click", () => this.h.saveAttachment(file));
        li.append(button);
        return li;
      }),
    );
    document.getElementById("tabAttachments")!.hidden = files.length === 0;
  }

  // -------------------------------------------------------------- layers

  #renderLayers(config: OptionalContentConfig | null) {
    const root = document.getElementById("layerList")!;
    const groups = config ? [...config] : [];
    document.getElementById("tabLayers")!.hidden = groups.length === 0;
    if (!config || groups.length === 0) {
      root.replaceChildren();
      return;
    }
    const order = (config.getOrder() as OrderEntry[] | null) ?? groups.map(([id]) => id);
    const build = (entries: OrderEntry[]): HTMLElement => {
      const ul = el("ul");
      for (const entry of entries) {
        const li = el("li");
        if (typeof entry === "string") {
          const group = config.getGroup(entry);
          if (!group) continue;
          const label = document.createElement("label");
          label.className = "layer";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = group.visible;
          box.dataset.id = entry;
          box.addEventListener("change", () => {
            config.setVisibility(entry, box.checked);
            this.viewer.optionalContentConfigPromise = Promise.resolve(config);
            // Radio-button groups can switch others off.
            for (const other of root.querySelectorAll<HTMLInputElement>("input[data-id]")) {
              other.checked = config.getGroup(other.dataset.id!)?.visible ?? other.checked;
            }
          });
          const name = document.createElement("span");
          name.textContent = group.name || "Unnamed layer";
          label.append(box, name);
          li.append(label);
        } else {
          if (entry.name) li.append(el("div", { className: "layer-heading", textContent: entry.name }));
          li.append(build(entry.order));
        }
        ul.append(li);
      }
      return ul;
    };
    root.replaceChildren(build(order));
  }
}

// ----------------------------------------------------------- tree keyboard

function setExpanded(li: HTMLElement, open: boolean) {
  li.setAttribute("aria-expanded", String(open));
}

function focusItem(li: HTMLElement) {
  const tree = li.closest('[role="tree"]')!;
  for (const item of tree.querySelectorAll<HTMLElement>('[role="treeitem"]')) item.tabIndex = -1;
  li.tabIndex = 0;
  li.focus();
}

/** Tree items that are not inside a collapsed item. */
function visibleItems(tree: HTMLElement) {
  return [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(
    (li) => !li.parentElement!.closest('[role="treeitem"][aria-expanded="false"]'),
  );
}

/** Arrow keys, Home/End, Enter and Space in an ARIA tree. */
function wireTree(tree: HTMLElement, activate: (li: HTMLElement) => void) {
  tree.addEventListener("keydown", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!li) return;
    const items = visibleItems(tree);
    const at = items.indexOf(li);
    const expanded = li.getAttribute("aria-expanded");
    let to: HTMLElement | undefined;
    if (e.key === "ArrowDown") to = items[at + 1];
    else if (e.key === "ArrowUp") to = items[at - 1];
    else if (e.key === "Home") to = items[0];
    else if (e.key === "End") to = items.at(-1);
    else if (e.key === "ArrowRight") {
      if (expanded === "false") setExpanded(li, true);
      else if (expanded === "true") to = li.querySelector<HTMLElement>('[role="treeitem"]') ?? undefined;
    } else if (e.key === "ArrowLeft") {
      if (expanded === "true") setExpanded(li, false);
      else to = li.parentElement!.closest<HTMLElement>('[role="treeitem"]') ?? undefined;
    } else if (e.key === "Enter" || e.key === " ") {
      activate(li);
    } else return;
    e.preventDefault();
    e.stopPropagation();
    if (to) focusItem(to);
  });
}

// ---------------------------------------------------------------- comments

/** An annotation as the comments panel lists it. */
export interface CommentItem extends AnnotationId {
  subtype: string;
  author: string;
  date: Date | null;
  text: string;
  /** PDF points: [left, bottom, right, top]. */
  rect: number[];
}

/** Not comments: links, form fields, and the popups that show other annotations' text. */
const NOT_COMMENTS = new Set(["Link", "Widget", "Popup"]);

const KIND: Record<string, string> = {
  Text: "Note",
  FreeText: "Text box",
  Ink: "Drawing",
  Highlight: "Highlight",
  Underline: "Underline",
  StrikeOut: "Strike-out",
  Squiggly: "Squiggly underline",
  Square: "Rectangle",
  Circle: "Ellipse",
  Line: "Line",
  Polygon: "Polygon",
  PolyLine: "Polyline",
  Stamp: "Stamp",
  FileAttachment: "Attached file",
  Caret: "Insertion",
};

export const commentKind = (subtype: string) => KIND[subtype] ?? subtype;

/** Every annotation in `doc` that is a comment or markup, in page order. */
export async function collectComments(doc: PDFDocumentProxy): Promise<CommentItem[]> {
  const items: CommentItem[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    for (const a of (await page.getAnnotations({ intent: "display" })) as Record<string, any>[]) {
      if (NOT_COMMENTS.has(a.subtype) || typeof a.id !== "string" || !/^\d+R\d*$/.test(a.id)) continue;
      const text = a.contentsObj?.str || (a.subtype === "FreeText" ? (a.textContent ?? []).join("\n") : "");
      items.push({
        pageIndex: n - 1,
        id: a.id,
        subtype: a.subtype,
        author: a.titleObj?.str ?? "",
        date: PDFDateString.toDateObject(a.modificationDate ?? a.creationDate ?? null),
        text,
        rect: Array.from(a.rect as number[]),
      });
    }
  }
  return items;
}

export interface CommentHandlers {
  show(item: CommentItem): void;
  edit(item: CommentItem): void;
  remove(item: CommentItem): void;
}

/** The comments panel: one entry per comment, grouped by page. */
export function renderComments(items: CommentItem[], label: (pageIndex: number) => string, h: CommentHandlers) {
  const list = document.getElementById("commentList")!;
  document.getElementById("commentsEmpty")!.hidden = items.length > 0;
  const groups = new Map<number, CommentItem[]>();
  for (const item of items) groups.set(item.pageIndex, [...(groups.get(item.pageIndex) ?? []), item]);
  list.replaceChildren(
    ...[...groups].map(([pageIndex, group]) => {
      const section = el("li", { className: "comment-page" });
      section.append(el("h3", { textContent: `Page ${label(pageIndex)}` }));
      const ul = el("ul");
      for (const item of group) {
        const li = el("li", { className: "comment" });
        li.dataset.id = item.id;
        const body = el("button", { type: "button", className: "comment-body", title: "Show on the page" });
        const meta = el("span", { className: "comment-meta muted" });
        const parts = [
          ["comment-kind", commentKind(item.subtype)],
          ["comment-author", item.author],
          ["comment-date", item.date?.toLocaleString() ?? ""],
        ].filter(([, text]) => text);
        meta.append(...parts.map(([className, textContent]) => el("span", { className, textContent })));
        const text = el("span", { className: "comment-text", textContent: item.text || "No comment" });
        if (!item.text) text.classList.add("muted");
        body.append(meta, text);
        body.addEventListener("click", () => h.show(item));
        const actions = el("span", { className: "comment-actions" });
        // A text box's comment is its text, edited on the page itself.
        if (item.subtype !== "FreeText") actions.append(button("Edit comment", "pen", () => h.edit(item)));
        actions.append(button("Delete", "trash", () => h.remove(item)));
        li.append(body, actions);
        ul.append(li);
      }
      section.append(ul);
      return section;
    }),
  );
}

let iconOf: (name: string) => string = () => "";
/** Panels draw their buttons with the app's icons (set once by the app). */
export function useIcons(icon: (name: string) => string) {
  iconOf = icon;
}

function button(label: string, iconName: string, onClick: () => void) {
  const b = el("button", { type: "button", className: "icon", title: label });
  b.setAttribute("aria-label", label);
  b.innerHTML = iconOf(iconName);
  b.addEventListener("click", onClick);
  return b;
}
