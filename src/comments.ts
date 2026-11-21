/**
 * Comments: sticky notes (Text annotations) added, and the comment text of
 * any annotation edited or removed. pdf.js has no editor for these, so they
 * are document edits made with pdf-lib, like rotation (and, like rotation,
 * not possible on encrypted files).
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  type PDFDocument,
  type PDFPage,
} from "pdf-lib";
import { loadForEdit, saveEdited, UserError } from "./pageops";

/** An annotation as pdf.js identifies it: its object number and generation ("12R", "12R3"). */
export interface AnnotationId {
  pageIndex: number;
  /** pdf.js's `id` for the annotation. */
  id: string;
}

export interface NoteOptions {
  author?: string;
  /** "#rrggbb" */
  color?: string;
  date?: Date;
}

const WHAT = "Comment edits are";
/** A note's icon is 22 points square (as pdf.js draws it); its popup opens to the right. */
const ICON = 22;
const POPUP = { width: 200, height: 120 };
/** Print, NoZoom, NoRotate: notes print and keep their size and orientation. */
const NOTE_FLAGS = 4 | 8 | 16;

/** "12R" or "12R3" → the reference. */
export function refOf(id: string): PDFRef {
  const m = /^(\d+)R(\d*)$/.exec(id);
  if (!m) throw new Error(`Not an annotation reference: ${id}`);
  return PDFRef.of(Number(m[1]), m[2] ? Number(m[2]) : 0);
}

/** A PDF date string: D:YYYYMMDDHHmmSSZ (UTC). */
export function pdfDate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

const colorArray = (hex: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? ["", "ff", "d1", "33"];
  return [1, 2, 3].map((i) => Number((parseInt(m[i], 16) / 255).toFixed(3)));
};

function annots(page: PDFPage): PDFArray {
  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (existing) return existing;
  const fresh = page.doc.context.obj([]);
  page.node.set(PDFName.of("Annots"), fresh);
  return fresh;
}

/** The annotation `id` on page `pageIndex`, checking it is really there. */
function find(doc: PDFDocument, { pageIndex, id }: AnnotationId) {
  const page = doc.getPage(pageIndex);
  const ref = refOf(id);
  const list = annots(page);
  const at = list.asArray().findIndex((r) => r instanceof PDFRef && r.objectNumber === ref.objectNumber && r.generationNumber === ref.generationNumber);
  const dict = doc.context.lookupMaybe(ref, PDFDict);
  if (at < 0 || !dict) throw new UserError("That comment is no longer in the document.");
  return { page, ref, dict, list, at };
}

/**
 * Add a sticky note whose icon's top left corner is at `at` (PDF points) on
 * page `pageIndex`, with an (initially closed) popup showing `text`.
 */
export async function addNote(bytes: Uint8Array, pageIndex: number, at: [number, number], text: string, opts: NoteOptions = {}) {
  const doc = await loadForEdit(bytes, WHAT);
  const page = doc.getPage(pageIndex);
  const ctx = doc.context;
  const [x, y] = at;
  const date = pdfDate(opts.date ?? new Date());
  const noteRef = ctx.nextRef();
  const popupRef = ctx.nextRef();
  const note = ctx.obj({
    Type: "Annot",
    Subtype: "Text",
    Name: "Comment",
    Rect: [x, y - ICON, x + ICON, y],
    F: NOTE_FLAGS,
    C: colorArray(opts.color ?? "#ffd133"),
    CreationDate: PDFString.of(date),
    M: PDFString.of(date),
    P: page.ref,
    Popup: popupRef,
  }) as PDFDict;
  note.set(PDFName.of("Contents"), PDFHexString.fromText(text));
  if (opts.author) note.set(PDFName.of("T"), PDFHexString.fromText(opts.author));
  const popup = ctx.obj({
    Type: "Annot",
    Subtype: "Popup",
    Rect: [x + ICON, y - POPUP.height, x + ICON + POPUP.width, y],
    Parent: noteRef,
    Open: false,
    F: 0,
  });
  ctx.assign(noteRef, note);
  ctx.assign(popupRef, popup);
  annots(page).push(noteRef);
  annots(page).push(popupRef);
  return saveEdited(doc);
}

/** Set (or, with "", clear) the comment text of an annotation. */
export async function setComment(bytes: Uint8Array, target: AnnotationId, text: string, date = new Date()) {
  const doc = await loadForEdit(bytes, WHAT);
  const { dict } = find(doc, target);
  if (text) dict.set(PDFName.of("Contents"), PDFHexString.fromText(text));
  else dict.delete(PDFName.of("Contents"));
  dict.delete(PDFName.of("RC")); // rich text would otherwise show instead
  dict.set(PDFName.of("M"), PDFString.of(pdfDate(date)));
  return saveEdited(doc);
}

/** Remove an annotation, with its popup and any replies to it. */
export async function deleteAnnotation(bytes: Uint8Array, target: AnnotationId) {
  const doc = await loadForEdit(bytes, WHAT);
  const { ref, list } = find(doc, target);
  const same = (r: unknown) => r instanceof PDFRef && r.objectNumber === ref.objectNumber && r.generationNumber === ref.generationNumber;
  // Drop the annotation, popups whose parent it is, and replies to it (In Reply To).
  const doomed = (r: unknown) => {
    if (same(r)) return true;
    const d = r instanceof PDFRef ? doc.context.lookupMaybe(r, PDFDict) : undefined;
    return !!d && (same(d.get(PDFName.of("Parent"))) || same(d.get(PDFName.of("IRT"))));
  };
  const keep = list.asArray().filter((r) => !doomed(r));
  while (list.size()) list.remove(0);
  for (const r of keep) list.push(r);
  return saveEdited(doc);
}
