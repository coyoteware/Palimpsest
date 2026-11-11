import { expect, type Page } from "@playwright/test";
import { sampleFile } from "../fixtures/pdf";

export { PNG_RED, inspect, sampleFile } from "../fixtures/pdf";

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

export async function openSample(page: Page) {
  await page.goto("./");
  await page.setInputFiles("#fileInput", await sampleFile());
  await expect(page.locator("#pageCount")).toHaveText("/ 5");
  await expect(page.locator(".thumb")).toHaveCount(5);
  // Wait until the first page has a text layer, i.e. is fully rendered.
  await expect(page.locator('.page[data-page-number="1"] .textLayer span').first()).toBeVisible();
}

export const thumb = (page: Page, i: number) => page.locator(`.thumb[data-index="${i}"]`);
export const pageCount = (page: Page) => page.locator("#pageCount");
