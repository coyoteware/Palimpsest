/** Form JavaScript: calculated, formatted and validated fields, run in pdf.js's sandbox. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { scriptedFormPdf } from "../fixtures/forms";
import { answer, formFields, launch, poll, savedTo, STARTUP, useApp, workDir } from "./harness";
import { Key } from "./webdriver";

useApp();

const field = (name: string) => `.annotationLayer input[name="${name}"]`;

test("form JavaScript calculates and formats fields, and the result is saved", async () => {
  const dir = workDir();
  const path = join(dir, "form.pdf");
  writeFileSync(path, await scriptedFormPdf());
  const app = await launch(path);
  await poll(() => app.text("#pageCount"), STARTUP).toBe("/ 1");
  await poll(() => app.count(field("total"))).toBe(1);
  // The sandbox starts after the page; typing before it is ready would bypass the scripts.
  await poll(() => app.exec("return window.palimpsest.scripting.ready")).toBe(true);

  await app.click(field("a"));
  // A keystroke script: "a" only takes numbers.
  await app.keys("2x");
  await poll(() => app.value(field("a"))).toBe("2");
  await app.press(""); // Tab to "b"
  await app.keys("3");
  await app.press("");
  // "total" is calculated, then shown as currency.
  await poll(() => app.value(field("total"))).toBe("$5.00");

  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.press(Key.Control, Key.Shift, "s");
  const fields = formFields(await savedTo(out));
  expect(fields).toMatchObject({ a: "2", b: "3" });
  expect(String(fields.total)).toBe("5");
});
