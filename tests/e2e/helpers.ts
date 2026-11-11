import { expect, type Page } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { samplePdf } from "../fixtures/sample";

/**
 * Replace the native save picker with an in-memory one so saves can be
 * inspected. Each write is recorded on window.__saved as base64.
 */
export async function stubSavePicker(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __saved: { name: string; data: string }[]; showSaveFilePicker: unknown };
    w.__saved = [];
    const handle = (name: string) => ({
      kind: "file",
      name,
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
      createWritable: async () => {
        const chunks: BlobPart[] = [];
        return {
          write: async (d: BlobPart) => void chunks.push(d),
          close: async () => {
            const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            w.__saved.push({ name, data: btoa(bin) });
          },
        };
      },
    });
    w.showSaveFilePicker = async (opts?: { suggestedName?: string }) => handle(opts?.suggestedName ?? "out.pdf");
  });
}

/**
 * Make showOpenFilePicker return in-memory files. `files` maps a picker id
 * ("pdf" or "image") to a base64 payload, file name and MIME type. The picked
 * handle records writes like the save picker does.
 */
export async function stubOpenPicker(page: Page, files: Record<string, { name: string; type: string; data: string }>) {
  await page.addInitScript((files) => {
    const w = window as unknown as {
      __saved: { name: string; data: string }[];
      showOpenFilePicker: unknown;
      showSaveFilePicker: (o: object) => Promise<{ createWritable: unknown }>;
    };
    w.showOpenFilePicker = async (opts: { id?: string }) => {
      const f = files[opts?.id ?? "pdf"];
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const saveHandle = await w.showSaveFilePicker({ suggestedName: f.name });
      return [
        {
          kind: "file",
          name: f.name,
          getFile: async () => new File([bytes], f.name, { type: f.type }),
          queryPermission: async () => "granted",
          requestPermission: async () => "granted",
          createWritable: saveHandle.createWritable,
        },
      ];
    };
  }, files);
}

export async function lastSaved(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __saved: unknown[] }).__saved.length)).toBeGreaterThan(0);
  const { name, data } = await page.evaluate(() => {
    const s = (window as unknown as { __saved: { name: string; data: string }[] }).__saved;
    return s[s.length - 1];
  });
  return { name, bytes: new Uint8Array(Buffer.from(data, "base64")) };
}

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

const STANDARD_FONTS = join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts/");

let samplePath: string | null = null;
export async function sampleFile() {
  if (!samplePath) {
    samplePath = join(mkdtempSync(join(tmpdir(), "palimpsest-")), "sample.pdf");
    writeFileSync(samplePath, await samplePdf());
  }
  return samplePath;
}

export async function openSample(page: Page) {
  await page.goto("./");
  await page.setInputFiles("#fileInput", await sampleFile());
  await expect(page.locator("#pageCount")).toHaveText("/ 5");
  await expect(page.locator(".thumb")).toHaveCount(5);
  // Wait until the first page has a text layer, i.e. is fully rendered.
  await expect(page.locator('.page[data-page-number="1"] .textLayer span').first()).toBeVisible();
}

/** A tiny solid-color PNG, base64-encoded. */
export const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAATUlEQVR4nO3PQQkAMAzAwMqpfz0TMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBY9dWR5giA9/HCIAAAAASUVORK5CYII=";

export const thumb = (page: Page, i: number) => page.locator(`.thumb[data-index="${i}"]`);
export const pageCount = (page: Page) => page.locator("#pageCount");
