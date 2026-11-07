// KiloNote — native backend.
// All the interface logic lives in the frontend (TypeScript). Only what must be
// native stays here: fast disk access, atomic writes, trash, single instance.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_window_state::StateFlags;

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
/// Folders skipped when walking a workspace.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "target",
    "__pycache__",
    ".idea",
    ".vscode",
    ".cache",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    mtime: f64,
    size: u64,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileText {
    text: String,
    encoding: String,
    mtime: f64,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn meta_of(p: &Path) -> Option<Meta> {
    let m = fs::metadata(p).ok()?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Some(Meta {
        mtime,
        size: m.len(),
        is_dir: m.is_dir(),
    })
}

/// Windows-1252: bytes 0x80–0x9F have specific mappings, the rest matches
/// Latin-1. Common for old Notepad files.
fn decode_cp1252(bytes: &[u8]) -> String {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž',
        '\u{8F}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}',
        'ž', 'Ÿ',
    ];
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect()
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| {
            if little_endian {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

fn decode(bytes: Vec<u8>) -> (String, &'static str) {
    if bytes.starts_with(BOM) {
        return (
            String::from_utf8_lossy(&bytes[3..]).into_owned(),
            "UTF-8 BOM",
        );
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return (decode_utf16(&bytes[2..], true), "UTF-16 LE");
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return (decode_utf16(&bytes[2..], false), "UTF-16 BE");
    }
    match String::from_utf8(bytes) {
        Ok(s) => (s, "UTF-8"),
        Err(e) => (decode_cp1252(e.as_bytes()), "Windows-1252"),
    }
}

/// Largest file read as text (bytes).
const MAX_TEXT_SIZE: u64 = 512 * 1024 * 1024;

/// Error returned for binary content (the frontend recognizes this text).
const NOT_TEXT: &str = "not a text file";

/// A NUL byte near the start means binary content (an executable, an archive, an
/// image…), whatever the extension says. UTF-16 text (with its BOM) has NUL bytes too.
fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|&b| b == 0)
}

#[tauri::command]
async fn read_text(path: String) -> Result<FileText, String> {
    let p = PathBuf::from(&path);
    // Safety net (the interface already refuses files this large).
    if fs::metadata(&p).map(|m| m.len()).unwrap_or(0) > MAX_TEXT_SIZE {
        return Err("file too large".into());
    }
    let bytes = fs::read(&p).map_err(err)?;
    // Opening it as text would show garbage, and saving it would corrupt it.
    if looks_binary(&bytes) {
        return Err(NOT_TEXT.into());
    }
    let (text, encoding) = decode(bytes);
    let mtime = meta_of(&p).map(|m| m.mtime).unwrap_or(0.0);
    Ok(FileText {
        text,
        encoding: encoding.into(),
        mtime,
    })
}

/// Atomic write: write a sibling temporary file, then rename it over the target.
/// If renaming fails (file locked on Windows…), write the file directly.
#[tauri::command]
async fn write_text(path: String, text: String, bom: Option<bool>) -> Result<Meta, String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(err)?;
        }
    }
    let mut payload = Vec::with_capacity(text.len() + 3);
    if bom.unwrap_or(false) {
        payload.extend_from_slice(BOM);
    }
    payload.extend_from_slice(text.as_bytes());

    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = target.with_file_name(format!(".{file_name}.kilonote-tmp"));
    let atomic = (|| -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(&payload)?;
        f.sync_all()?;
        drop(f);
        if let Ok(m) = fs::metadata(&target) {
            let _ = fs::set_permissions(&tmp, m.permissions());
        }
        fs::rename(&tmp, &target)
    })();
    if atomic.is_err() {
        let _ = fs::remove_file(&tmp);
        fs::write(&target, &payload).map_err(err)?;
    }
    meta_of(&target).ok_or_else(|| "file not found after writing".into())
}

