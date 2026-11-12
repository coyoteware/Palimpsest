/**
 * Shared scaffolding for the end-to-end tests: launching the app over
 * WebDriver, answering its file dialogs, reading what the shell did, and
 * pointing at places on a page. The app is a test build (`--features e2e`,
 * see src-tauri/src/e2e.rs); tests/e2e/setup.ts starts the driver.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, inject } from "vitest";
import { inspect, sampleFile } from "../fixtures/pdf";
import { Session } from "./webdriver";

const hooks = inject("hooks");
let current: Session | null = null;

/**
 * Start the app, opening `files` as if passed on the command line, and wait
 * until it has started (msedgedriver hands over the session before the page
 * has loaded). Files go as `--open=<path>`: msedgedriver turns every argument
 * into a `--` switch.
 */
export async function launch(...files: string[]) {
  const app = (current = await Session.start(inject("driver"), inject("binary"), files.map((f) => `--open=${f}`)));
  const started = () =>
    app.exec<boolean>("return document.readyState === 'complete' && !!window.palimpsest").catch(() => false);
  await poll(started, STARTUP).toBe(true);
  return app;
}

/** For tests that close the app themselves: end the session without checking the page. */
export async function closed() {
  await current?.end();
  current = null;
}

/** Per test: no dialog answers, an empty log, and afterwards no errors in the page. */
export function useApp() {
  beforeEach(() => {
    answer({});
    writeFileSync(join(hooks, "log.jsonl"), "");
  });
  afterEach(async () => {
    if (!current) return;
    // Recorded by test builds only; a release build (PALIMPSEST_APP) has no hook.
    const errors = (await current.exec<string[] | null>("return window.__e2eErrors ?? null")) ?? [];
    await current.end();
    current = null;
    expect(errors, "errors in the page").toEqual([]);
  });
}

/** Answers for the app's next file dialogs: the paths to return. Anything not given is cancelled. */
export function answer(answers: { pdf?: string[]; image?: string; save?: string }) {
  writeFileSync(join(hooks, "answers.json"), JSON.stringify(answers));
}

export type ShellEvent = {
  dialog?: string;
  answer?: unknown;
  suggestedName?: string;
  open?: string;
  print?: string;
  closed?: string;
};

/** What the shell did: dialogs, suggested file names, links opened, print requests, windows closed. */
export function shellLog(): ShellEvent[] {
  const path = join(hooks, "log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ShellEvent);
}

export const poll = <T>(fn: () => T | Promise<T>, timeout = 10_000) => expect.poll(fn, { timeout, interval: 100 });

/** First launch on a cold machine (software GL, empty caches) can take a while. */
export const STARTUP = 30_000;

export const workDir = () => mkdtempSync(join(tmpdir(), "palimpsest-e2e-"));

/** A copy of the five-page sample (tests/fixtures/sample.ts) in `dir`. */
export async function sampleIn(dir: string, name = "sample.pdf") {
  const path = join(dir, name);
  copyFileSync(await sampleFile(), path);
  return path;
}

export const readPdf = (path: string, password?: string) => inspect(new Uint8Array(readFileSync(path)), password);

/** Wait for a document to be open, with its page list and first page rendered. */
export async function opened(app: Session, pages = 5) {
  await poll(() => app.text("#pageCount"), STARTUP).toBe(`/ ${pages}`);
  await poll(() => app.count(".thumb")).toBe(pages);
  await poll(() => app.count('.page[data-page-number="1"] .textLayer span')).toBeGreaterThan(0);
}

/** Wait for a save to a new file. Saves are renamed into place, so the file appears complete. */
export async function savedTo(path: string, password?: string) {
  await poll(() => existsSync(path)).toBe(true);
  return readPdf(path, password);
}

export const dirty = (app: Session) => app.count("#docTitle .dirty").then((n) => n > 0);

/**
 * A point on a page, in CSS pixels from its top-left corner, as viewport
 * coordinates. Scrolls the viewer first if the point is out of view.
 */
export function onPage(app: Session, page: number, x: number, y: number) {
  return app.exec<[number, number]>(
    `const [n, x, y] = arguments;
     const page = document.querySelector('.page[data-page-number="' + n + '"]');
     const viewer = document.querySelector("#viewerContainer");
     let r = page.getBoundingClientRect();
     const v = viewer.getBoundingClientRect();
     if (r.top + y < v.top + 20 || r.top + y > v.bottom - 20 || r.left + x > v.right - 20) {
       viewer.scrollTop += r.top + y - (v.top + v.height / 2);
       r = page.getBoundingClientRect();
     }
     return [r.left + x, r.top + y];`,
    page,
    x,
    y,
  );
}

/** Click a point on a page (see onPage). */
export async function clickPage(app: Session, page: number, x: number, y: number) {
  await app.clickAt(await onPage(app, page, x, y));
}

/** Draw a zigzag stroke on a page starting at (x, y). */
export async function stroke(app: Session, page: number, x: number, y: number, segments = 10) {
  const [sx, sy] = await onPage(app, page, x, y);
  const points: [number, number][] = [[sx, sy]];
  for (let i = 1; i <= segments; i++) points.push([sx + i * 20, sy + (i % 2) * 30]);
  await app.drag(points);
}

/** Field name → value for the form fields on the first page of a decoded PDF. */
export const formFields = (doc: Awaited<ReturnType<typeof inspect>>) =>
  Object.fromEntries(doc.pages[0].annotations.filter((a) => a.fieldName).map((a) => [a.fieldName, a.fieldValue]));
