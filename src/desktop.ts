/** Bridge exposed by desktop/preload.cjs when running inside the Electron shell. */
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
}

export const desktop: DesktopBridge | null =
  (window as unknown as { palimpsestDesktop?: DesktopBridge }).palimpsestDesktop ?? null;
