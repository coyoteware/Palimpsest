/**
 * Back / forward through the places a link, bookmark or typed page number
 * took the reader. PDFLinkService calls pushCurrentPosition() and then push()
 * or pushPage() for each jump, and back() / forward() for the GoBack and
 * GoForward named actions.
 */
export interface Place {
  pageNumber: number;
  /** PDF coordinates of the view's top-left corner, when known. */
  left?: number;
  top?: number;
}

export class NavHistory {
  #places: Place[] = [];
  #at = -1;
  /** Where the reader is now; kept current by the viewer's updateviewarea events. */
  #current: Place | null = null;

  constructor(
    private go: (place: Place) => void,
    private changed: () => void = () => {},
    private max = 50,
  ) {}

  get canGoBack() {
    return this.#at > 0;
  }

  get canGoForward() {
    return this.#at >= 0 && this.#at < this.#places.length - 1;
  }

  reset() {
    this.#places = [];
    this.#at = -1;
    this.#current = null;
    this.changed();
  }

  /** The view moved: the entry for where the reader is follows it. */
  update(place: Place) {
    this.#current = place;
    if (this.#at >= 0) this.#places[this.#at] = place;
  }

  /** Before a jump: remember where the reader is, dropping anything ahead. */
  pushCurrentPosition() {
    if (!this.#current) return;
    this.#places.length = this.#at + 1;
    if (this.#at < 0) {
      this.#places.push(this.#current);
      this.#at = 0;
    }
  }

  /** After a jump to a destination on `pageNumber`. */
  push({ pageNumber }: { pageNumber?: number; namedDest?: unknown; explicitDest?: unknown }) {
    if (!pageNumber) return;
    this.#add({ pageNumber });
  }

  pushPage(pageNumber: number) {
    this.#add({ pageNumber });
  }

  back() {
    if (!this.canGoBack) return;
    this.#at--;
    this.#visit();
  }

  forward() {
    if (!this.canGoForward) return;
    this.#at++;
    this.#visit();
  }

  #add(place: Place) {
    if (this.#at < 0) return; // pushCurrentPosition had no position to record
    const here = this.#places[this.#at];
    if (here.pageNumber === place.pageNumber && here.top === undefined && place.top === undefined) return;
    this.#places.length = this.#at + 1;
    this.#places.push(place);
    this.#at++;
    while (this.#places.length > this.max) {
      this.#places.shift();
      this.#at--;
    }
    this.changed();
  }

  #visit() {
    const place = this.#places[this.#at];
    this.#current = place;
    this.go(place);
    this.changed();
  }
}
