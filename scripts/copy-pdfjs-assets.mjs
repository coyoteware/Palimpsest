// Copies the runtime assets pdf.js loads on demand (CMaps, standard fonts,
// WASM decoders, ICC profiles, annotation icons) into public/pdfjs, so they
// ship inside the app next to the bundle.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const [from, to] of [
  ["cmaps", "cmaps"],
  ["standard_fonts", "standard_fonts"],
  ["wasm", "wasm"],
  ["iccs", "iccs"],
  ["web/images", "images"],
]) {
  cpSync(join(src, from), join(dest, to), { recursive: true });
}
console.log("pdf.js assets copied to public/pdfjs");
