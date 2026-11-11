/**
 * Page-level document operations.
 *
 * Structural edits (reorder, delete, duplicate, insert, extract) go through
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

/** Shape of one entry accepted by pdf.js `extractPages()`. */
export interface ExtractPageInfo {
  document: Uint8Array | null;
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

export function isIdentity(plan: PlanPage[], n: number): boolean {
  return plan.length === n && plan.every((p, i) => p.src === 0 && p.index === i);
}

/**
 * Convert a plan into `extractPages()` arguments. pdf.js wants one entry per
 * (document, copy level): within an entry `includePages` is ascending and
 * `pageIndices[k]` is the output slot of `includePages[k]`. A page used twice
 * therefore appears once at copy level 0 and once at level 1.
 */
export function planToPageInfos(plan: PlanPage[], extras: Uint8Array[] = []): ExtractPageInfo[] {
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
    for (const pairs of levels) {
      pairs.sort((a, b) => a[0] - b[0]);
      infos.push({
        document: src === 0 ? null : extras[src - 1],
        includePages: pairs.map(([index]) => index),
        pageIndices: pairs.map(([, slot]) => slot),
      });
    }
  }
  return infos;
}

export async function assemble(doc: AssemblerDoc, plan: PlanPage[], extras: Uint8Array[] = []) {
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
