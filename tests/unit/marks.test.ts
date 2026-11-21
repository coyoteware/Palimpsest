import { AnnotationEditorType } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, test } from "vitest";
import { bounds, inkData, lineBoxes, markPaths, markupPaths, rgb, shapePaths, T, textData, type Point } from "../../src/marks";

const stroke = { color: "#ff8000", thickness: 2, opacity: 0.5 };

describe("marks", () => {
  test("editor types match pdf.js", () => {
    expect(T).toEqual({
      FREETEXT: AnnotationEditorType.FREETEXT,
      STAMP: AnnotationEditorType.STAMP,
      INK: AnnotationEditorType.INK,
    });
  });

  test("ink data: straight segments, points and a padded bounding box", () => {
    const data = inkData(2, [[[10, 20], [30, 40], [50, 20]]], stroke);
    expect(data).toMatchObject({ annotationType: T.INK, pageIndex: 2, color: [255, 128, 0], thickness: 2, opacity: 0.5 });
    expect(data.rect).toEqual([9, 19, 51, 41]);
    const { lines, points } = data.paths as { lines: Float32Array[]; points: Float32Array[] };
    expect([...points[0]]).toEqual([10, 20, 30, 40, 50, 20]);
    // A start point, then [cp1, cp2, end] per segment, straight: the control points are the segment's ends.
    expect([...lines[0]].map((v) => (Number.isNaN(v) ? null : v))).toEqual([
      null, null, null, null, 10, 20,
      10, 20, 30, 40, 30, 40,
      30, 40, 50, 20, 50, 20,
    ]);
  });

  test("shapes", () => {
    expect(shapePaths("rect", [0, 0], [10, 5], 1)).toEqual([[[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]]);
    expect(shapePaths("line", [0, 0], [10, 5], 1)).toEqual([[[0, 0], [10, 5]]]);
    const [ellipse] = shapePaths("ellipse", [0, 0], [20, 10], 1);
    expect(bounds(ellipse)).toEqual([-1, -1, 21, 11]);
    expect(ellipse[0]).toEqual(ellipse.at(-1));
    // An arrow: the shaft, and a head whose tip is the end point.
    const [shaft, head] = shapePaths("arrow", [0, 0], [100, 0], 2);
    expect(shaft).toEqual([[0, 0], [100, 0]]);
    expect(head[1]).toEqual([100, 0]);
    expect(head[0][0]).toBeLessThan(100);
    expect(head[0][1]).toBeCloseTo(-head[2][1]);
  });

  test("text markup follows each line box", () => {
    const boxes: [number, number, number, number][] = [
      [10, 100, 200, 112],
      [10, 80, 120, 92],
    ];
    const under = markupPaths("underline", boxes);
    expect(under.paths.map((p) => p.map(([x]) => x))).toEqual([[10, 200], [10, 120]]);
    expect(under.paths[0][0][1]).toBeGreaterThan(100);
    expect(under.paths[0][0][1]).toBeLessThan(103);
    const strike = markupPaths("strikeout", boxes);
    expect(strike.paths[0][0][1]).toBeCloseTo(105.4);
    const squiggle = markupPaths("squiggly", boxes).paths[0];
    expect(squiggle.length).toBeGreaterThan(20);
    expect(squiggle.at(-1)![0]).toBe(200);
    expect(new Set(squiggle.slice(0, -1).map(([, y]) => y)).size).toBe(2);
  });

  test("marks are centred on the point", () => {
    const at: Point = [100, 200];
    for (const mark of ["check", "cross", "dot"] as const) {
      const [x1, y1, x2, y2] = bounds(markPaths(mark, at, 12).flat());
      expect(x1).toBeLessThan(100);
      expect(x2).toBeGreaterThan(100);
      expect(y1).toBeLessThan(200);
      expect(y2).toBeGreaterThan(200);
      expect(x2 - x1).toBeLessThanOrEqual(14);
    }
  });

  test("text and colours", () => {
    expect(rgb("#0a0B0c")).toEqual([10, 11, 12]);
    expect(rgb("nonsense")).toEqual([0, 0, 0]);
    const data = textData(0, "21/11/2026", [50, 100], 12, "#000000");
    expect(data).toMatchObject({ annotationType: T.FREETEXT, value: "21/11/2026", fontSize: 12 });
    expect(data.rect[0]).toBe(50);
    expect((data.rect[1] + data.rect[3]) / 2).toBe(100);
  });

  test("selected text boxes merge into one box per line, per column", () => {
    const boxes: [number, number, number, number][] = [
      [10, 100, 60, 112],
      [60, 101, 120, 112], // same line, adjacent
      [10, 120, 80, 132], // next line
      [300, 100, 380, 112], // same line, other column
      [5, 5, 5.2, 50], // a sliver: ignored
    ];
    expect(lineBoxes(boxes)).toEqual([
      [10, 100, 120, 112],
      [300, 100, 380, 112],
      [10, 120, 80, 132],
    ]);
  });
});
