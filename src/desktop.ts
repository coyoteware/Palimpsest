/** Bridge exposed by the desktop shell (src-tauri/src/bridge.js). */
export interface DesktopFile {
  name: string;
  path: string;
  bytes: Uint8Array;
}

/** What a save dialog offers to save. */
export type FileKind = "pdf" | "png" | "jpeg" | "any";

export interface DesktopBridge {
  platform: string;
  initialFile(): Promise<DesktopFile | null>;
  openPdfs(multiple: boolean): Promise<DesktopFile[]>;
  openImage(): Promise<{ name: string; type: string; bytes: Uint8Array } | null>;
  /** Asks where to save a file of `kind` (default "pdf"; "any" for an attachment). */
  saveAs(suggestedName: string, kind?: FileKind): Promise<{ name: string; path: string } | null>;
  /**
   * Asks for a folder to save files with these names in, and allows writing
   * exactly those files there. `exists` is true where a file is already there.
   */
  saveToFolder(names: string[], kind?: FileKind): Promise<{
    folder: { name: string; path: string };
    files: { name: string; path: string; exists: boolean }[];
  } | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Puts the window in or out of full screen (presentation mode). */
  setFullscreen(on: boolean): Promise<void>;
  /**
   * Opens the native print dialog where window.print() does not work (macOS,
   * whose WKWebView ignores it). It returns before printing ends.
   */
  print?(): Promise<void>;
  /** Called when the window's close button is pressed; the window closes if `guard` resolves true. */
  onCloseRequested(guard: () => Promise<boolean>): void;
}

const bridge = (window as unknown as { palimpsestDesktop?: DesktopBridge }).palimpsestDesktop;

/** False when the page is opened outside the shell (e.g. the Vite dev server in a browser). */
export const inDesktopShell = bridge !== undefined;

export const desktop = bridge as DesktopBridge;
