//! Palimpsest's desktop shell.
//!
//! The web app in dist/ is embedded in the binary and served from the app's
//! own origin with a strict CSP (tauri.conf.json). The page gets no Tauri or
//! plugin APIs (capabilities/default.json): it reaches files only through the
//! commands below, wrapped as window.palimpsestDesktop by bridge.js. A window
//! may only read and write files the user picked in a dialog or passed on the
//! command line, and a save goes to a temporary file beside the target that is
//! then renamed over it, so a failed save never truncates the original.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "e2e")]
mod e2e;

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, Url, Webview, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tauri_plugin_opener::OpenerExt;

#[cfg(feature = "e2e")]
use e2e::answer as scripted;

/// The answer a test scripted for a dialog; release builds always show the real one.
#[cfg(not(feature = "e2e"))]
fn scripted<T>(_dialog: &str) -> Option<Option<T>> {
    None
}

/// How long the page has to answer a close request. After that, a second
/// click on the close button closes the window anyway (hung or half-loaded page).
const CLOSE_ANSWER_TIMEOUT: Duration = Duration::from_secs(3);

/// Run in the page when its window's close button is pressed (see bridge.js).
const ASK_PAGE_TO_CLOSE: &str = "(window.__palimpsestCloseRequested ?? \
    (() => window.__TAURI_INTERNALS__.invoke('close_window', { decision: 'close' })))()";

enum Closing {
    /// The page was asked whether the window may close.
    Asked(Instant),
    /// The page is asking the user (its "Discard unsaved changes?" dialog is open).
    Asking,
}

#[derive(Default)]
struct Shell {
    /// Files each window may read and write, keyed by window label.
    allowed: Mutex<HashMap<String, HashSet<PathBuf>>>,
    /// The file a new window opens once its page asks for it.
    pending: Mutex<HashMap<String, PathBuf>>,
    closing: Mutex<HashMap<String, Closing>>,
    /// Folder the next dialog starts in.
    last_dir: Mutex<Option<PathBuf>>,
    windows: AtomicU32,
    /// Recently opened PDFs, newest first, and the file they are kept in.
    recent: Mutex<Vec<Recent>>,
    recent_file: Mutex<Option<PathBuf>>,
}

/// A recently opened PDF, and where the reader was in it: page number and zoom.
#[derive(Clone)]
struct Recent {
    path: PathBuf,
    page: u32,
    zoom: String,
}

impl Recent {
    /// "path<TAB>page<TAB>zoom", as kept in recent.txt.
    fn parse(line: &str) -> Option<Self> {
        let mut fields = line.rsplitn(3, '\t');
        let (zoom, page, path) = (fields.next()?, fields.next()?, fields.next()?);
        Some(Self { path: path.into(), page: page.parse().ok()?, zoom: zoom.into() })
    }

    fn line(&self) -> Option<String> {
        let path = self.path.to_str().filter(|p| !p.contains(['\n', '\r']))?;
        Some(format!("{path}\t{}\t{}\n", self.page, self.zoom))
    }
}

impl Shell {
    /// Let `window` read and write `paths`, and start the next dialog beside them.
    fn grant(&self, window: &Window, paths: Vec<PathBuf>) -> Vec<PathBuf> {
        let mut allowed = self.allowed.lock().unwrap();
        let set = allowed.entry(window.label().to_owned()).or_default();
        for path in &paths {
            set.insert(path.clone());
        }
        if let Some(dir) = paths.last().and_then(|p| p.parent()) {
            *self.last_dir.lock().unwrap() = Some(dir.to_owned());
        }
        paths
    }

    fn check(&self, window: &Window, path: &Path) -> Result<(), String> {
        match self.allowed.lock().unwrap().get(window.label()) {
            Some(paths) if paths.contains(path) => Ok(()),
            _ => Err("Access to that location was not authorised.".into()),
        }
    }

    /// Load the recent files list from `file`, where it is kept from now on.
    fn load_recent(&self, file: PathBuf) {
        let list = std::fs::read_to_string(&file)
            .map(|text| text.lines().filter_map(Recent::parse).collect())
            .unwrap_or_default();
        *self.recent.lock().unwrap() = list;
        *self.recent_file.lock().unwrap() = Some(file);
    }

