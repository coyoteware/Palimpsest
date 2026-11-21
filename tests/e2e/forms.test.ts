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

  // What the sandbox sends back, to explain a failure.
  await app.exec(`window.__fromSandbox = [];
    addEventListener("updatefromsandbox", (e) => window.__fromSandbox.push(JSON.stringify(e.detail)), true);`);
  const explain = async (e: unknown) => {
    console.log(
      "form state:",
      await app.exec(`return JSON.stringify({
        focused: document.activeElement?.name || document.activeElement?.tagName,
        values: [...document.querySelectorAll(".annotationLayer input")].map((i) => i.name + "=" + i.value),
        fromSandbox: window.__fromSandbox,
      })`),
    );
    throw e;
  };

  // A keystroke script: "a" only takes numbers. pdf.js cancels each keystroke and writes back
  // what the sandbox accepts, a moment later; a key typed before that is judged against the old
  // value. So type a key at a time, as a person does, each after the last one's answer.
  await app.type(field("a"), "2");
  await poll(() => app.value(field("a")))
    .toBe("2")
    .catch(explain);
  const answers = await app.exec<number>("return window.__fromSandbox.length");
  await app.type(field("a"), "x");
  await poll(() => app.exec<number>("return window.__fromSandbox.length")).toBeGreaterThan(answers);
  await poll(() => app.value(field("a")))
    .toBe("2")
    .catch(explain);
  await app.type(field("b"), "3");
  // Leave "b" by Tab: the calculation runs. "b" is the last field, so Tab wraps round to the
  // toolbar rather than leaving the app (which WebView2 would otherwise do, losing the commit).
  await app.press(Key.Tab);
  // "total" is calculated, then shown as currency.
  await poll(() => app.value(field("total")))
    .toBe("$5.00")
    .catch(explain);
  expect(await app.exec("return !!document.activeElement?.closest('#app')")).toBe(true);

  const out = join(dir, "out.pdf");
  answer({ save: out });
  await app.press(Key.Control, Key.Shift, "s");
  const fields = formFields(await savedTo(out));
  expect(fields).toMatchObject({ a: "2", b: "3" });
  expect(String(fields.total)).toBe("5");
});
