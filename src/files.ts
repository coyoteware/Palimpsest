/**
 * File I/O through the desktop shell (src-tauri): native dialogs, and reads
 * and writes limited to files the user picked or opened the app with.
 */
import { desktop, type DesktopFile } from "./desktop";

/** Somewhere a document can be written back to. */
export interface SaveTarget {
  readonly name: string;
  write(bytes: Uint8Array): Promise<void>;
}

export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
  target: SaveTarget | null;
}

const pathTarget = (name: string, path: string): SaveTarget => ({
  name,
  write: (bytes) => desktop.write(path, bytes),
});

export const fromDesktop = (f: DesktopFile): OpenedFile => ({
  name: f.name,
  bytes: f.bytes,
  target: pathTarget(f.name, f.path),
});

/** A file dropped on the window. It has no path, so saving it asks where. */
export async function fromFile(file: File): Promise<OpenedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), target: null };
}

export const looksLikePdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** Ask the user for PDF files. Returns [] if they cancel. */
export async function pickPdfs(multiple = false): Promise<OpenedFile[]> {
  return (await desktop.openPdfs(multiple)).map(fromDesktop);
}

/** Ask the user for an image. Returns null if they cancel. */
export async function pickImage(): Promise<File | null> {
  const img = await desktop.openImage();
  return img && new File([img.bytes as Uint8Array<ArrayBuffer>], img.name, { type: img.type });
}

/** "Save as": returns where it was saved, or undefined if cancelled. */
export async function saveAs(name: string, bytes: Uint8Array): Promise<SaveTarget | undefined> {
  const chosen = await desktop.saveAs(name);
  if (!chosen) return undefined;
  const target = pathTarget(chosen.name, chosen.path);
  await target.write(bytes);
  return target;
}

export const withSuffix = (name: string, suffix: string) => name.replace(/(\.pdf)?$/i, `${suffix}.pdf`);
