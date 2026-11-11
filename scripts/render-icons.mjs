// Regenerates the app icons in src-tauri/icons from src-tauri/icons/icon.svg
// (run `npm run icons` after editing the SVG).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const icons = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
const out = mkdtempSync(join(tmpdir(), "palimpsest-icons-"));
try {
  const r = spawnSync("npx", ["tauri", "icon", join(icons, "icon.svg"), "-o", out], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  // `tauri icon` also writes mobile and Windows Store sizes; keep the desktop set tauri.conf.json uses.
  for (const file of ["32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico", "icon.png"]) {
    copyFileSync(join(out, file), join(icons, file));
  }
  console.log("icons written to src-tauri/icons");
} finally {
  rmSync(out, { recursive: true, force: true });
}
