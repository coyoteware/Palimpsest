/** Bridge exposed by the desktop shell (src-tauri/src/bridge.js). */
export interface DesktopFile {
  name: string;
  path: string;
  bytes: Uint8Array;
}

export interface DesktopBridge {
  platform: string;
  initialFile(): Promise<DesktopFile | null>;
  openPdfs(multiple: boolean): Promise<DesktopFile[]>;
  openImage(): Promise<{ name: string; type: string; bytes: Uint8Array } | null>;
  saveAs(suggestedName: string): Promise<{ name: string; path: string } | null>;
  /**
   * Asks for a folder to save files with these names in, and allows writing
   * exactly those files there. `exists` is true where a file is already there.
   */
  saveToFolder(names: string[]): Promise<{
    folder: { name: string; path: string };
    files: { name: string; path: string; exists: boolean }[];
  } | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
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