/// Appends lines at the end of a file (created when needed), using the line
/// ending the file already uses (LF or CRLF).
#[tauri::command]
async fn append_lines(path: String, lines: Vec<String>) -> Result<Meta, String> {
    let p = PathBuf::from(&path);
    let mut eol = if cfg!(windows) { "\r\n" } else { "\n" };
    let mut needs_newline = false;
    if let Ok(mut f) = File::open(&p) {
        let mut head = vec![0u8; 8192];
        let n = f.read(&mut head).map_err(err)?;
        if n > 0 {
            eol = if head[..n].windows(2).any(|w| w == b"\r\n") {
                "\r\n"
            } else if head[..n].contains(&b'\n') {
                "\n"
            } else {
                eol
            };
            let len = f.metadata().map_err(err)?.len();
            f.seek(SeekFrom::Start(len - 1)).map_err(err)?;
            let mut last = [0u8; 1];
            f.read_exact(&mut last).map_err(err)?;
            needs_newline = last[0] != b'\n';
        }
    }
    let mut out = String::new();
    if needs_newline {
        out.push_str(eol);
    }
    for line in &lines {
        out.push_str(line);
        out.push_str(eol);
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(err)?;
    f.write_all(out.as_bytes()).map_err(err)?;
    f.sync_all().map_err(err)?;
    meta_of(&p).ok_or_else(|| "file not found after writing".into())
}

#[tauri::command]
async fn stat(path: String) -> Option<Meta> {
    meta_of(Path::new(&path))
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

#[tauri::command]
async fn list_dir(path: String, show_hidden: bool) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = fs::read_dir(&path)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !show_hidden && is_hidden(&name) {
                return None;
            }
            if name.ends_with(".kilonote-tmp") {
                return None;
            }
            // `metadata` follows symlinks: a link to a folder is still a folder.
            let is_dir = fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false);
            Some(Entry {
                name,
                path: e.path().to_string_lossy().into_owned(),
                is_dir,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Recursive walk (symlinks are not followed) for quick open, the tasks view
/// and the activity report.
#[tauri::command]
async fn walk(root: String, show_hidden: bool, max: usize) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut stack = vec![PathBuf::from(&root)];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if (!show_hidden && is_hidden(&name)) || name.ends_with(".kilonote-tmp") {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(e.path());
                }
            } else if ft.is_file() {
                files.push(e.path().to_string_lossy().into_owned());
                if files.len() >= max {
                    return Ok(files);
                }
            }
        }
    }
    Ok(files)
}

/// Batch read (a single IPC round trip) used to scan tasks.
#[tauri::command]
async fn read_many(paths: Vec<String>, max_size: u64) -> Vec<Option<String>> {
    paths
        .iter()
        .map(|p| {
            let m = fs::metadata(p).ok()?;
            if !m.is_file() || m.len() > max_size {
                return None;
            }
            let bytes = fs::read(p).ok()?;
            if looks_binary(&bytes) {
                return None;
            }
            Some(decode(bytes).0)
        })
        .collect()
}

#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
async fn create_file(path: String) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
async fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() && !from.eq_ignore_ascii_case(&to) {
        return Err(format!("\"{to}\" already exists"));
    }
    fs::rename(&from, &to).map_err(err)
}

#[tauri::command]
async fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(err)
}

#[tauri::command]
fn config_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Existing paths among command-line arguments, made absolute.
fn resolve_paths(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| fs::canonicalize(cwd.join(a)).ok())
        .map(|p| {
            let s = p.to_string_lossy().into_owned();
            // On Windows, canonicalize returns an unfriendly \\?\ prefix.
            s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
        })
        .collect()
}

/// Multi-window bookkeeping.
#[derive(Default)]
struct Windows {
    /// Paths each new window must open, by window label.
    pending: Mutex<HashMap<String, Vec<String>>>,
    /// The command-line paths are handed to the main window only once.
    argv_taken: AtomicBool,
    /// Label of the window that had the focus last (receives files opened from outside).
    last_focused: Mutex<String>,
}

