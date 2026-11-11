/**
 * File I/O. Uses the File System Access API when available (Chromium), so a
 * file opened from disk or from the OS "Open with" menu can be saved in place.
 * Falls back to <input type=file> and downloads elsewhere.
 */
export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
  handle: FileSystemFileHandle | null;
}

type PermissionHandle = FileSystemFileHandle & {
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};

interface PickerWindow {
  showOpenFilePicker?(o?: object): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o?: object): Promise<FileSystemFileHandle>;
}

const win = window as unknown as PickerWindow;
const PDF_TYPES = [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }];
const IMAGE_TYPES = [
  {
    description: "Image",
    accept: { "image/*": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"] },
  },
];

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export async function fromFile(file: File, handle: FileSystemFileHandle | null = null): Promise<OpenedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle };
}

export async function fromHandle(handle: FileSystemFileHandle) {
  return fromFile(await handle.getFile(), handle);
}

export const looksLikePdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

function pickViaInput(input: HTMLInputElement): Promise<File[]> {
  return new Promise((resolve) => {
    input.dataset.picking = "1";
    const done = () => {
      delete input.dataset.picking;
      input.removeEventListener("change", done);
      input.removeEventListener("cancel", done);
      const files = [...(input.files ?? [])];
      input.value = "";
      resolve(files);
    };
    input.addEventListener("change", done);
    input.addEventListener("cancel", done);
    input.click();
  });
}

/** Ask the user for PDF files. Returns [] if they cancel. */
export async function pickPdfs(fallback: HTMLInputElement, multiple = false): Promise<OpenedFile[]> {
  if (win.showOpenFilePicker) {
    try {
      const handles = await win.showOpenFilePicker({ types: PDF_TYPES, multiple, id: "pdf" });
      return Promise.all(handles.map(fromHandle));
    } catch (e) {
      if (isAbort(e)) return [];
      throw e;
    }
  }
  fallback.multiple = multiple;
  return Promise.all((await pickViaInput(fallback)).map((f) => fromFile(f)));
}

export async function pickImage(fallback: HTMLInputElement): Promise<File | null> {
  if (win.showOpenFilePicker) {
    try {
      const [handle] = await win.showOpenFilePicker({ types: IMAGE_TYPES, id: "image" });
      return handle.getFile();
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  return (await pickViaInput(fallback))[0] ?? null;
}

async function ensureWritable(handle: PermissionHandle) {
  const opts = { mode: "readwrite" as const };
  if ((await handle.queryPermission?.(opts)) === "granted") return true;
  return (await handle.requestPermission?.(opts)) !== "denied";
}

export async function writeToHandle(handle: FileSystemFileHandle, bytes: Uint8Array) {
  if (!(await ensureWritable(handle))) throw new Error("Permission to write the file was denied.");
  const stream = await handle.createWritable();
  await stream.write(bytes as Uint8Array<ArrayBuffer>);
  await stream.close();
}

/**
 * "Save as": native picker when available, otherwise a download.
 * Returns the chosen handle, null for a download, or undefined if cancelled.
 */
export async function saveAs(name: string, bytes: Uint8Array): Promise<FileSystemFileHandle | null | undefined> {
  if (win.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await win.showSaveFilePicker({ suggestedName: name, types: PDF_TYPES, id: "pdf" });
    } catch (e) {
      if (isAbort(e)) return undefined;
      throw e;
    }
    await writeToHandle(handle, bytes);
    return handle;
  }
  download(name, bytes);
  return null;
}

export function download(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const withSuffix = (name: string, suffix: string) => name.replace(/(\.pdf)?$/i, `${suffix}.pdf`);
