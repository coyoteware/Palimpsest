import { PermissionFlag } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, test } from "vitest";
import { describePermissions, fontInfo, uniqueFonts } from "../../src/docinfo";

describe("document facts", () => {
  test("permissions say what is not allowed", () => {
    expect(describePermissions(null)).toBe("No restrictions");
    const all = Object.values(PermissionFlag) as number[];
    expect(describePermissions(all)).toBe("No restrictions");
    expect(describePermissions(all.filter((f) => f !== PermissionFlag.COPY))).toBe("Not allowed: copying text and images");
    expect(describePermissions([PermissionFlag.PRINT, PermissionFlag.PRINT_HIGH_QUALITY, PermissionFlag.COPY_FOR_ACCESSIBILITY])).toBe(
      "Not allowed: changing the document, copying text and images, commenting, filling in forms and assembling pages",
    );
  });

  test("fonts: subset prefixes dropped, embedding noted, duplicates merged", () => {
    const a = fontInfo({ loadedName: "g_d0_f1", name: "ABCDEF+Calibri-Bold", type: "TrueType", missingFile: false });
    expect(a).toEqual({ name: "Calibri-Bold", type: "TrueType", embedded: true, subset: true });
    const b = fontInfo({ loadedName: "g_d0_f2", name: "Helvetica", type: "Type1", subtype: "Type1C", missingFile: true });
    expect(b).toEqual({ name: "Helvetica", type: "Type1 / Type1C", embedded: false, subset: false });
    expect(fontInfo({ loadedName: "x", isType3Font: true })).toMatchObject({ name: "Unnamed font", type: "Type3" });
    expect(fontInfo("not a font")).toBeNull();
    expect(fontInfo({ data: [1, 2] })).toBeNull();
    expect(uniqueFonts([b!, a!, { ...a! }]).map((f) => f.name)).toEqual(["Calibri-Bold", "Helvetica"]);
  });
});