    /// Write the recent files list (paths that cannot be written as a line are left out).
    fn save_recent(&self) {
        let Some(file) = self.recent_file.lock().unwrap().clone() else { return };
        let text: String = self.recent.lock().unwrap().iter().filter_map(Recent::line).collect();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, text);
    }

    fn forget(&self, label: &str) {
        self.allowed.lock().unwrap().remove(label);
        self.pending.lock().unwrap().remove(label);
        self.closing.lock().unwrap().remove(label);
    }
}

fn file_dialog(window: &Window, shell: &Shell) -> FileDialogBuilder<Wry> {
    let dialog = window.dialog().file().set_parent(window);
    match shell.last_dir.lock().unwrap().clone() {
        Some(dir) => dialog.set_directory(dir),
        None => dialog,
    }
}

/// What a save dialog saves: a PDF, an image, or any file (an attachment).
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Pdf,
    Png,
    Jpeg,
    Any,
}

impl Kind {
    fn parse(kind: Option<&str>) -> Result<Self, String> {
        match kind.unwrap_or("pdf") {
            "pdf" => Ok(Self::Pdf),
            "png" => Ok(Self::Png),
            "jpeg" => Ok(Self::Jpeg),
            "any" => Ok(Self::Any),
            other => Err(format!("Unknown file kind: {other}")),
        }
    }