/// Window labels are "main" or "kn-…" (letters, digits, dashes): they name session files.
fn valid_label(label: &str) -> bool {
    label == "main"
        || (label.starts_with("kn-")
            && label.len() <= 40
            && label[3..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// Paths this window must open: the command line for the main window (once),
/// otherwise the paths given when the window was created.
#[tauri::command]
fn window_paths(window: WebviewWindow, state: State<Windows>) -> Vec<String> {
    let label = window.label();
    if label == "main" && !state.argv_taken.swap(true, Ordering::SeqCst) {
        let cwd = std::env::current_dir().unwrap_or_default();
        return resolve_paths(std::env::args().skip(1), &cwd);
    }
    state
        .pending
        .lock()
        .unwrap()
        .remove(label)
        .unwrap_or_default()
}

/// Opens a new window (a fresh label, or a given one to restore a saved window).
#[tauri::command]
fn open_window(
    app: AppHandle,
    state: State<Windows>,
    paths: Vec<String>,
    label: Option<String>,
) -> Result<String, String> {
    let label = match label {
        Some(l) if valid_label(&l) && l != "main" => l,
        Some(l) => return Err(format!("invalid window label: {l}")),
        None => {
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("kn-{millis:x}")
        }
    };
    if app.get_webview_window(&label).is_some() {
        return Err(format!("window {label} already exists"));
    }
    state.pending.lock().unwrap().insert(label.clone(), paths);
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("no window configuration")?;
    config.label = label.clone();
    // Cascade from the window that has the focus.
    let focused = state.last_focused.lock().unwrap().clone();
    if let Some(origin) = app.get_webview_window(&focused) {
        if let (Ok(pos), Ok(scale)) = (origin.outer_position(), origin.scale_factor()) {
            config.center = false;
            config.x = Some(pos.x as f64 / scale + 36.0);
            config.y = Some(pos.y as f64 / scale + 36.0);
        }
    }
    let window = tauri::WebviewWindowBuilder::from_config(&app, &config)
        .map_err(err)?
        .build()
        .map_err(err)?;
    show_soon(window);
    Ok(label)
}

#[tauri::command]
fn window_count(app: AppHandle) -> usize {
    app.webview_windows().len()
}

/// Forgets the saved session of a window that was closed (config folder only).
#[tauri::command]
fn delete_session(app: AppHandle, label: String) -> Result<(), String> {
    if !valid_label(&label) {
        return Err(format!("invalid window label: {label}"));
    }
    let name = if label == "main" {
        "session.json".to_string()
    } else {
        format!("session-{label}.json")
    };
    let path = app.path().app_config_dir().map_err(err)?.join(name);
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

/// The frontend shows a window once it is ready (no white flash).
/// Safety net: show it anyway after a short delay.
fn show_soon(window: WebviewWindow) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
        }
    });
}

fn main() {
    tauri::Builder::default()
        // A single KiloNote process: launching the app again (pinned shortcut,
        // "Open with"…) brings the last used window back and opens the files there.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let state = app.state::<Windows>();
            let last = state.last_focused.lock().unwrap().clone();
            let target = app
                .get_webview_window(&last)
                .or_else(|| app.get_webview_window("main"))
                .or_else(|| app.webview_windows().into_values().next());
            if let Some(window) = target {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let paths = resolve_paths(argv.into_iter().skip(1), Path::new(&cwd));
                if !paths.is_empty() {
                    let _ = app.emit_to(window.label(), "kilonote://open-paths", paths);
                }
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Windows::default())
        .setup(|app| {
            *app.state::<Windows>().last_focused.lock().unwrap() = "main".into();
            if let Some(window) = app.get_webview_window("main") {
                show_soon(window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                let state = window.state::<Windows>();
                *state.last_focused.lock().unwrap() = window.label().to_string();
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_text,
            write_text,
            append_lines,
            stat,
            list_dir,
            walk,
            read_many,
            create_dir,
            create_file,
            rename_path,
            trash_path,
            config_dir,
            window_paths,
            open_window,
            window_count,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to start KiloNote");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_content_is_detected() {
        assert!(looks_binary(b"MZ\x90\x00\x03\x00\x00\x00"));
        assert!(looks_binary(b"\x7fELF\x02\x01\x01\x00"));
        assert!(!looks_binary(b"- call colleague X - todo\r\n"));
        assert!(!looks_binary("caf\u{e9}".as_bytes()));
        assert!(!looks_binary(b""));
        // UTF-16 text with its BOM is text.
        assert!(!looks_binary(&[0xFF, 0xFE, b'h', 0, b'i', 0]));
    }

    #[test]
    fn encodings_are_decoded() {
        assert_eq!(decode(b"abc".to_vec()), ("abc".to_string(), "UTF-8"));
        assert_eq!(
            decode(vec![0xEF, 0xBB, 0xBF, b'x']),
            ("x".to_string(), "UTF-8 BOM")
        );
        assert_eq!(
            decode(vec![0xFF, 0xFE, b'h', 0, b'i', 0]),
            ("hi".to_string(), "UTF-16 LE")
        );
        assert_eq!(
            decode(vec![b'c', b'a', b'f', 0xE9, 0x80]),
            ("caf\u{e9}\u{20ac}".to_string(), "Windows-1252")
        );
    }

    #[test]
    fn window_labels_are_restricted() {
        assert!(valid_label("main"));
        assert!(valid_label("kn-19a3f0c2b1d"));
        assert!(!valid_label("kn-../../evil"));
        assert!(!valid_label("other"));
        assert!(!valid_label(&format!("kn-{}", "a".repeat(40))));
    }
}
