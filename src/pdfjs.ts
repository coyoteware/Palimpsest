import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Base URL of the pdf.js runtime assets copied by scripts/copy-pdfjs-assets.mjs. */
const assetBase = new URL("pdfjs/", document.baseURI).href;

export const PDFJS_ASSETS = {
  cMapUrl: `${assetBase}cmaps/`,
  standardFontDataUrl: `${assetBase}standard_fonts/`,
  wasmUrl: `${assetBase}wasm/`,
  iccUrl: `${assetBase}iccs/`,
  imageResourcesPath: `${assetBase}images/`,
};

export interface OpenOptions {
  password?: string;
  /** Called when the document needs a password. Resolve with the password or null to abort. */
  askPassword?: (incorrect: boolean) => Promise<string | null>;
}

export async function openPdf(data: Uint8Array, opts: OpenOptions = {}) {
  const task = pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker; keep the caller's copy intact.
    data: data.slice(),
    password: opts.password,
    cMapUrl: PDFJS_ASSETS.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_ASSETS.standardFontDataUrl,
    wasmUrl: PDFJS_ASSETS.wasmUrl,
    iccUrl: PDFJS_ASSETS.iccUrl,
    enableXfa: true,
  });
  let password = opts.password;
  task.onPassword = async (update: (pw: string) => void, reason: number) => {
    const pw = await opts.askPassword?.(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) {
      task.destroy();
      return;
    }
    password = pw;
    update(pw);
  };
  const doc = await task.promise;
  return { doc, password };
}

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
