// PDF helpers shared by the test suites.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { samplePdf } from "./sample";

/** Decode a saved PDF with pdf.js: page headings, text, annotations and metadata. */
export async function inspect(bytes: Uint8Array, password?: string) {
  const doc = await getDocument({ data: bytes.slice(), password, standardFontDataUrl: STANDARD_FONTS }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const text = (await p.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
    const heading = /Page (\d)/.exec(text)?.[0] ?? "";
    const annotations = (await p.getAnnotations()).map((a) => ({
      subtype: a.subtype as string,
      contents: (a.contentsObj?.str ?? a.textContent?.join("\n") ?? "") as string,
      fieldName: a.fieldName as string | undefined,
      fieldValue: a.fieldValue as unknown,
      color: a.color ? `#${[...(a.color as Uint8ClampedArray)].map((c) => c.toString(16).padStart(2, "0")).join("")}` : null,
      borderWidth: (a.borderStyle?.width ?? null) as number | null,
    }));
    pages.push({ rotate: p.rotate, heading, text, annotations });
  }
  const meta = (await doc.getMetadata()).info as Record<string, string>;
  await doc.loadingTask.destroy();
  return { pages, meta };
}

// pdf.js wants a trailing "/" (not "\\"), so use forward slashes on Windows too.
const STANDARD_FONTS = `${join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts").replaceAll("\\", "/")}/`;

let samplePath: string | null = null;
export async function sampleFile() {
  if (!samplePath) {
    samplePath = join(mkdtempSync(join(tmpdir(), "palimpsest-")), "sample.pdf");
    writeFileSync(samplePath, await samplePdf());
  }
  return samplePath;
}

/** A tiny solid-color PNG, base64-encoded. */
export const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAATUlEQVR4nO3PQQkAMAzAwMqpfz0TMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBY9dWR5giA9/HCIAAAAASUVORK5CYII=";
