/**
 * Fill & Sign: signatures and initials typed or drawn by the user, turned
 * into transparent PNG images and, if they ask, kept on this device (in the
 * webview's storage, never anywhere else) for next time.
 */
export type SignatureKind = "signature" | "initials";

export interface SavedSignature {
  kind: SignatureKind;
  /** A PNG data URL. */
  url: string;
  /** Size of the image in pixels. */
  width: number;
  height: number;
}

const STORE = "palimpsest:signatures";
const MAX_SAVED = 6;
/** Script faces most systems have; the generic `cursive` is the last resort. */
export const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Snell Roundhand", "URW Chancery L", "Z003", cursive';
const INK = "#1b2a6b";

export function savedSignatures(): SavedSignature[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) ?? "[]") as SavedSignature[];
    return Array.isArray(list) ? list.filter((s) => typeof s?.url === "string" && s.url.startsWith("data:image/png")) : [];
  } catch {
    return [];
  }
}

function store(list: SavedSignature[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list.slice(0, MAX_SAVED)));
  } catch {
    /* storage full or unavailable: the signature is still used this time */
  }
}

export function saveSignature(sig: SavedSignature) {
  store([sig, ...savedSignatures().filter((s) => s.url !== sig.url)]);
}

export function forgetSignatures() {
  store([]);
}

/** The part of `canvas` that has ink in it, as a PNG; null if it is blank. */
export function trimmed(canvas: HTMLCanvasElement, pad = 4): Omit<SavedSignature, "kind"> | null {
  const ctx = canvas.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let [x1, y1, x2, y2] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 16) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return null;
  [x1, y1] = [Math.max(0, x1 - pad), Math.max(0, y1 - pad)];
  [x2, y2] = [Math.min(width - 1, x2 + pad), Math.min(height - 1, y2 + pad)];
  const out = document.createElement("canvas");
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext("2d")!.drawImage(canvas, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return { url: out.toDataURL("image/png"), width: out.width, height: out.height };
}

/** Text in a script face, as a signature image. */
export function typedSignature(text: string) {
  const canvas = document.createElement("canvas");
  const size = 72;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${size}px ${SCRIPT_FONT}`;
  canvas.width = Math.ceil(ctx.measureText(text).width + size);
  canvas.height = Math.ceil(size * 1.8);
  ctx.font = `${size}px ${SCRIPT_FONT}`; // resizing the canvas reset it
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, canvas.height / 2);
  return trimmed(canvas);
}

/**
 * The signature dialog: type a name or draw with the mouse, pen or finger.
 * Resolves with the image, or null if cancelled or left empty.
 */
export async function askSignature(kind: SignatureKind, show: (dialog: HTMLDialogElement) => Promise<string>) {
  const $ = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
  const dialog = $<HTMLDialogElement>("signatureDialog");
  const name = $<HTMLInputElement>("sigName");
  const preview = $("sigPreview");
  const canvas = $<HTMLCanvasElement>("sigCanvas");
  const ok = $<HTMLButtonElement>("sigOk");
  const tabs = [...dialog.querySelectorAll<HTMLElement>("[role=tab]")];
  $("sigTitle").textContent = kind === "initials" ? "Add initials" : "Add signature";
  name.placeholder = kind === "initials" ? "Your initials" : "Your name";
  name.value = "";
  preview.style.fontFamily = SCRIPT_FONT;
  preview.textContent = "";

  const ctx = canvas.getContext("2d")!;
  let drawn = false;
  const clear = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
    update();
  };
  let mode: "type" | "draw" = "type";
  const update = () => {
    preview.textContent = name.value;
    ok.disabled = mode === "type" ? !name.value.trim() : !drawn;
  };
  const choose = (m: "type" | "draw") => {
    mode = m;
    for (const t of tabs) {
      const on = t.dataset.mode === m;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")!).hidden = !on;
    }
    update();
    (m === "type" ? name : canvas).focus();
  };

  const ac = new AbortController();
  const signal = ac.signal;
  for (const t of tabs) t.addEventListener("click", () => choose(t.dataset.mode as "type" | "draw"), { signal });
  name.addEventListener("input", update, { signal });
  $("sigClear").addEventListener("click", clear, { signal });
  // Drawing: scale pointer positions to the canvas's own pixels.
  let last: [number, number] | null = null;
  const at = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  canvas.addEventListener(
    "pointerdown",
    (e) => {
      canvas.setPointerCapture(e.pointerId);
      last = at(e);
      ctx.beginPath();
      ctx.arc(last[0], last[1], 1.5, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
    },
    { signal },
  );
  canvas.addEventListener(
    "pointermove",
    (e) => {
      if (!last) return;
      const p = at(e);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(...last);
      ctx.lineTo(...p);
      ctx.stroke();
      last = p;
      drawn = true;
      update();
    },
    { signal },
  );
  canvas.addEventListener("pointerup", () => (last = null), { signal });
  clear();
  choose("type");

  try {
    if ((await show(dialog)) !== "ok") return null;
    const image = mode === "type" ? typedSignature(name.value.trim()) : trimmed(canvas);
    if (!image) return null;
    const sig: SavedSignature = { kind, ...image };
    if ($<HTMLInputElement>("sigSave").checked) saveSignature(sig);
    return sig;
  } finally {
    ac.abort();
  }
}
