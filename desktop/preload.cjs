// Exposes a narrow file API to the page as window.palimpsestDesktop.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("palimpsestDesktop", {
  platform: process.platform,
  initialFile: () => ipcRenderer.invoke("desktop:initial-file"),
  openPdfs: (multiple) => ipcRenderer.invoke("desktop:open-pdfs", !!multiple),
  openImage: () => ipcRenderer.invoke("desktop:open-image"),
  saveAs: (suggestedName) => ipcRenderer.invoke("desktop:save-as", String(suggestedName)),
  write: (path, bytes) => ipcRenderer.invoke("desktop:write", String(path), bytes),
});
