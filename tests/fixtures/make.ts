import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** A PDF whose page k shows the text "<label> k" (1-based). */
export async function numberedPdf(pages: number, label = "Page", size: [number, number] = [612, 792]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage(size);
    page.drawText(`${label} ${i}`, { x: 72, y: size[1] - 120, size: 36, font, color: rgb(0.1, 0.1, 0.1) });
  }
  doc.setTitle(`${label} fixture`);
  return doc.save();
}
