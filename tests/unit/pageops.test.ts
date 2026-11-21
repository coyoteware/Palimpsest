import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";
import {
  assemble,
  blankPagePdf,
  deletePlan,
  duplicatePlan,
  everyRanges,
  extractPlan,
  identityPlan,
  insertPlan,
  isIdentity,
  mergePlan,
  movePlan,
  parseRanges,
  planToPageInfos,
  rangePlan,
  readInfo,
  rotatePages,
  splitNames,
  writeInfo,
  type AssemblerDoc,
  UserError,
} from "../../src/pageops";
import { numberedPdf } from "../fixtures/make";

const open = (data: Uint8Array, password?: string) => getDocument({ data: data.slice(), password }).promise;

async function pageTexts(data: Uint8Array) {
  const doc = await open(data);
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => ("str" in it ? it.str : "")).join("").trim());
  }
  await doc.loadingTask.destroy();
  return out;
}

const src = (p: { src: number; index: number }[]) => p.map((x) => `${x.src}:${x.index}`).join(" ");

describe("plans", () => {
  it("delete", () => expect(src(deletePlan(4, [1, 3]))).toBe("0:0 0:2"));
  it("move forward and back", () => {
    expect(src(movePlan(5, [0, 1], 4))).toBe("0:2 0:3 0:0 0:1 0:4");
    expect(src(movePlan(5, [3], 0))).toBe("0:3 0:0 0:1 0:2 0:4");
    expect(src(movePlan(5, [1], 5))).toBe("0:0 0:2 0:3 0:4 0:1");
  });
  it("move to own position is identity", () => expect(isIdentity(movePlan(4, [2], 2), 4)).toBe(true));
  it("duplicate", () => expect(src(duplicatePlan(3, [1]))).toBe("0:0 0:1 0:1 0:2"));
  it("insert", () => expect(src(insertPlan(2, 1, 1, 2))).toBe("0:0 1:0 1:1 0:1"));
  it("extract sorts and dedupes", () => expect(src(extractPlan([2, 0, 2]))).toBe("0:0 0:2"));

  it("groups copies into levels with ascending includePages", () => {
    const extra = new Uint8Array([1]);
    const infos = planToPageInfos(
      [
        { src: 0, index: 2 },
        { src: 0, index: 0 },
        { src: 1, index: 0 },
        { src: 0, index: 2 },
      ],
      [extra],
    );
    expect(infos).toEqual([
      { document: null, includePages: [0, 2], pageIndices: [1, 0] },
      { document: null, includePages: [2], pageIndices: [3] },
      { document: extra, includePages: [0], pageIndices: [2] },
    ]);
  });
  it("rejects unknown sources", () => expect(() => planToPageInfos([{ src: 2, index: 0 }])).toThrow());
  it("merge takes every page of each source in order", () =>
    expect(src(mergePlan([2, 1, 3]))).toBe("0:0 0:1 1:0 2:0 2:1 2:2"));
  it("passes an extra document's password to pdf.js", () => {
    const data = new Uint8Array([1]);
    const infos = planToPageInfos(mergePlan([1, 1, 1]), [{ data, password: "pw" }, data]);
    expect(infos).toEqual([
      { document: null, includePages: [0], pageIndices: [0] },
      { document: data, password: "pw", includePages: [0], pageIndices: [1] },
      { document: data, includePages: [0], pageIndices: [2] },
    ]);
  });
});

describe("split ranges", () => {
  it("every n pages, the last part taking the rest", () => {
    expect(everyRanges(5, 2)).toEqual([[0, 1], [2, 3], [4, 4]]);
    expect(everyRanges(3, 1)).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(everyRanges(3, 10)).toEqual([[0, 2]]);
    expect(() => everyRanges(3, 0)).toThrow(UserError);
    expect(() => everyRanges(3, 1.5)).toThrow(UserError);
  });

  it("parses typed ranges, 1-based, with open ends", () => {
    expect(parseRanges("1-3, 5, 7-", 8)).toEqual([[0, 2], [4, 4], [6, 7]]);
    expect(parseRanges(" -2 ; 2 – 4 ,", 4)).toEqual([[0, 1], [1, 3]]);
    expect(parseRanges("3-3", 3)).toEqual([[2, 2]]);
  });

  it("explains ranges it cannot use", () => {
    expect(() => parseRanges("", 3)).toThrow(/Enter the pages/);
    expect(() => parseRanges("0", 3)).toThrow(/no page 0/);
    expect(() => parseRanges("2-9", 3)).toThrow("There is no page 9; the document has 3 pages.");
    expect(() => parseRanges("3-1", 3)).toThrow(/runs backwards/);
    expect(() => parseRanges("a", 3)).toThrow(/not a page or range/);
    expect(() => parseRanges("-", 3)).toThrow(/not a page or range/);
    expect(() => parseRanges("1-2-3", 3)).toThrow(/not a page or range/);
  });

  it("names parts after the document and their pages", () => {
    expect(splitNames("report.PDF", [[0, 2], [3, 3]], 9)).toEqual(["report-p1-3.pdf", "report-p4.pdf"]);
    expect(splitNames("big.pdf", [[0, 9], [99, 119]], 120)).toEqual(["big-p001-010.pdf", "big-p100-120.pdf"]);
    expect(splitNames("", [[0, 0]], 1)).toEqual(["document-p1.pdf"]);
    expect(splitNames("a.pdf", [[0, 1], [0, 1], [0, 1]], 2)).toEqual(["a-p1-2.pdf", "a-p1-2 (2).pdf", "a-p1-2 (3).pdf"]);
    // Characters the shell refuses in a file name (legal in macOS and Linux names).
    expect(splitNames("Minutes 10:30.pdf", [[0, 0]], 1)).toEqual(["Minutes 10-30-p1.pdf"]);
    expect(splitNames('a\\b/c*?"<>|.pdf', [[0, 0]], 1)).toEqual(["a-b-c-------p1.pdf"]);
  });

  it("a range plan lists its pages", () => expect(src(rangePlan([2, 4]))).toBe("0:2 0:3 0:4"));
});

