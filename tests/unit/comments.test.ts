import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, test } from "vitest";
import { addNote, deleteAnnotation, pdfDate, refOf, setComment } from "../../src/comments";
import { numberedPdf } from "../fixtures/make";

/** The annotations of page `n`, as pdf.js reads them. */
async function annotations(bytes: Uint8Array, n = 1) {
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const list = await (await doc.getPage(n)).getAnnotations();
  await doc.loadingTask.destroy();
  return list as { id: string; subtype: string; contentsObj?: { str: string }; titleObj?: { str: string }; rect: number[]; parentId?: string; color?: Uint8ClampedArray }[];
}

describe("comments", () => {
  test("adds a sticky note with its popup, author and colour", async () => {
    const out = await addNote(await numberedPdf(2), 1, [100, 700], "Check this — ünïcödé", {
      author: "Ada",
      color: "#80ebff",
      date: new Date(Date.UTC(2026, 10, 21, 9, 5, 7)),
    });
    expect(await annotations(out, 1)).toEqual([]);
    const [note, popup] = await annotations(out, 2);
    expect(note).toMatchObject({ subtype: "Text", contentsObj: { str: "Check this — ünïcödé" }, titleObj: { str: "Ada" } });
    expect(note.rect).toEqual([100, 678, 122, 700]);
    expect([...note.color!]).toEqual([128, 235, 255]);
    expect(popup).toMatchObject({ id: (note as { popupRef?: string }).popupRef, subtype: "Popup", parentRect: note.rect });
  });

  test("edits and clears a comment, and deletes the note with its popup", async () => {
    let bytes = await addNote(await numberedPdf(1), 0, [50, 500], "First");
    const [note] = await annotations(bytes);
    bytes = await setComment(bytes, { pageIndex: 0, id: note.id }, "Second");
    expect((await annotations(bytes))[0].contentsObj?.str).toBe("Second");
    bytes = await setComment(bytes, { pageIndex: 0, id: note.id }, "");
    expect((await annotations(bytes))[0].contentsObj?.str ?? "").toBe("");
    bytes = await deleteAnnotation(bytes, { pageIndex: 0, id: note.id });
    expect(await annotations(bytes)).toEqual([]);
  });

  test("an annotation that is not there is an error the user can read", async () => {
    const bytes = await numberedPdf(1);
    await expect(setComment(bytes, { pageIndex: 0, id: "999R" }, "x")).rejects.toThrow(/no longer in the document/);
  });

  test("references and dates", () => {
    expect(refOf("12R").objectNumber).toBe(12);
    expect(refOf("12R3").generationNumber).toBe(3);
    expect(() => refOf("pdfjs_internal_editor_1")).toThrow();
    expect(pdfDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("D:20260102030405Z");
  });
});
