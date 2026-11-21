import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";

/**
 * A one-page form whose JavaScript adds two fields: "total" is calculated
 * from "a" and "b" and shown as currency ("$5.00"), and "a" only takes numbers.
 */
export async function scriptedFormPdf() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const js = (code: string) => ctx.obj({ S: "JavaScript", JS: PDFHexString.fromText(code) });
  const fields = ["a", "b", "total"].map((name, i) => {
    const y = 680 - i * 50;
    page.drawText(`${name}:`, { x: 54, y: y + 6, size: 14, font });
    const field = form.createTextField(name);
    field.addToPage(page, { x: 120, y, width: 200, height: 26 });
    return field;
  });
  const [a, , total] = fields;
  a.acroField.dict.set(PDFName.of("AA"), ctx.obj({ K: js("AFNumber_Keystroke(0, 0, 0, 0, '', true);") }));
  total.acroField.dict.set(
    PDFName.of("AA"),
    ctx.obj({
      C: js('event.value = Number(this.getField("a").value) + Number(this.getField("b").value);'),
      F: js("AFNumber_Format(2, 0, 0, 0, '$', true);"),
    }),
  );
  total.enableReadOnly();
  form.acroForm.dict.set(PDFName.of("CO"), ctx.obj([total.ref]));
  doc.setTitle("Scripted form");
  return doc.save({ updateFieldAppearances: true });
}
