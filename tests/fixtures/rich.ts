import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFOperator,
  PDFRef,
  PDFString,
  StandardFonts,
  rgb,
  type PDFContext,
  type PDFDict,
} from "pdf-lib";

interface Bookmark {
  title: string;
  page: number;
  open?: boolean;
  children?: Bookmark[];
}

/** Chapter structure of the rich sample: what its bookmarks point at. */
export const BOOKMARKS: Bookmark[] = [
  { title: "Preface", page: 1 },
  {
    title: "Chapter 1",
    page: 3,
    open: true,
    children: [
      { title: "Section 1.1", page: 4 },
      { title: "Section 1.2", page: 5 },
    ],
  },
  { title: "Appendix", page: 6, children: [{ title: "Notes", page: 6 }] },
];

/** Page labels of the rich sample: two front-matter pages, then 1–4. */
export const LABELS = ["i", "ii", "1", "2", "3", "4"];

/** The layer's red box on page 2: where it is, in PDF points from the bottom left. */
export const LAYER_BOX = { x: 100, y: 300, width: 200, height: 150 };

/**
 * Six pages with page labels, nested bookmarks, a link on page 1 to page 5,
 * an attached text file, and a layer ("Watermark") holding a red box on page 2.
 */
export async function richPdf() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 6; n++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Rich page ${n} (${LABELS[n - 1]})`, { x: 54, y: 700, size: 28, font });
  }
  const pages = doc.getPages();
  const dest = (page: number) => ctx.obj([pages[page - 1].ref, PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull]);

  doc.catalog.set(PDFName.of("PageLabels"), ctx.obj({ Nums: [0, { S: "r" }, 2, { S: "D" }] }));
  doc.catalog.set(PDFName.of("Outlines"), outline(ctx, BOOKMARKS, dest));
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  // A link on page 1 to page 5.
  pages[0].drawText("Go to section 1.2", { x: 54, y: 600, size: 18, font, color: rgb(0, 0, 0.8) });
  const link = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [50, 590, 260, 620], Border: [0, 0, 0], Dest: dest(5) }),
  );
  pages[0].node.set(PDFName.of("Annots"), ctx.obj([link]));

  await doc.attach(new TextEncoder().encode("Attached notes for the rich sample.\n"), "notes.txt", {
    mimeType: "text/plain",
    description: "Reading notes",
  });

  // A layer with a red box on page 2.
  const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("Watermark") }));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { ON: [ocg], Order: [ocg] } }));
  const page2 = pages[1];
  const resources = page2.node.Resources()!;
  resources.set(PDFName.of("Properties"), ctx.obj({ oc1: ocg }));
  page2.pushOperators(PDFOperator.of("BDC" as never, [PDFName.of("OC"), PDFName.of("oc1")]));
  page2.drawRectangle({ ...LAYER_BOX, color: rgb(1, 0, 0) });
  page2.pushOperators(PDFOperator.of("EMC" as never));

  doc.setTitle("Rich sample");
  return doc.save();
}

/** An outline (bookmark) tree as PDF objects; returns the root's reference. */
function outline(ctx: PDFContext, items: Bookmark[], dest: (page: number) => PDFArray): PDFRef {
  const root = ctx.nextRef();
  const build = (list: Bookmark[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = list.length;
    list.forEach((item, i) => {
      const dict = ctx.obj({}) as PDFDict;
      dict.set(PDFName.of("Title"), PDFHexString.fromText(item.title));
      dict.set(PDFName.of("Parent"), parent);
      dict.set(PDFName.of("Dest"), dest(item.page));
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
      if (item.children?.length) {
        const kids = build(item.children, refs[i]);
        dict.set(PDFName.of("First"), kids.first);
        dict.set(PDFName.of("Last"), kids.last);
        // Positive: shown open; negative: closed.
        dict.set(PDFName.of("Count"), ctx.obj(item.open ? kids.count : -kids.count));
        if (item.open) count += kids.count;
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs.at(-1)!, count };
  };
  const top = build(items, root);
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: top.count }));
  return root;
}
