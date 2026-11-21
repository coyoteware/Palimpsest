// Minimal 24px stroke icon set (original artwork, MIT like the rest of the project).
const paths: Record<string, string> = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><path d="M7 21v-7h10v7"/>',
  saveAs: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  print: '<path d="M6 9V3h12v6"/><path d="M6 17H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pointer: '<path d="M5 3l6.5 17 2.4-7.1L21 10.5z"/>',
  text: '<path d="M5 7V4h14v3"/><path d="M12 4v16"/><path d="M9 20h6"/>',
  pen: '<path d="M4 20l4-1L19.3 7.7a2.1 2.1 0 0 0-3-3L5 16z"/><path d="M14.5 6.5l3 3"/>',
  highlight: '<path d="M9 11l-5 5v4h4l5-5"/><path d="M9 11l6-6 4 4-6 6z"/><path d="M14 20h7"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-10 8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  rotateCcw: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotateCw: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  blankPage: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15h6"/>',
  insertPdf: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 11v7"/><path d="m9 15 3 3 3-3"/>',
  extract: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 18v-7"/><path d="m9 14 3-3 3 3"/>',
  split: '<rect x="5" y="3" width="14" height="6" rx="1.5"/><rect x="5" y="15" width="14" height="6" rx="1.5"/><path d="M2.5 12h3M10.5 12h3M18.5 12h3"/>',
  merge: '<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="8" rx="1.5"/><path d="M6.5 11v1.5a3 3 0 0 0 3 3h5a3 3 0 0 0 3-3V11"/><path d="M12 15.5V21"/><path d="m9.5 18.5 2.5 2.5 2.5-2.5"/>',
  back: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  forward: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  layout: '<rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/>',
  pages: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  bookmark: '<path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z"/>',
  paperclip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14.5 7"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  shapes: '<rect x="3" y="3" width="10" height="10" rx="1"/><circle cx="15.5" cy="15.5" r="5.5"/>',
  underline: '<path d="M7 4v6a5 5 0 0 0 10 0V4"/><path d="M5 20h14"/>',
  strikeout: '<path d="M16 6.5C15.3 5 13.8 4 12 4c-2.5 0-4 1.4-4 3.2 0 1.6 1.2 2.4 3 2.8"/><path d="M4 12h16"/><path d="M8 17.5c.7 1.5 2.2 2.5 4 2.5 2.5 0 4-1.4 4-3.2 0-.8-.3-1.4-.8-1.8"/>',
  squiggly: '<path d="M7 4v5a5 5 0 0 0 10 0V4"/><path d="m3 19 2-2 2 2 2-2 2 2 2-2 2 2 2-2 2 2 2-2"/>',
  signature: '<path d="M3 17c3-5 5-9 7-9s-1 9 1 9 3-5 5-5-1 5 1 5 2-2 4-2"/><path d="M3 21h18"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5"/><path d="M10 5h9v9"/>',
  note: '<path d="M4 4h16v12h-6l-4 4v-4H4z"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5"/><path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v6"/><path d="M17 12V9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.3 15.4a1.6 1.6 0 0 1 2.4-2.1L8 14.5"/>',
  zoomArea: '<path d="M3 8V4a1 1 0 0 1 1-1h4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4"/><circle cx="14" cy="14" r="4"/><path d="m21 21-4.2-4.2"/><path d="M14 12v4M12 14h4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  exportImage: '<rect x="3" y="3" width="13" height="13" rx="1.5"/><circle cx="7.5" cy="7.5" r="1.3"/><path d="m16 11-3-3-8 8"/><path d="M19 13v8"/><path d="m16 18 3 3 3-3"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  logo: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M15 2v5h5"/><path d="M8 17c2-1 3-4 5-4s1 3 3 2"/>',
};

export function icon(name: string): string {
  const body = paths[name];
  if (!body) throw new Error(`Unknown icon ${name}`);
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** Fill every `[data-icon]` element with its icon, before any existing label. */
export function hydrateIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon!));
  }
}
