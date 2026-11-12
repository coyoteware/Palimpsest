// Writes a one-page PDF to the path given on the command line (used by scripts/test-installer.ps1).
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([612, 792]).drawText("Palimpsest installer test", { x: 72, y: 700, size: 24, font });
writeFileSync(process.argv[2], await doc.save());
