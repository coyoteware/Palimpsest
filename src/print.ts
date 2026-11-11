import { desktop } from "./desktop";
import { openPdf } from "./pdfjs";

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
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: PRINT_DPI / 72 });
      if (n === 1) {
        const pt = page.getViewport({ scale: 1 });
        style.textContent = `@page { size: ${pt.width}pt ${pt.height}pt; margin: 0 }`;
        document.head.append(style);
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, intent: "print" }).promise;
      const blob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("Rendering failed"))), "image/png"),
      );
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const wrap = document.createElement("div");
      wrap.className = "print-page";
      const img = new Image();
      img.src = url;
      wrap.append(img);
      host.append(wrap);
      await img.decode();
      page.cleanup();
      onProgress(n, doc.numPages);
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
