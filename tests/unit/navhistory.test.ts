import { describe, expect, test } from "vitest";
import { NavHistory, type Place } from "../../src/navhistory";

/** A history whose "viewer" moves at once, like the real one after scrolling. */
function setup() {
  const visited: Place[] = [];
  const nav: NavHistory = new NavHistory((place) => {
    visited.push(place);
    nav.update(place);
  });
  /** Follow a link from wherever the reader is to `pageNumber`, as PDFLinkService does. */
  const jump = (pageNumber: number) => {
    nav.pushCurrentPosition();
    nav.pushPage(pageNumber);
    nav.update({ pageNumber, top: 700 });
  };
  return { nav, visited, jump };
}

describe("NavHistory", () => {
  test("goes back and forward through jumps, to where the reader was", () => {
    const { nav, visited, jump } = setup();
    expect(nav.canGoBack).toBe(false);
    nav.update({ pageNumber: 1, top: 500 });
    nav.update({ pageNumber: 2, top: 300 }); // scrolling alone records nothing
    expect(nav.canGoBack).toBe(false);
    jump(5);
    jump(9);
    expect(nav.canGoBack).toBe(true);
    expect(nav.canGoForward).toBe(false);
    nav.back();
    nav.back();
    expect(visited.map((p) => [p.pageNumber, p.top])).toEqual([
      [5, 700],
      [2, 300],
    ]);
    expect(nav.canGoBack).toBe(false);
    expect(nav.canGoForward).toBe(true);
    nav.forward();
    expect(visited.at(-1)).toEqual({ pageNumber: 5, top: 700 });
  });

  test("a new jump drops the places ahead", () => {
    const { nav, jump } = setup();
    nav.update({ pageNumber: 1 });
    jump(4);
    jump(6);
    nav.back();
    jump(2);
    expect(nav.canGoForward).toBe(false);
    nav.back();
    expect(nav.canGoForward).toBe(true);
    nav.forward();
    expect(nav.canGoForward).toBe(false);
  });

  test("remembers where the reader scrolled to before going back", () => {
    const { nav, visited, jump } = setup();
    nav.update({ pageNumber: 1 });
    jump(3);
    nav.update({ pageNumber: 4, top: 120 }); // read on from the destination
    nav.back();
    nav.forward();
    expect(visited.at(-1)).toEqual({ pageNumber: 4, top: 120 });
  });

  test("keeps a bounded number of places, and reset forgets them", () => {
    const visited: Place[] = [];
    const nav: NavHistory = new NavHistory((p) => (visited.push(p), nav.update(p)), () => {}, 3);
    nav.update({ pageNumber: 1 });
    for (const page of [2, 3, 4, 5]) {
      nav.pushCurrentPosition();
      nav.pushPage(page);
      nav.update({ pageNumber: page });
    }
    let steps = 0;
    while (nav.canGoBack) {
      nav.back();
      steps++;
    }
    expect(steps).toBe(2);
    expect(visited.at(-1)?.pageNumber).toBe(3);
    nav.reset();
    expect(nav.canGoBack || nav.canGoForward).toBe(false);
  });
});