    /// The dialog's filter, and the extensions a saved file may have (the first is added if missing).
    fn extensions(self) -> Option<(&'static str, &'static [&'static str])> {
        match self {
            Self::Pdf => Some(("PDF documents", &["pdf"])),
            Self::Png => Some(("PNG images", &["png"])),
            Self::Jpeg => Some(("JPEG images", &["jpg", "jpeg"])),
            Self::Any => None,
        }
    }

    fn accepts(self, path: &Path) -> bool {
        self.extensions().is_none_or(|(_, exts)| {
            path.extension().is_some_and(|e| exts.iter().any(|x| e.eq_ignore_ascii_case(x)))
        })
    }

    /// `path`, with this kind's extension added if it has none of them.
    fn with_extension(self, path: PathBuf) -> PathBuf {
        match self.extensions() {
            Some((_, exts)) if !self.accepts(&path) => {
                let mut with_ext = path.into_os_string();
                with_ext.push(".");
                with_ext.push(exts[0]);
                PathBuf::from(with_ext)
            }
            _ => path,
        }
    }
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn initial_file(window: Window, shell: State<Shell>) -> Option<PathBuf> {
    let path = shell.pending.lock().unwrap().remove(window.label())?;
    shell.grant(&window, vec![path]).pop()
}

#[tauri::command]
async fn pick_pdfs(window: Window, shell: State<'_, Shell>, multiple: bool) -> Result<Vec<PathBuf>, String> {
    let picked = match scripted::<Vec<PathBuf>>("pdf") {
        Some(answer) => answer.unwrap_or_default(),
        None => {
            let dialog = file_dialog(&window, &shell).add_filter("PDF documents", &["pdf"]);
            let files = if multiple {
                dialog.blocking_pick_files().unwrap_or_default()
            } else {
                dialog.blocking_pick_file().into_iter().collect()
            };
            files.into_iter().filter_map(|f| f.into_path().ok()).collect()
        }
    };
    Ok(shell.grant(&window, picked))
}

#[tauri::command]
async fn pick_image(window: Window, shell: State<'_, Shell>) -> Result<Option<PathBuf>, String> {
    let picked = scripted::<PathBuf>("image").unwrap_or_else(|| {
        file_dialog(&window, &shell)
            .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
    });
    Ok(shell.grant(&window, picked.into_iter().collect()).pop())
}

#[tauri::command]
async fn save_as(
    window: Window,
    shell: State<'_, Shell>,
    suggested_name: String,
    kind: Option<String>,
) -> Result<Option<PathBuf>, String> {
    let kind = Kind::parse(kind.as_deref())?;
    let name = Path::new(&suggested_name)
        .file_name()
        .map_or_else(|| "document.pdf".into(), |n| n.to_string_lossy().into_owned());
    #[cfg(feature = "e2e")]
    e2e::log(serde_json::json!({ "suggestedName": &name }));
    let chosen = scripted::<PathBuf>("save").unwrap_or_else(|| {
        let dialog = file_dialog(&window, &shell).set_file_name(name);
        let dialog = match kind.extensions() {
            Some((label, exts)) => dialog.add_filter(label, exts),
            None => dialog,
        };
        dialog.blocking_save_file().and_then(|f| f.into_path().ok())
    });
    let Some(path) = chosen else { return Ok(None) };
    Ok(shell.grant(&window, vec![kind.with_extension(path)]).pop())
}

/// A plain file name of `kind`, with no folder, drive or `..` in it.
fn is_file_name(name: &str, kind: Kind) -> bool {
    let mut parts = Path::new(name).components();
    matches!((parts.next(), parts.next()), (Some(Component::Normal(_)), None))
        && !name.contains(['/', '\\', ':'])
        && kind != Kind::Any
        && kind.accepts(Path::new(name))
}

/// The folder chosen, and each file in it with whether it already exists.
type FolderFiles = (PathBuf, Vec<(PathBuf, bool)>);

/// Asks for a folder to save the files `names` in (a split document's parts,
/// or pages exported as images). Lets the window write exactly those files
/// there, and returns the folder and, for each name, its path and whether a
/// file is already there.
#[tauri::command]
async fn save_to_folder(
    window: Window,
    shell: State<'_, Shell>,
    names: Vec<String>,
    kind: Option<String>,
) -> Result<Option<FolderFiles>, String> {
    let kind = Kind::parse(kind.as_deref())?;
    if names.is_empty() {
        return Err("No files to save.".into());
    }
    if let Some(bad) = names.iter().find(|n| !is_file_name(n, kind)) {
        return Err(format!("Not a file name this folder can take: {bad}"));
    }
    let chosen = scripted::<PathBuf>("folder").unwrap_or_else(|| {
        file_dialog(&window, &shell).blocking_pick_folder().and_then(|f| f.into_path().ok())
    });
    let Some(dir) = chosen else { return Ok(None) };
    let paths = shell.grant(&window, names.iter().map(|n| dir.join(n)).collect());
    let files = paths.into_iter().map(|p| {
        let exists = p.exists();
        (p, exists)
    });
    Ok(Some((dir, files.collect())))
}

#[tauri::command]
async fn read_file(window: Window, shell: State<'_, Shell>, path: PathBuf) -> Result<Response, String> {
    shell.check(&window, &path)?;
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file(window: Window, shell: State<'_, Shell>, request: Request<'_>) -> Result<(), String> {
    let header = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("Missing target path.")?;
    let target = PathBuf::from(&*percent_decode_str(header).decode_utf8().map_err(|e| e.to_string())?);
    shell.check(&window, &target)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file bytes.".into());
    };
    // Write beside the target, then swap, so a failed save never truncates the original.
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.subsec_nanos()) ^ std::process::id();
    let mut tmp_name = target.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(format!(".{nonce:08x}.tmp"));
    let tmp = target.with_file_name(tmp_name);
    std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, &target)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The page's answer to a close request (bridge.js): "asking" while it asks
/// the user about unsaved changes, then "close" or "stay".
#[tauri::command]
fn close_window(window: Window, shell: State<Shell>, decision: String) -> Result<(), String> {
    let mut closing = shell.closing.lock().unwrap();
    match decision.as_str() {
        "asking" => {
            closing.insert(window.label().to_owned(), Closing::Asking);
            Ok(())
        }
        "stay" => {
            closing.remove(window.label());
            Ok(())
        }
        "close" => {
            drop(closing);
            window.destroy().map_err(|e| e.to_string())
        }
        other => Err(format!("Unknown close decision: {other}")),
    }
}

/// Native print dialog. Only the macOS bridge uses it: WKWebView ignores
/// window.print(), which works in WebView2 and WebKitGTK.
#[tauri::command]
fn print_page(webview: Webview) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    if e2e::log(serde_json::json!({ "print": webview.label() })) {
        return Ok(());
    }
    webview.print().map_err(|e| e.to_string())
}

