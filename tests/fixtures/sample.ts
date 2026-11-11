import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PARAGRAPH =
  "A palimpsest is a manuscript page that has been scraped clean and written over, " +
  "yet still carries traces of what came before. This sample page exists to exercise " +
  "rendering, text selection, search, annotation and page reorganisation.";

/** Five-page sample with headings, body text, and a small form on page 1. */
export async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  for (let n = 1; n <= 5; n++) {
    const page = doc.addPage([612, 792]);
    page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.18, 0.36, 0.83) });
    page.drawText(`Chapter ${n}`, { x: 54, y: 760, size: 18, font: bold, color: rgb(1, 1, 1) });
    page.drawText(`Page ${n}`, { x: 54, y: 690, size: 32, font: bold });
    let y = 650;
    const words = PARAGRAPH.split(" ");
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, 12) > 500) {
        page.drawText(line, { x: 54, y, size: 12, font });
        y -= 18;
        line = w;
      } else line = next;
    }
    page.drawText(line, { x: 54, y, size: 12, font });
    page.drawText(`Unique marker zebra${n}`, { x: 54, y: y - 40, size: 12, font });
    if (n === 1) {
      page.drawText("Name:", { x: 54, y: 470, size: 12, font });
      const name = form.createTextField("name");
      name.addToPage(page, { x: 110, y: 462, width: 240, height: 24 });
      const agree = form.createCheckBox("agree");
      page.drawText("I agree", { x: 84, y: 430, size: 12, font });
      agree.addToPage(page, { x: 54, y: 426, width: 18, height: 18 });
    }
  }
  doc.setTitle("Palimpsest sample");
  return doc.save();
}
