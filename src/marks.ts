/**
 * Shapes, text markup and Fill & Sign marks, as the data pdf.js's annotation
 * editors are restored from (what they copy to the clipboard). Ink becomes an
 * Ink annotation and text a FreeText annotation, both editable afterwards like
 * anything drawn by hand. All coordinates are PDF points on the page.
 */

/** pdf.js's AnnotationEditorType values (kept here so this module loads without pdf.js; a unit test checks them). */
export const T = { FREETEXT: 3, STAMP: 13, INK: 15 } as const;

export type Point = [number, number];
export type Rect = [number, number, number, number];
export type Shape = "rect" | "ellipse" | "line" | "arrow";
export type Markup = "underline" | "strikeout" | "squiggly";
export type Mark = "check" | "cross" | "dot";

export interface Stroke {
  color: string;
  thickness: number;
  /** 0–1 */
  opacity: number;
}

/** What `AnnotationEditorLayer.deserialize` takes for each kind of editor. */
export type EditorData = Record<string, unknown> & { annotationType: number; pageIndex: number; rect: Rect };

/** "#rrggbb" → [r, g, b] (0–255). */
export function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

/** Polylines (each a list of points) as an Ink editor: straight segments, no smoothing. */
export function inkData(pageIndex: number, polylines: Point[][], stroke: Stroke): EditorData {
  const lines = polylines.map((pts) => {
    // pdf.js stores a stroke as cubic segments [cp1x, cp1y, cp2x, cp2y, x, y] after a start
    // point [NaN, NaN, NaN, NaN, x, y]. A segment whose control points are its own ends is
    // straight (NaN control points work only in two-point strokes).
    const line = new Float32Array(pts.length * 6).fill(NaN);
    pts.forEach(([x, y], i) => {
      if (i === 0) line.set([x, y], 4);
      else line.set([...pts[i - 1], x, y, x, y], i * 6);
    });
    return line;
  });
  const points = polylines.map((pts) => new Float32Array(pts.flat()));
  return {
    annotationType: T.INK,
    color: rgb(stroke.color),
    thickness: stroke.thickness,
    opacity: stroke.opacity,
    paths: { lines, points },
    boxes: null,
    pageIndex,
    rect: bounds(polylines.flat(), stroke.thickness),
    rotation: 0,
  };
}

/** The bounding box of `points`, grown by half a stroke (and at least a little). */
export function bounds(points: Point[], thickness = 0): Rect {
  const pad = Math.max(thickness / 2, 1);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

/** A shape dragged from `a` to `b`. */
export function shapePaths(shape: Shape, a: Point, b: Point, thickness: number): Point[][] {
  const [x1, y1] = a;
  const [x2, y2] = b;
  switch (shape) {
    case "rect":
      return [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]];
    case "ellipse": {
      const [cx, cy, rx, ry] = [(x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2];
      const n = 72;
      const pts = Array.from({ length: n }, (_, i): Point => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)]);
      return [[...pts, pts[0]]];
    }
    case "line":
      return [[a, b]];
    case "arrow": {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(8, thickness * 4);
      const wing = (side: number): Point => [x2 - head * Math.cos(angle + side * 0.45), y2 - head * Math.sin(angle + side * 0.45)];
      return [[a, b], [wing(1), b, wing(-1)]];
    }
  }
}

/**
 * Underline, strike through or squiggle the text in `boxes` (one per line of
 * selected text, as [left, bottom, right, top]).
 */
export function markupPaths(kind: Markup, boxes: Rect[]): { paths: Point[][]; thickness: number } {
  const heights = boxes.map(([, y1, , y2]) => Math.abs(y2 - y1));
  const thickness = Math.max(0.75, Math.min(...heights) * 0.07);
  const paths = boxes.map(([x1, y1, x2, y2]): Point[] => {
    const [bottom, top] = [Math.min(y1, y2), Math.max(y1, y2)];
    const h = top - bottom;
    if (kind === "strikeout") {
      const y = bottom + h * 0.45;
      return [[x1, y], [x2, y]];
    }
    // Just below the baseline (glyph boxes include the descent).
    const y = bottom + h * 0.12;
    if (kind === "underline") return [[x1, y], [x2, y]];
    const step = Math.max(2, h * 0.12);
    const pts: Point[] = [];
    for (let x = x1, up = false; x < x2; x += step, up = !up) pts.push([x, up ? y + step / 2 : y - step / 2]);
    pts.push([x2, y]);
    return pts;
  });
  return { paths, thickness };
}

/**
 * Merge the boxes of selected text (screen coordinates: left, top, right,
 * bottom) into one box per line: boxes that share a line and are close
 * together. Text in another column on the same line stays separate.
 */
export function lineBoxes(boxes: Rect[]): Rect[] {
  const sorted = boxes.filter(([l, t, r, b]) => r - l > 0.5 && b - t > 0.5).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines: Rect[] = [];
  for (const box of sorted) {
    const mid = (box[1] + box[3]) / 2;
    const gap = (box[3] - box[1]) * 1.5;
    const line = lines.find(([l, t, r, b]) => mid > t && mid < b && box[0] <= r + gap && box[2] >= l - gap);
    if (line) {
      line[0] = Math.min(line[0], box[0]);
      line[1] = Math.min(line[1], box[1]);
      line[2] = Math.max(line[2], box[2]);
      line[3] = Math.max(line[3], box[3]);
    } else lines.push([...box]);
  }
  return lines;
}

/** A check mark, cross or dot of `size` points centred on `at`. */
export function markPaths(mark: Mark, [x, y]: Point, size: number): Point[][] {
  const s = size / 2;
  switch (mark) {
    case "check":
      return [[[x - s, y], [x - s * 0.3, y - s * 0.7], [x + s, y + s * 0.8]]];
    case "cross":
      return [[[x - s, y - s], [x + s, y + s]], [[x - s, y + s], [x + s, y - s]]];
    case "dot": {
      // A filled dot: a thick stroke around a small circle.
      const r = s / 4;
      return [Array.from({ length: 25 }, (_, i): Point => [x + r * Math.cos((Math.PI * i) / 12), y + r * Math.sin((Math.PI * i) / 12)])];
    }
  }
}

/** A line of text (a FreeText editor) whose left edge is at `at`, vertically centred on it. */
export function textData(pageIndex: number, text: string, [x, y]: Point, fontSize: number, color: string): EditorData {
  const width = Math.max(fontSize, text.length * fontSize * 0.6);
  const height = fontSize * 1.35;
  return {
    annotationType: T.FREETEXT,
    color: rgb(color),
    fontSize,
    value: text,
    pageIndex,
    rect: [x, y - height / 2, x + width, y + height / 2],
    rotation: 0,
    // pdf.js fills in the text of a FreeText editor it restores only for a copy.
    isCopy: true,
  };
}

/** An image (a Stamp editor) `width` × `height` points, centred on `at`. */
export function imageData(pageIndex: number, url: string, [x, y]: Point, width: number, height: number): EditorData {
  return {
    annotationType: T.STAMP,
    bitmapUrl: url,
    pageIndex,
    rect: [x - width / 2, y - height / 2, x + width / 2, y + height / 2],
    rotation: 0,
    isSvg: false,
  };
}

/** Today's date as the user's locale writes it. */
export const today = (date = new Date()) => date.toLocaleDateString();