/// How many recently opened files are remembered.
const MAX_RECENT: usize = 10;

/// Recently opened PDFs that are still there, newest first: path, page number and zoom.
#[tauri::command]
fn recent_files(shell: State<Shell>) -> Vec<(PathBuf, u32, String)> {
    shell
        .recent
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.path.is_file())
        .map(|r| (r.path.clone(), r.page, r.zoom.clone()))
        .collect()
}

/// Remember a PDF this window opened or saved as recently used, and where
/// the reader is in it. Only a file the window may already use (the user
/// chose it) can be added.
#[tauri::command]
fn add_recent(window: Window, shell: State<Shell>, path: PathBuf, page: Option<u32>, zoom: Option<String>) -> Result<(), String> {
    shell.check(&window, &path)?;
    if !Kind::Pdf.accepts(&path) {
        return Err("Only PDFs are remembered.".into());
    }
    {
        let mut list = shell.recent.lock().unwrap();
        let old = list.iter().position(|r| r.path == path).map(|i| list.remove(i));
        // A zoom is a number or one of pdf.js's names; anything else is not kept.
        let zoom = zoom
            .filter(|z| z.len() < 16 && z.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
            .or(old.as_ref().map(|r| r.zoom.clone()))
            .unwrap_or_else(|| "auto".into());
        let page = page.or(old.map(|r| r.page)).unwrap_or(1).max(1);
        list.insert(0, Recent { path, page, zoom });
        list.truncate(MAX_RECENT);
    }
    shell.save_recent();
    Ok(())
}

/// Let this window open a file from the recent list, and nothing else this way.
#[tauri::command]
fn open_recent(window: Window, shell: State<Shell>, path: PathBuf) -> Result<PathBuf, String> {
    if !shell.recent.lock().unwrap().iter().any(|r| r.path == path) {
        return Err("That file is not in the recent files list.".into());
    }
    if !path.is_file() {
        return Err("That file is no longer there.".into());
    }
    Ok(shell.grant(&window, vec![path.clone()]).pop().unwrap_or(path))
}

#[tauri::command]
fn forget_recent(shell: State<Shell>) {
    shell.recent.lock().unwrap().clear();
    shell.save_recent();
}

/// Full screen for presentation mode.
#[tauri::command]
fn set_fullscreen(window: Window, on: bool) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    e2e::log(serde_json::json!({ "fullscreen": on }));
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------- windows

/// The page's bridge script with this platform's values filled in.
fn bridge_script() -> String {
    // Node's names (process.platform).
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        os => os,
    };
    // Test builds route printing through the shell everywhere, so the macOS path is tested too.
    let native_print = cfg!(target_os = "macos") || cfg!(feature = "e2e");
    include_str!("bridge.js")
        .replace("__PLATFORM__", platform)
        .replace("__NATIVE_PRINT__", if native_print { "true" } else { "false" })
}

/// The app's own pages: tauri://localhost (macOS, Linux), http://tauri.localhost
/// (Windows), or the Vite dev server under `tauri dev`.
fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        || dev_url.is_some_and(|dev| dev.origin() == url.origin())
}

/// Web and mail links go to the default browser or mail client; anything else is dropped.
fn open_external(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }
    #[cfg(feature = "e2e")]
    if e2e::log(serde_json::json!({ "open": url.as_str() })) {
        return;
    }
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

fn open_window(app: &AppHandle, file: Option<PathBuf>) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let label = format!("doc{}", shell.windows.fetch_add(1, Ordering::Relaxed) + 1);
    if let Some(file) = file {
        shell.pending.lock().unwrap().insert(label.clone(), file);
    }
    let dev_url = if cfg!(dev) { app.config().build.dev_url.clone() } else { None };
    let (nav_app, popup_app) = (app.clone(), app.clone());
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Palimpsest")
        .inner_size(1280.0, 900.0)
        .min_inner_size(640.0, 480.0)
        .initialization_script(bridge_script())
        // Let the page handle drops itself: PDFs dropped on the window or page list, and page reordering.
        .disable_drag_drop_handler()
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        // Links in PDFs open in the default browser; nothing navigates the app away.
        .on_navigation(move |url| {
            if is_app_url(url, dev_url.as_ref()) {
                return true;
            }
            open_external(&nav_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&popup_app, &url);
            NewWindowResponse::Deny
        });
    #[cfg(feature = "e2e")]
    let builder = builder.initialization_script(e2e::CAPTURE_ERRORS);
    builder.build()?;
    Ok(())
}

