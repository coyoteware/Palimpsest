/**
 * Page-level document operations.
 *
 * Structural edits (reorder, delete, duplicate, insert, extract, split, merge) go through
 * pdf.js' own page assembler, `PDFDocumentProxy.extractPages()`. It writes a
 * fresh file containing only reachable objects (deleted pages are really gone),
 * keeps forms, outlines, named destinations, page labels and the structure
 * tree, and folds in any annotations still pending in the editor.
 *
 * Rotation and metadata are not covered by the assembler; those use pdf-lib.
 */
import { PDFDocument, degrees } from "pdf-lib";

/** An operation the user asked for can't be done; the message is shown as is. */
export class UserError extends Error {
  override name = "UserError";
}

/** One output page: page `index` (0-based) of source `src` (0 = the open document, n = extras[n-1]). */
export interface PlanPage {
  src: number;
  index: number;
}

/** Another PDF to take pages from, with its password if it has one. */
export type ExtraDoc = Uint8Array | { data: Uint8Array; password?: string };

/** Shape of one entry accepted by pdf.js `extractPages()`. */
export interface ExtractPageInfo {
  document: Uint8Array | null;
  /** Read by pdf.js for an encrypted `document`, though missing from its type declarations. */
  password?: string;
  includePages: number[];
  pageIndices: number[];
}

/** Minimal surface of PDFDocumentProxy that the assembler needs (eases testing). */
export interface AssemblerDoc {
  numPages: number;
  extractPages(pageInfos: ExtractPageInfo[]): Promise<Uint8Array | null>;
}

export const identityPlan = (n: number): PlanPage[] =>
  Array.from({ length: n }, (_, index) => ({ src: 0, index }));

export function deletePlan(n: number, remove: Iterable<number>): PlanPage[] {
  const drop = new Set(remove);
  return identityPlan(n).filter((p) => !drop.has(p.index));
}

/**
 * Move `pages` so they sit, in ascending order, before the page currently at
 * index `before` (use `n` for "at the end").
 */
export function movePlan(n: number, pages: Iterable<number>, before: number): PlanPage[] {
  const moving = [...new Set(pages)].sort((a, b) => a - b);
  const set = new Set(moving);
  const rest = identityPlan(n).filter((p) => !set.has(p.index));
  const at = before - moving.filter((i) => i < before).length;
  rest.splice(at, 0, ...moving.map((index) => ({ src: 0, index })));
  return rest;
}

/** Each listed page is followed by a copy of itself. */
export function duplicatePlan(n: number, pages: Iterable<number>): PlanPage[] {
  const dup = new Set(pages);
  return identityPlan(n).flatMap((p) => (dup.has(p.index) ? [p, { ...p }] : [p]));
}

/** Insert all `count` pages of source `src` before index `before`. */
export function insertPlan(n: number, before: number, src: number, count: number): PlanPage[] {
  const plan = identityPlan(n);
  plan.splice(before, 0, ...Array.from({ length: count }, (_, index) => ({ src, index })));
  return plan;
}

export function extractPlan(pages: Iterable<number>): PlanPage[] {
  return [...new Set(pages)].sort((a, b) => a - b).map((index) => ({ src: 0, index }));
}

/** Every page of each source in turn: `counts[k]` is the page count of source k (0 = the open document). */
export function mergePlan(counts: number[]): PlanPage[] {
  return counts.flatMap((count, src) => Array.from({ length: count }, (_, index) => ({ src, index })));
}

/** An inclusive, 0-based page range [first, last]. */
export type PageRange = readonly [number, number];

export const rangePlan = ([first, last]: PageRange): PlanPage[] =>
  Array.from({ length: last - first + 1 }, (_, k) => ({ src: 0, index: first + k }));

/** Consecutive runs of `size` pages; the last run takes what is left. */
export function everyRanges(n: number, size: number): PageRange[] {
  if (!Number.isInteger(size) || size < 1) throw new UserError("Enter a whole number of pages, 1 or more.");
  const ranges: PageRange[] = [];
  for (let first = 0; first < n; first += size) ranges.push([first, Math.min(first + size, n) - 1]);
  return ranges;
}

/**
 * Parse page ranges as a user types them, 1-based: "1-3, 5, 8-" means pages
 * 1 to 3, page 5, and page 8 to the end. "-4" means pages 1 to 4. Commas or
 * semicolons separate ranges; each range becomes one file when splitting.
 */
export function parseRanges(text: string, n: number): PageRange[] {
  const parts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new UserError("Enter the pages for each file, like 1-3, 4, 5-.");
  return parts.map((part): PageRange => {
    const single = /^\d+$/.exec(part);
    const range = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part);
    if (!single && !(range && (range[1] || range[2]))) throw new UserError(`“${part}” is not a page or range.`);
    const first = single ? Number(part) : range![1] ? Number(range![1]) : 1;
    const last = single ? first : range![2] ? Number(range![2]) : n;
    for (const p of [first, last]) {
      if (p < 1 || p > n) throw new UserError(`There is no page ${p}; the document has ${n === 1 ? "1 page" : `${n} pages`}.`);
    }
    if (first > last) throw new UserError(`“${part}” runs backwards.`);
    return [first - 1, last - 1];
  });
}

