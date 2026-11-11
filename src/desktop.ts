/**
 * Bridge exposed by the desktop shells: desktop/preload.cjs (Electron) or
 * src-tauri/src/bridge.js (Tauri).
 */
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
  write(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Opens the native print dialog, for shells where window.print() does not
   * work (Tauri on macOS). It returns before printing ends.
   */
  print?(): Promise<void>;
  /**
   * Called when the window's close button is pressed (Tauri). The window
   * closes if `guard` resolves true. The Electron shell asks through
   * beforeunload instead.
   */
  onCloseRequested?(guard: () => Promise<boolean>): void;
}

export const desktop: DesktopBridge | null =
  (window as unknown as { palimpsestDesktop?: DesktopBridge }).palimpsestDesktop ?? null;