fn on_window_event(window: &Window, event: &WindowEvent) {
    let shell = window.state::<Shell>();
    match event {
        // Ask the page whether it has unsaved changes before letting the window go.
        WindowEvent::CloseRequested { api, .. } => {
            let mut closing = shell.closing.lock().unwrap();
            match closing.get(window.label()) {
                Some(Closing::Asked(at)) if at.elapsed() > CLOSE_ANSWER_TIMEOUT => {
                    closing.remove(window.label());
                    return; // the page never answered
                }
                Some(_) => return api.prevent_close(),
                None => {}
            }
            api.prevent_close();
            closing.insert(window.label().to_owned(), Closing::Asked(Instant::now()));
            drop(closing);
            if let Some(webview) = window.get_webview_window(window.label()) {
                let _ = webview.eval(ASK_PAGE_TO_CLOSE);
            }
        }
        WindowEvent::Destroyed => {
            shell.forget(window.label());
            #[cfg(feature = "e2e")]
            e2e::log(serde_json::json!({ "closed": window.label() }));
        }
        _ => {}
    }
}

/// PDF paths among command-line arguments, resolved against `cwd`: plain
/// paths (as "Open with" passes them) or `--open=<path>`. Other switches are
/// ignored. The explicit form exists because some launchers, msedgedriver
/// among them, turn every argument into a `--` switch.
fn pdf_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter_map(|a| match a.strip_prefix("--open=") {
            Some(path) => Some(path.to_owned()),
            None if a.starts_with('-') => None,
            None => Some(a),
        })
        .filter(|a| a.to_ascii_lowercase().ends_with(".pdf"))
        .filter_map(|a| std::path::absolute(cwd.join(a)).ok())
        .filter(|p| p.is_file())
        .collect()
}

fn main() {
    let builder = tauri::Builder::default();
    // A second launch hands its files to the running instance, one window per file.
    // Test builds leave it out so each test gets a fresh instance.
    #[cfg(not(feature = "e2e"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let files = pdf_args(argv.into_iter().skip(1), Path::new(&cwd));
        if files.is_empty() {
            if let Some(window) = app.webview_windows().into_values().next() {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        for file in files {
            let _ = open_window(app, Some(file));
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        // Used from Rust only (open_external); its own link-click script would call it from the page.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(Shell::default());
    #[cfg(not(feature = "e2e"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        initial_file, pick_pdfs, pick_image, save_as, save_to_folder, read_file, write_file, close_window, print_page,
        set_fullscreen, recent_files, add_recent, open_recent, forget_recent
    ]);
    #[cfg(feature = "e2e")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        initial_file, pick_pdfs, pick_image, save_as, save_to_folder, read_file, write_file, close_window, print_page,
        set_fullscreen, recent_files, add_recent, open_recent, forget_recent, e2e::request_close
    ]);

    builder
        .on_window_event(on_window_event)
        .setup(|app| {
            let shell = app.state::<Shell>();
            *shell.last_dir.lock().unwrap() = app.path().document_dir().ok();
            // Test builds keep the list with the test's files, so each run starts empty.
            #[cfg(feature = "e2e")]
            let data_dir = e2e::dir().map_or_else(|| app.path().app_data_dir(), Ok);
            #[cfg(not(feature = "e2e"))]
            let data_dir = app.path().app_data_dir();
            if let Ok(dir) = data_dir {
                shell.load_recent(dir.join("recent.txt"));
            }
            let cwd = std::env::current_dir().unwrap_or_default();
            let files = pdf_args(std::env::args().skip(1), &cwd);
            if files.is_empty() {
                open_window(app.handle(), None)?;
            }
            for file in files {
                open_window(app.handle(), Some(file))?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Palimpsest");
}