/**
 * File names for the parts of a split, from the document's name: "report.pdf"
 * gives "report-p1-3.pdf", "report-p4.pdf". Page numbers are zero-padded to
 * the width of the page count so the files sort in page order. Characters a
 * file name cannot have on some system (":" in "10:30") become "-".
 */
export function splitNames(fileName: string, ranges: PageRange[], n: number): string[] {
  const base = fileName.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-") || "document";
  const width = String(n).length;
  const num = (i: number) => String(i + 1).padStart(width, "0");
  const names = ranges.map(([a, b]) => `${base}-p${num(a)}${a === b ? "" : `-${num(b)}`}`);
  // The same range given twice gets the same name; number the repeats.
  const seen = new Map<string, number>();
  return names.map((name) => {
    const k = (seen.get(name) ?? 0) + 1;
    seen.set(name, k);
    return `${name}${k > 1 ? ` (${k})` : ""}.pdf`;
  });
}

export function isIdentity(plan: PlanPage[], n: number): boolean {
  return plan.length === n && plan.every((p, i) => p.src === 0 && p.index === i);
}

/**
 * Convert a plan into `extractPages()` arguments. pdf.js wants one entry per
 * (document, copy level): within an entry `includePages` is ascending and
 * `pageIndices[k]` is the output slot of `includePages[k]`. A page used twice
 * therefore appears once at copy level 0 and once at level 1.
 */
export function planToPageInfos(plan: PlanPage[], extras: ExtraDoc[] = []): ExtractPageInfo[] {
  const bySource = new Map<number, Array<Array<[number, number]>>>();
  const uses = new Map<string, number>();
  plan.forEach(({ src, index }, slot) => {
    if (src < 0 || src > extras.length) throw new RangeError(`Unknown page source ${src}`);
    const key = `${src}:${index}`;
    const level = uses.get(key) ?? 0;
    uses.set(key, level + 1);
    let levels = bySource.get(src);
    if (!levels) bySource.set(src, (levels = []));
    (levels[level] ??= []).push([index, slot]);
  });
  const infos: ExtractPageInfo[] = [];
  for (const [src, levels] of [...bySource].sort((a, b) => a[0] - b[0])) {
    const extra = src === 0 ? null : extras[src - 1];
    const source = extra instanceof Uint8Array ? { data: extra } : extra;
    for (const pairs of levels) {
      pairs.sort((a, b) => a[0] - b[0]);
      infos.push({
        document: source?.data ?? null,
        ...(source?.password !== undefined && { password: source.password }),
        includePages: pairs.map(([index]) => index),
        pageIndices: pairs.map(([, slot]) => slot),
      });
    }
  }
  return infos;
}

export async function assemble(doc: AssemblerDoc, plan: PlanPage[], extras: ExtraDoc[] = []) {
  if (plan.length === 0) throw new UserError("A PDF needs at least one page.");
  for (const p of plan) {
    if (p.src === 0 && (p.index < 0 || p.index >= doc.numPages)) {
      throw new RangeError(`Page ${p.index + 1} does not exist`);
    }
  }
  const out = await doc.extractPages(planToPageInfos(plan, extras));
  if (!out) throw new Error("pdf.js could not assemble the document.");
  return out;
}

const loadForEdit = (bytes: Uint8Array) =>
  PDFDocument.load(bytes, { updateMetadata: false }).catch((err: unknown) => {
    if (err instanceof Error && /encrypt/i.test(err.message)) {
      throw new UserError("Rotation and property edits are not supported on encrypted PDFs.");
    }
    throw err;
  });

const saveEdited = (doc: PDFDocument) =>
  doc.save({ updateFieldAppearances: false, useObjectStreams: true });

/** Rotate pages clockwise by `delta` degrees (a multiple of 90). */
export async function rotatePages(bytes: Uint8Array, pages: Iterable<number>, delta: number) {
  if (delta % 90 !== 0) throw new RangeError("Rotation must be a multiple of 90°");
  const doc = await loadForEdit(bytes);
  for (const i of new Set(pages)) {
    const page = doc.getPage(i);
    const angle = (((page.getRotation().angle + delta) % 360) + 360) % 360;
    page.setRotation(degrees(angle));
  }
  return saveEdited(doc);
}

/** A one-page PDF with an empty page of the given size in points. */
export async function blankPagePdf(width = 612, height = 792) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return doc.save();
}

export interface DocInfo {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

export async function readInfo(bytes: Uint8Array): Promise<DocInfo> {
  const doc = await loadForEdit(bytes);
  return {
    title: doc.getTitle() ?? "",
    author: doc.getAuthor() ?? "",
    subject: doc.getSubject() ?? "",
    keywords: doc.getKeywords() ?? "",
  };
}

export async function writeInfo(bytes: Uint8Array, info: DocInfo) {
  const doc = await loadForEdit(bytes);
  doc.setTitle(info.title);
  doc.setAuthor(info.author);
  doc.setSubject(info.subject);
  doc.setKeywords(info.keywords.split(/[,;]\s*/).filter(Boolean));
  doc.setModificationDate(new Date());
  return saveEdited(doc);
}
