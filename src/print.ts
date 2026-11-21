import { AnnotationMode } from "pdfjs-dist";
import { desktop } from "./desktop";
import { openPdf } from "./pdfjs";

export interface PrintOptions {
  /** 0-based page indices, in the order to print them. */
  pages: number[];
  /** Print comments and markup (form fields always print). */
  annotations: boolean;
  /** Scale each page to the paper, or print it at its own size. */
  size: "fit" | "actual";
}

const PRINT_DPI = 150;

/** Removes the pages of a print a non-blocking print dialog may still be reading. */
let clearPendingPrint: (() => void) | null = null;

/**
 * Print by rasterising each page into <img> elements that only show under
 * @media print. Works the same in a browser tab and an installed app window.
 */
export async function printPdf(
  bytes: Uint8Array,
  password: string | undefined,
  onProgress: (done: number, total: number) => void,
  opts?: Partial<PrintOptions>,
) {
  clearPendingPrint?.();
  const host = document.getElementById("printContainer")!;
  const style = document.createElement("style");
  const urls: string[] = [];
  const clear = () => {
    window.removeEventListener("afterprint", clear);
    host.textContent = "";
    style.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
    if (clearPendingPrint === clear) clearPendingPrint = null;
  };
  let keepPages = false;
  const { doc } = await openPdf(bytes, { password });
  try {
    host.textContent = "";
    const pages = opts?.pages ?? Array.from({ length: doc.numPages }, (_, i) => i);
    for (const [k, index] of pages.entries()) {
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: PRINT_DPI / 72 });
      const pt = page.getViewport({ scale: 1 });
      if (k === 0) {
        style.textContent = `@page { size: ${pt.width}pt ${pt.height}pt; margin: 0 }`;
        document.head.append(style);
      }
      if (opts?.annotations === false) {
        // Leave out everything but form fields: pdf.js skips annotations marked noPrint.
        for (const a of await page.getAnnotations({ intent: "print" })) {
          if (a.subtype !== "Widget") doc.annotationStorage.setValue(a.id, { noPrint: true });
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, intent: "print", annotationMode: AnnotationMode.ENABLE_STORAGE }).promise;
      const blob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("Rendering failed"))), "image/png"),
      );
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const wrap = document.createElement("div");
      wrap.className = "print-page";
      const img = new Image();
      img.src = url;
      if (opts?.size === "actual") {
        wrap.classList.add("actual-size");
        Object.assign(img.style, { width: `${pt.width}pt`, height: `${pt.height}pt` });
      }
      wrap.append(img);
      host.append(wrap);
      await img.decode();
      page.cleanup();
      onProgress(k + 1, pages.length);
    }
    if (desktop?.print) {
      // The native dialog returns at once and reads the pages while it is open,
      // so keep them until printing ends (or until the next print, if no
      // afterprint event comes).
      keepPages = true;
      clearPendingPrint = clear;
      window.addEventListener("afterprint", clear);
      await desktop.print().catch((e: unknown) => {
        keepPages = false;
        throw e;
      });
    } else {
      // window.print() blocks until the dialog closes.
      window.print();
    }
  } finally {
    await doc.loadingTask.destroy();
    if (!keepPages) clear();
  }
}
