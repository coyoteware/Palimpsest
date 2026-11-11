import { openPdf } from "./pdfjs";

const PRINT_DPI = 150;

/**
 * Print by rasterising each page into <img> elements that only show under
 * @media print. Works the same in a browser tab and an installed app window.
 */
export async function printPdf(
  bytes: Uint8Array,
  password: string | undefined,
  onProgress: (done: number, total: number) => void,
) {
  const host = document.getElementById("printContainer")!;
  const style = document.createElement("style");
  const urls: string[] = [];
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
    window.print();
  } finally {
    await doc.loadingTask.destroy();
    // window.print() blocks until the dialog closes, so cleanup is safe here.
    host.textContent = "";
    style.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}
