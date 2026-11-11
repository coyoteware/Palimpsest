/** Document-level undo/redo: whole-file snapshots taken before each page operation. */
export interface Snapshot {
  bytes: Uint8Array;
  label: string;
  page: number;
}

export class DocHistory {
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];

  constructor(
    private maxEntries = 40,
    private maxBytes = 768 * 1024 * 1024,
  ) {}

  get canUndo() {
    return this.#undo.length > 0;
  }
  get canRedo() {
    return this.#redo.length > 0;
  }
  get undoLabel() {
    return this.#undo.at(-1)?.label;
  }
  get redoLabel() {
    return this.#redo.at(-1)?.label;
  }

  push(snapshot: Snapshot) {
    this.#undo.push(snapshot);
    this.#redo = [];
    this.#trim();
  }

  /** Swap `current` for the previous snapshot. */
  undo(current: Snapshot): Snapshot | undefined {
    const prev = this.#undo.pop();
    if (prev) this.#redo.push({ ...current, label: prev.label });
    return prev;
  }

  redo(current: Snapshot): Snapshot | undefined {
    const next = this.#redo.pop();
    if (next) this.#undo.push({ ...current, label: next.label });
    return next;
  }

  clear() {
    this.#undo = [];
    this.#redo = [];
  }

  #trim() {
    const size = () => this.#undo.reduce((n, s) => n + s.bytes.byteLength, 0);
    while (this.#undo.length > 1 && (this.#undo.length > this.maxEntries || size() > this.maxBytes)) {
      this.#undo.shift();
    }
  }
}
