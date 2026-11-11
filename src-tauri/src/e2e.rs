//! Test hooks for tests/e2e, compiled only with `--features e2e`.
//!
//! When PALIMPSEST_E2E_DIR is set, native dialogs are answered from
//! `<dir>/answers.json` instead of being shown, and dialogs, external opens,
//! print requests and closed windows are appended to `<dir>/log.jsonl`, so a
//! WebDriver test can drive and observe what the shell does.
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;

fn dir() -> Option<PathBuf> {
    std::env::var_os("PALIMPSEST_E2E_DIR").map(PathBuf::from)
}

/// Append an event to the log. Returns false when no test is driving the app.
pub fn log(event: Value) -> bool {
    let Some(dir) = dir() else { return false };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("log.jsonl"))
        .expect("open e2e log");
    writeln!(file, "{event}").expect("write e2e log");
    true
}

/// The scripted answer to a dialog: `None` when no test is running (show the
/// real dialog), `Some(None)` when the test cancels it.
pub fn answer<T: DeserializeOwned>(dialog: &str) -> Option<Option<T>> {
    let dir = dir()?;
    let answers: Value = std::fs::read(dir.join("answers.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let answer = answers.get(dialog).cloned().unwrap_or_default();
    log(json!({ "dialog": dialog, "answer": answer }));
    Some(serde_json::from_value(answer).ok())
}

/// Same as the user pressing the window's close button.
#[tauri::command]
pub fn request_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// Records uncaught errors and console.error calls for the tests to assert on.
pub const CAPTURE_ERRORS: &str = r#"
(() => {
  const errors = (window.__e2eErrors = []);
  addEventListener("error", (e) => errors.push(`uncaught: ${e.message}`));
  addEventListener("unhandledrejection", (e) => errors.push(`unhandled rejection: ${e.reason}`));
  const consoleError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(`console.error: ${args.join(" ")}`);
    consoleError(...args);
  };
})();
"#;
