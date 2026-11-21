/** What the Document properties dialog says about a file beyond its title and author. */

/** pdf.js's PermissionFlag values, and what each allows. */
const PERMISSIONS: [number, string][] = [
  [0x04, "printing"],
  [0x800, "high-quality printing"],
  [0x08, "changing the document"],
  [0x10, "copying text and images"],
  [0x200, "copying for accessibility"],
  [0x20, "commenting"],
  [0x100, "filling in forms"],
  [0x400, "assembling pages"],
];

/**
 * What the document's permissions (pdf.js's getPermissions(): the flags
 * granted, or null for no restrictions) leave out, as a sentence.
 */
export function describePermissions(granted: Iterable<number> | null): string {
  if (!granted) return "No restrictions";
  const allowed = new Set(granted);
  const denied = PERMISSIONS.filter(([flag]) => !allowed.has(flag)).map(([, what]) => what);
  if (!denied.length) return "No restrictions";
  const list = denied.length === 1 ? denied[0] : `${denied.slice(0, -1).join(", ")} and ${denied.at(-1)}`;
  return `Not allowed: ${list}`;
}

export interface FontInfo {
  /** As named in the file, without a subset prefix ("ABCDEF+"). */
  name: string;
  /** Type1, TrueType, Type0 (composite), Type3… */
  type: string;
  embedded: boolean;
  /** Only the characters used are embedded. */
  subset: boolean;
}

/** A font object pdf.js loaded (with fontExtraProperties on), as the list shows it; null if it is not a font. */
export function fontInfo(obj: unknown): FontInfo | null {
  const f = obj as { name?: unknown; loadedName?: unknown; type?: unknown; subtype?: unknown; missingFile?: unknown; isType3Font?: unknown } | null;
  if (!f || typeof f !== "object" || typeof f.loadedName !== "string") return null;
  const raw = typeof f.name === "string" && f.name ? f.name : "Unnamed font";
  const subset = /^[A-Z]{6}\+/.test(raw);
  const type = f.isType3Font ? "Type3" : [f.type, f.subtype].filter((t) => typeof t === "string" && t).join(" / ") || "Unknown";
  return { name: subset ? raw.slice(7) : raw, type, embedded: !f.missingFile, subset };
}

/** One entry per font, sorted by name. */
export function uniqueFonts(fonts: FontInfo[]): FontInfo[] {
  const seen = new Map<string, FontInfo>();
  for (const f of fonts) {
    const key = `${f.name}|${f.type}|${f.embedded}|${f.subset}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const yesNo = (v: unknown) => (v ? "Yes" : "No");
