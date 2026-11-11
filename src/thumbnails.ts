import type { PDFDocumentProxy } from "./pdfjs";

const PAGES_MIME = "application/x-palimpsest-pages";
const THUMB_CSS_WIDTH = 132;

export interface ThumbnailHandlers {
  navigate(pageIndex: number): void;
  move(pages: number[], before: number): void;
  insertFiles(files: File[], before: number): void;
  selectionChanged(selection: number[]): void;
}

/**
 * Page strip: lazily rendered thumbnails with multi-select (click, Ctrl/Cmd,
 * Shift, arrows), drag-to-reorder, and drop-a-PDF-to-insert.
 */
export class Thumbnails {
  #doc: PDFDocumentProxy | null = null;
  #items: HTMLElement[] = [];
  #generation = 0;
  #queue: number[] = [];
  #rendering = false;
  #observer: IntersectionObserver;
  #selection = new Set<number>();
  #anchor = 0;
  #current = 0;
  #dropBefore = -1;

  constructor(
    private root: HTMLElement,
    private h: ThumbnailHandlers,
  ) {
    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) this.#enqueue(Number((e.target as HTMLElement).dataset.index));
        }
      },
      { root, rootMargin: "300px 0px" },
    );
    root.addEventListener("click", (e) => this.#onClick(e));
    root.addEventListener("keydown", (e) => this.#onKey(e));
    root.addEventListener("dragstart", (e) => this.#onDragStart(e));
    root.addEventListener("dragover", (e) => this.#onDragOver(e));
    root.addEventListener("dragleave", (e) => {
      if (!root.contains(e.relatedTarget as Node)) this.#showDrop(-1);
    });
    root.addEventListener("drop", (e) => this.#onDrop(e));
    root.addEventListener("dragend", () => this.#showDrop(-1));
  }

  get selection() {
    return [...this.#selection].sort((a, b) => a - b);
  }

  /** Selected pages, or the current page when nothing is selected. */
  get targets() {
    return this.#selection.size ? this.selection : [this.#current];
  }

  get pageCount() {
    return this.#items.length;
  }

  async setDocument(doc: PDFDocumentProxy | null, opts: { current?: number; selection?: number[] } = {}) {
    this.#generation++;
    this.#queue = [];
    this.#observer.disconnect();
    this.#doc = doc;
    this.root.textContent = "";
    this.#items = [];
    this.#selection = new Set(opts.selection ?? []);
    this.#current = opts.current ?? 0;
    this.#anchor = this.#selection.size ? Math.min(...this.#selection) : this.#current;
    if (!doc) return;

    const gen = this.#generation;
    const first = await doc.getPage(1);
    if (gen !== this.#generation) return;
    const vp = first.getViewport({ scale: 1 });
    const aspect = vp.height / vp.width;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < doc.numPages; i++) {
      const item = document.createElement("div");
      item.className = "thumb";
      item.dataset.index = String(i);
      item.draggable = true;
      item.tabIndex = -1;
      item.setAttribute("role", "option");
      item.setAttribute("aria-label", `Page ${i + 1}`);
      item.innerHTML = `<div class="thumb-page" style="aspect-ratio:${1 / aspect}"></div><span class="thumb-label">${i + 1}</span>`;
      frag.append(item);
      this.#items.push(item);
      this.#observer.observe(item);
    }
    this.root.append(frag);
    this.#paintSelection();
    this.#items[this.#current]?.scrollIntoView({ block: "nearest" });
    this.h.selectionChanged(this.selection);
  }

  setCurrent(pageIndex: number) {
    if (pageIndex === this.#current) return;
    this.#items[this.#current]?.classList.remove("current");
    this.#current = pageIndex;
    const item = this.#items[pageIndex];
    if (!item) return;
    item.classList.add("current");
    item.scrollIntoView({ block: "nearest" });
  }

  selectAll() {
    this.#selection = new Set(this.#items.map((_, i) => i));
    this.#paintSelection();
  }

  clearSelection() {
    this.#selection.clear();
    this.#paintSelection();
  }

  focus() {
    (this.#items[this.#current] ?? this.root).focus();
  }

  #enqueue(i: number) {
    const item = this.#items[i];
    if (!item || item.dataset.state) return;
    item.dataset.state = "queued";
    this.#queue.push(i);
    void this.#pump();
  }

  async #pump() {
    if (this.#rendering) return;
    this.#rendering = true;
    try {
      while (this.#queue.length) {
        const gen = this.#generation;
        const i = this.#queue.shift()!;
        await this.#render(i, gen).catch((e) => console.warn("thumbnail", i + 1, e));
      }
    } finally {
      this.#rendering = false;
    }
  }

  async #render(i: number, gen: number) {
    const doc = this.#doc;
    if (!doc || gen !== this.#generation) return;
    const page = await doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = (THUMB_CSS_WIDTH * devicePixelRatio) / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, intent: "display" }).promise;
    if (gen !== this.#generation) return;
    const slot = this.#items[i].querySelector<HTMLElement>(".thumb-page")!;
    slot.style.aspectRatio = `${viewport.width / viewport.height}`;
    slot.replaceChildren(canvas);
    this.#items[i].dataset.state = "done";
  }

  #paintSelection() {
    this.#items.forEach((item, i) => {
      const selected = this.#selection.has(i);
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
      item.classList.toggle("current", i === this.#current);
    });
    this.h.selectionChanged(this.selection);
  }

  #select(i: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    if (e.shiftKey) {
      const [a, b] = [Math.min(this.#anchor, i), Math.max(this.#anchor, i)];
      if (!(e.ctrlKey || e.metaKey)) this.#selection.clear();
      for (let k = a; k <= b; k++) this.#selection.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.#selection.has(i)) this.#selection.delete(i);
      else this.#selection.add(i);
      this.#anchor = i;
    } else {
      this.#selection = new Set([i]);
      this.#anchor = i;
    }
    this.#paintSelection();
  }

  #indexOf(target: EventTarget | null) {
    const item = (target as HTMLElement | null)?.closest<HTMLElement>(".thumb");
    return item ? Number(item.dataset.index) : -1;
  }

  #onClick(e: MouseEvent) {
    const i = this.#indexOf(e.target);
    if (i < 0) return;
    this.#select(i, e);
    this.#items[i].focus({ preventScroll: true });
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) this.h.navigate(i);
  }

  #onKey(e: KeyboardEvent) {
    const i = this.#indexOf(document.activeElement);
    const from = i >= 0 ? i : this.#current;
    let to = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") to = Math.min(from + 1, this.#items.length - 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") to = Math.max(from - 1, 0);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = this.#items.length - 1;
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (to < 0) return;
    e.preventDefault();
    this.#select(to, { shiftKey: e.shiftKey, ctrlKey: false, metaKey: false });
    this.#items[to].focus();
    this.h.navigate(to);
  }

  #onDragStart(e: DragEvent) {
    const i = this.#indexOf(e.target);
    if (i < 0 || !e.dataTransfer) return;
    if (!this.#selection.has(i)) this.#select(i, { shiftKey: false, ctrlKey: false, metaKey: false });
    e.dataTransfer.setData(PAGES_MIME, JSON.stringify(this.selection));
    e.dataTransfer.effectAllowed = "move";
  }

  #dropIndex(e: DragEvent) {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".thumb");
    if (!item) {
      // Below the last thumbnail → append.
      const last = this.#items.at(-1);
      return last && e.clientY > last.getBoundingClientRect().bottom ? this.#items.length : -1;
    }
    const r = item.getBoundingClientRect();
    const i = Number(item.dataset.index);
    return e.clientY < r.top + r.height / 2 ? i : i + 1;
  }

  #showDrop(before: number) {
    if (before === this.#dropBefore) return;
    this.#dropBefore = before;
    for (const item of this.#items) item.classList.remove("drop-before", "drop-after");
    if (before < 0) return;
    if (before < this.#items.length) this.#items[before].classList.add("drop-before");
    else this.#items.at(-1)?.classList.add("drop-after");
  }

  #onDragOver(e: DragEvent) {
    const types = e.dataTransfer?.types ?? [];
    const pages = types.includes(PAGES_MIME);
    if (!pages && !types.includes("Files")) return;
    const before = this.#dropIndex(e);
    if (before < 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = pages ? "move" : "copy";
    this.#showDrop(before);
  }

  #onDrop(e: DragEvent) {
    const before = this.#dropBefore;
    this.#showDrop(-1);
    if (before < 0 || !e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    const pages = e.dataTransfer.getData(PAGES_MIME);
    if (pages) {
      this.h.move(JSON.parse(pages) as number[], before);
    } else if (e.dataTransfer.files.length) {
      this.h.insertFiles([...e.dataTransfer.files], before);
    }
  }
}