describe("assemble via pdf.js", () => {
  it("reorders, deletes, duplicates and merges", async () => {
    const base = await numberedPdf(4, "Page");
    const other = await numberedPdf(2, "Other");
    const doc = await open(base);
    const asm = doc as unknown as AssemblerDoc;

    expect(await pageTexts(await assemble(asm, movePlan(4, [3], 0)))).toEqual([
      "Page 4", "Page 1", "Page 2", "Page 3",
    ]);
    expect(await pageTexts(await assemble(asm, deletePlan(4, [0, 2])))).toEqual(["Page 2", "Page 4"]);
    expect(await pageTexts(await assemble(asm, duplicatePlan(4, [1])))).toEqual([
      "Page 1", "Page 2", "Page 2", "Page 3", "Page 4",
    ]);
    expect(await pageTexts(await assemble(asm, insertPlan(4, 2, 1, 2), [other]))).toEqual([
      "Page 1", "Page 2", "Other 1", "Other 2", "Page 3", "Page 4",
    ]);
    await doc.loadingTask.destroy();
  });

  it("splits into parts and merges them back", async () => {
    const doc = await open(await numberedPdf(5, "Page"));
    const asm = doc as unknown as AssemblerDoc;
    const parts = [];
    for (const range of everyRanges(5, 2)) parts.push(await assemble(asm, rangePlan(range)));
    await doc.loadingTask.destroy();
    expect(await Promise.all(parts.map(pageTexts))).toEqual([["Page 1", "Page 2"], ["Page 3", "Page 4"], ["Page 5"]]);

    const [first, ...rest] = parts;
    const base = await open(first);
    const merged = await assemble(base as unknown as AssemblerDoc, mergePlan([2, 2, 1]), rest);
    await base.loadingTask.destroy();
    expect(await pageTexts(merged)).toEqual(["Page 1", "Page 2", "Page 3", "Page 4", "Page 5"]);
  });

  it("merges in an encrypted PDF given its password", async () => {
    const encrypted = new Uint8Array(readFileSync(resolve(import.meta.dirname, "../fixtures/encrypted.pdf")));
    const doc = await open(await numberedPdf(1, "Plain"));
    const out = await assemble(doc as unknown as AssemblerDoc, mergePlan([1, 5]), [{ data: encrypted, password: "secret" }]);
    await doc.loadingTask.destroy();
    const texts = await pageTexts(out); // opens without a password
    expect(texts).toHaveLength(6);
    expect(texts[0]).toBe("Plain 1");
    expect(texts[5]).toContain("Page 5");
  });

  it("drops the content of deleted pages from the file", async () => {
    const base = await numberedPdf(3, "Secret");
    const doc = await open(base);
    const out = await assemble(doc as unknown as AssemblerDoc, deletePlan(3, [1]));
    await doc.loadingTask.destroy();
    const lib = await PDFDocument.load(out);
    expect(lib.getPageCount()).toBe(2);
    // Only two page content streams should remain.
    const streams = lib.context.enumerateIndirectObjects().filter(([, o]) => o.constructor.name.includes("Stream"));
    expect(streams.length).toBeLessThan(6);
  });

  it("refuses empty plans and out-of-range pages", async () => {
    const doc = await open(await numberedPdf(1));
    const asm = doc as unknown as AssemblerDoc;
    await expect(assemble(asm, [])).rejects.toThrow(UserError);
    await expect(assemble(asm, [{ src: 0, index: 5 }])).rejects.toThrow(/does not exist/);
    await doc.loadingTask.destroy();
  });
});

describe("pdf-lib edits", () => {
  it("rotates selected pages, accumulating and wrapping", async () => {
    let bytes = await numberedPdf(3);
    bytes = await rotatePages(bytes, [0, 2], 90);
    bytes = await rotatePages(bytes, [2], 270);
    bytes = await rotatePages(bytes, [1], -90);
    const doc = await open(bytes);
    const rot = await Promise.all([1, 2, 3].map(async (n) => (await doc.getPage(n)).rotate));
    expect(rot).toEqual([90, 270, 0]);
    await doc.loadingTask.destroy();
  });

  it("creates a blank page of the requested size", async () => {
    const doc = await open(await blankPagePdf(300, 400));
    const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
    expect([vp.width, vp.height]).toEqual([300, 400]);
    await doc.loadingTask.destroy();
  });

  it("round-trips document info", async () => {
    const bytes = await writeInfo(await numberedPdf(1), {
      title: "Ünïcode title",
      author: "A. Author",
      subject: "Testing",
      keywords: "alpha, beta",
    });
    expect(await readInfo(bytes)).toEqual({
      title: "Ünïcode title",
      author: "A. Author",
      subject: "Testing",
      keywords: "alpha beta",
    });
  });

  it("keeps identity detection honest", () => {
    expect(isIdentity(identityPlan(3), 3)).toBe(true);
    expect(isIdentity(identityPlan(3), 4)).toBe(false);
  });
});
