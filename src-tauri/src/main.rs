// KiloNote — native backend.
// All the interface logic lives in the frontend (TypeScript). Only what must be
// native stays here: fast disk access, atomic writes, trash, single instance.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
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

/// Modification time in milliseconds since 1970 (0 when unknown).
fn mtime_ms(m: &fs::Metadata) -> f64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn meta_of(p: &Path) -> Option<Meta> {
    let m = fs::metadata(p).ok()?;
    Some(Meta {
        mtime: mtime_ms(&m),
        size: m.len(),
        is_dir: m.is_dir(),
    })
}

/// Windows-1252: bytes 0x80–0x9F have specific mappings, the rest matches
/// Latin-1. Common for old Notepad files.
const CP1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž', '\u{8F}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}', 'ž', 'Ÿ',
];

fn decode_cp1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => CP1252_HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect()
}

/// None when a character does not exist in Windows-1252.
fn encode_cp1252(text: &str) -> Option<Vec<u8>> {
    text.chars()
        .map(|c| match c as u32 {
            0..=0x7F | 0xA0..=0xFF => Some(c as u32 as u8),
            _ => CP1252_HIGH
                .iter()
                .position(|&h| h == c)
                .map(|i| 0x80 + i as u8),
        })
        .collect()
}

/// Encodes text in one of the encodings `decode` recognizes. A character that
/// Windows-1252 cannot represent makes the file UTF-8. Returns the encoding used.
fn encode(text: &str, encoding: &str, with_bom: bool) -> (Vec<u8>, &'static str) {
    let utf16 = |le: bool| {
        let mut out = Vec::with_capacity(text.len() * 2 + 2);
        if with_bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for u in text.encode_utf16() {
            out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        out
    };
    match encoding {
        "UTF-8 BOM" => {
            let mut out = if with_bom { BOM.to_vec() } else { Vec::new() };
            out.extend_from_slice(text.as_bytes());
            (out, "UTF-8 BOM")
        }
        "UTF-16 LE" => (utf16(true), "UTF-16 LE"),
        "UTF-16 BE" => (utf16(false), "UTF-16 BE"),
        "Windows-1252" => match encode_cp1252(text) {
            Some(bytes) => (bytes, "Windows-1252"),
            None => (text.as_bytes().to_vec(), "UTF-8"),
        },
        _ => (text.as_bytes().to_vec(), "UTF-8"),
    }
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Written {
    mtime: f64,
    /// The encoding actually written (Windows-1252 falls back to UTF-8 when needed).
    encoding: String,
}

/// Writes text in the file's encoding (UTF-8 when none is given).
#[tauri::command]
async fn write_text(
    path: String,
    text: String,
    encoding: Option<String>,
) -> Result<Written, String> {
    let target = PathBuf::from(&path);
    let (payload, used) = encode(&text, encoding.as_deref().unwrap_or("UTF-8"), true);
    write_bytes(&target, &payload)?;
    let mtime = meta_of(&target)
        .ok_or("file not found after writing")?
        .mtime;
    Ok(Written {
        mtime,
        encoding: used.into(),
    })
}

fn write_bytes(target: &Path, payload: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(err)?;
        }
    }
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = target.with_file_name(format!(".{file_name}.kilonote-tmp"));
    let atomic = (|| -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(payload)?;
        f.sync_all()?;
        drop(f);
        if let Ok(m) = fs::metadata(target) {
            let _ = fs::set_permissions(&tmp, m.permissions());
        }
        fs::rename(&tmp, target)
    })();
    if atomic.is_err() {
        let _ = fs::remove_file(&tmp);
        fs::write(target, payload).map_err(err)?;
    }
    Ok(())
}

/// Appends lines at the end of a file (created when needed), in the encoding and
/// with the line ending (LF or CRLF) the file already uses.
#[tauri::command]
async fn append_lines(path: String, lines: Vec<String>) -> Result<Meta, String> {
    let p = PathBuf::from(&path);
    let (text, encoding) = match fs::read(&p) {
        Ok(bytes) if looks_binary(&bytes) => return Err(NOT_TEXT.into()),
        Ok(bytes) if !bytes.is_empty() => decode(bytes),
        Ok(_) => (String::new(), "UTF-8"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), "UTF-8"),
        Err(e) => return Err(err(e)),
    };
    let eol = if text.contains("\r\n") {
        "\r\n"
    } else if text.contains('\n') || !cfg!(windows) {
        "\n"
    } else {
        "\r\n"
    };
    let mut addition = String::new();
    if !text.is_empty() && !text.ends_with('\n') {
        addition.push_str(eol);
    }
    for line in &lines {
        addition.push_str(line);
        addition.push_str(eol);
    }
    let (bytes, used) = encode(&addition, encoding, false);
    if used == encoding {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .map_err(err)?;
        f.write_all(&bytes).map_err(err)?;
        f.sync_all().map_err(err)?;
    } else {
        // A Windows-1252 archive receiving characters it cannot hold: the whole
        // file becomes UTF-8 rather than mixing two encodings.
        write_bytes(&p, format!("{text}{addition}").as_bytes())?;
    }
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

/// A text file of a batch read: its stamp, and its text unless the caller has it already.
#[derive(Serialize)]
struct Fresh {
    mtime: f64,
    size: u64,
    /// None: unchanged since the caller read it (`same`), too large, or not text.
    text: Option<String>,
    same: bool,
}

/// Batch read (a single IPC round trip) of the notes of a folder: search, tasks,
/// board. A file whose modification time and size are the ones the caller
/// already knows is not read again, so only what changed crosses over.
#[tauri::command]
async fn read_changed(paths: Vec<String>, known: Vec<Option<(f64, u64)>>, max_size: u64) -> Vec<Option<Fresh>> {
    paths
        .iter()
        .enumerate()
        .map(|(i, p)| read_fresh(Path::new(p), known.get(i).copied().flatten(), max_size))
        .collect()
}

fn read_fresh(p: &Path, known: Option<(f64, u64)>, max_size: u64) -> Option<Fresh> {
    let m = fs::metadata(p).ok()?;
    if !m.is_file() {
        return None;
    }
    let (mtime, size) = (mtime_ms(&m), m.len());
    if known == Some((mtime, size)) {
        return Some(Fresh { mtime, size, text: None, same: true });
    }
    let text = if size > max_size {
        None
    } else {
        let bytes = fs::read(p).ok()?;
        (!looks_binary(&bytes)).then(|| decode(bytes).0)
    };
    Some(Fresh { mtime, size, text, same: false })
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

// ---------------------------------------------------------------------------
// Images shown in notes, and images pasted into them. Only image files (by
// extension), up to MAX_IMAGE_SIZE; a pasted image always goes to a new file.

/// The image types a note can show or receive.
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
/// Largest image read or written (bytes).
const MAX_IMAGE_SIZE: u64 = 50 * 1024 * 1024;
/// Error returned when the target of a pasted image exists (the frontend picks another name).
const EXISTS: &str = "exists";

fn is_image_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Reads an image to show it in a note (raw bytes, not JSON).
#[tauri::command]
async fn read_image(path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    if !is_image_path(&p) {
        return Err("not an image".into());
    }
    if fs::metadata(&p).map_err(err)?.len() > MAX_IMAGE_SIZE {
        return Err("image too large".into());
    }
    Ok(tauri::ipc::Response::new(fs::read(&p).map_err(err)?))
}

/// Saves a pasted image. The bytes are the raw request body; the path comes
/// URI-encoded in the `x-path` header.
#[tauri::command]
async fn write_image(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("no path")?;
    let path = percent_decode(path)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("no image data".into());
    };
    save_new_image(Path::new(&path), bytes)
}

/// Writes an image to a new file: never over an existing file, never a non-image.
fn save_new_image(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if !is_image_path(target) {
        return Err("not an image".into());
    }
    if bytes.len() as u64 > MAX_IMAGE_SIZE {
        return Err("image too large".into());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(err)?;
        }
    }
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                EXISTS.to_string()
            } else {
                err(e)
            }
        })?;
    let written = f.write_all(bytes).and_then(|_| f.sync_all());
    if let Err(e) = written {
        drop(f);
        let _ = fs::remove_file(target);
        return Err(err(e));
    }
    Ok(())
}

/// Decodes a URI-encoded text (%XX sequences, UTF-8).
fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("bad path")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad path")?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "bad path".into())
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
    // The lock also orders this with deliver_paths (files opened during startup).
    let mut pending = state.pending.lock().unwrap();
    let mut paths = Vec::new();
    if label == "main" && !state.argv_taken.swap(true, Ordering::SeqCst) {
        let cwd = std::env::current_dir().unwrap_or_default();
        paths = resolve_paths(std::env::args().skip(1), &cwd);
    }
    paths.extend(pending.remove(label).unwrap_or_default());
    paths
}

/// Files the system asks KiloNote to open (second launch, "Open with", Finder):
/// shown in the last used window, or handed to the main window if it is still
/// starting.
fn deliver_paths(app: &AppHandle, paths: Vec<String>) {
    let state = app.state::<Windows>();
    {
        let mut pending = state.pending.lock().unwrap();
        if !state.argv_taken.load(Ordering::SeqCst) {
            pending.entry("main".into()).or_default().extend(paths);
            return;
        }
    }
    let last = state.last_focused.lock().unwrap().clone();
    let target = app
        .get_webview_window(&last)
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next());
    if let Some(window) = target {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if !paths.is_empty() {
            let _ = app.emit_to(window.label(), "kilonote://open-paths", paths);
        }
    }
}

/// Opens a new window (a fresh label, or a given one to restore a saved window).
/// Async on purpose: a synchronous command runs on the main thread, and
/// creating a webview from there deadlocks on Windows (WebView2).
#[tauri::command]
async fn open_window(
    app: AppHandle,
    state: State<'_, Windows>,
    paths: Vec<String>,
    label: Option<String>,
    position: Option<(f64, f64)>,
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
    // At the given place (a tab dropped outside the windows), otherwise
    // cascading from the window that has the focus.
    let focused = state.last_focused.lock().unwrap().clone();
    if let Some((x, y)) = position {
        config.center = false;
        config.x = Some(x);
        config.y = Some(y);
    } else if let Some(origin) = app.get_webview_window(&focused) {
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

/// The other KiloNote window under a screen point (physical pixels), if any.
#[tauri::command]
fn window_at(window: WebviewWindow, app: AppHandle, x: f64, y: f64) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, w)| {
            label != window.label()
                && w.is_visible().unwrap_or(false)
                && !w.is_minimized().unwrap_or(false)
        })
        .find(|(_, w)| match (w.outer_position(), w.outer_size()) {
            (Ok(pos), Ok(size)) => {
                let (left, top) = (pos.x as f64, pos.y as f64);
                x >= left
                    && y >= top
                    && x < left + size.width as f64
                    && y < top + size.height as f64
            }
            _ => false,
        })
        .map(|(label, _)| label)
}

/// Hands files to another window (a tab dragged onto it), which comes to the front.
#[tauri::command]
fn send_paths(app: AppHandle, label: String, paths: Vec<String>) -> Result<(), String> {
    if !valid_label(&label) {
        return Err(format!("invalid window label: {label}"));
    }
    let target = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window {label}"))?;
    let _ = target.unminimize();
    let _ = target.set_focus();
    app.emit_to(label.as_str(), "kilonote://open-paths", paths)
        .map_err(err)
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

/// Keeps the `keep` newest files of the local history (`<config>/history`, whose
/// file names start with a timestamp) and deletes the others.
#[tauri::command]
fn prune_history(app: AppHandle, keep: usize) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(err)?.join("history");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(());
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    files.sort();
    let extra = files.len().saturating_sub(keep);
    for file in files.into_iter().take(extra) {
        let _ = fs::remove_file(file);
    }
    Ok(())
}

/// The print dialog of the window (File: Print or save as PDF). The page's
/// print styles show only the note being printed.
#[tauri::command]
fn print_page(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(err)
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
            deliver_paths(
                app,
                resolve_paths(argv.into_iter().skip(1), Path::new(&cwd)),
            );
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
            read_changed,
            create_dir,
            create_file,
            rename_path,
            trash_path,
            read_image,
            write_image,
            config_dir,
            window_paths,
            open_window,
            window_count,
            window_at,
            send_paths,
            delete_session,
            prune_history,
            print_page
        ])
        .build(tauri::generate_context!())
        .expect("failed to start KiloNote")
        .run(|_app, _event| {
            // macOS hands the files opened from the Finder ("Open with", double
            // click, a file dropped on the Dock icon) as an event, not as arguments.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                deliver_paths(_app, paths);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_only_go_to_new_image_files() {
        let dir = std::env::temp_dir().join(format!("kilonote-img-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let png = dir.join("images").join("note-1.png");
        save_new_image(&png, b"\x89PNG data").unwrap();
        assert_eq!(fs::read(&png).unwrap(), b"\x89PNG data");
        // Never over an existing file.
        assert_eq!(save_new_image(&png, b"other").unwrap_err(), EXISTS);
        assert_eq!(fs::read(&png).unwrap(), b"\x89PNG data");
        // Only image types.
        for name in ["run.exe", "script.ps1", "notes.txt", "noext", "image.png.bat"] {
            assert!(save_new_image(&dir.join(name), b"x").is_err(), "{name}");
            assert!(!dir.join(name).exists());
        }
        assert!(is_image_path(Path::new("C:/a/Shot.PNG")));
        assert!(!is_image_path(Path::new("C:/a/shot.png.lnk")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unchanged_files_are_not_read_again() {
        let dir = std::env::temp_dir().join(format!("kilonote-fresh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let note = dir.join("note.txt");
        fs::write(&note, "first").unwrap();
        let first = read_fresh(&note, None, 1000).unwrap();
        assert_eq!(first.text.as_deref(), Some("first"));
        assert!(!first.same);
        // Known as it is: not read again.
        let again = read_fresh(&note, Some((first.mtime, first.size)), 1000).unwrap();
        assert!(again.same && again.text.is_none());
        // Changed (another size): read again.
        fs::write(&note, "changed!").unwrap();
        let changed = read_fresh(&note, Some((first.mtime, first.size)), 1000).unwrap();
        assert_eq!(changed.text.as_deref(), Some("changed!"));
        // Too large, binary, missing, a folder.
        assert!(read_fresh(&note, None, 3).unwrap().text.is_none());
        let bin = dir.join("bin.dat");
        fs::write(&bin, b"a\0b").unwrap();
        assert!(read_fresh(&bin, None, 1000).unwrap().text.is_none());
        assert!(read_fresh(&dir.join("gone.txt"), None, 1000).is_none());
        assert!(read_fresh(&dir, None, 1000).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn image_paths_are_decoded() {
        assert_eq!(percent_decode("C%3A%5CUsers%5CCl%C3%A9ment%5Cimg%201.png").unwrap(), "C:\\Users\\Clément\\img 1.png");
        assert!(percent_decode("%ZZ").is_err());
        assert!(percent_decode("abc%4").is_err());
        assert!(percent_decode("%FF").is_err());
    }

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
    fn encodings_round_trip() {
        let text = "caf\u{e9} \u{20ac} - todo\r\n";
        for enc in [
            "UTF-8",
            "UTF-8 BOM",
            "UTF-16 LE",
            "UTF-16 BE",
            "Windows-1252",
        ] {
            let (bytes, used) = encode(text, enc, true);
            assert_eq!(used, enc);
            assert_eq!(decode(bytes), (text.to_string(), enc));
        }
        // Not representable in Windows-1252: written as UTF-8.
        let (bytes, used) = encode("\u{2713} done", "Windows-1252", true);
        assert_eq!(used, "UTF-8");
        assert_eq!(bytes, "\u{2713} done".as_bytes());
        // Appending: no second BOM.
        assert_eq!(encode("x", "UTF-16 LE", false).0, vec![b'x', 0]);
    }

    #[test]
    fn appends_keep_the_file_encoding() {
        let dir = std::env::temp_dir().join(format!("kilonote-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let run =
            |mut f: std::pin::Pin<Box<dyn std::future::Future<Output = Result<Meta, String>>>>| {
                // The commands are async but never actually wait: poll them once.
                let waker = std::task::Waker::noop();
                match f.as_mut().poll(&mut std::task::Context::from_waker(waker)) {
                    std::task::Poll::Ready(r) => r,
                    std::task::Poll::Pending => panic!("pending"),
                }
            };
        let cp = dir.join("old_done.txt");
        fs::write(&cp, b"- caf\xe9 - done\r\n").unwrap();
        run(Box::pin(append_lines(
            cp.to_string_lossy().into(),
            vec!["- th\u{e9} - done".into()],
        )))
        .unwrap();
        assert_eq!(
            fs::read(&cp).unwrap(),
            b"- caf\xe9 - done\r\n- th\xe9 - done\r\n"
        );
        // A character Windows-1252 lacks: the file becomes UTF-8 as a whole.
        run(Box::pin(append_lines(
            cp.to_string_lossy().into(),
            vec!["- \u{2713} - ok".into()],
        )))
        .unwrap();
        assert_eq!(
            fs::read_to_string(&cp).unwrap(),
            "- caf\u{e9} - done\r\n- th\u{e9} - done\r\n- \u{2713} - ok\r\n"
        );
        let u16 = dir.join("u16_done.txt");
        fs::write(&u16, encode("- a - done\n", "UTF-16 LE", true).0).unwrap();
        run(Box::pin(append_lines(
            u16.to_string_lossy().into(),
            vec!["- b - done".into()],
        )))
        .unwrap();
        assert_eq!(
            decode(fs::read(&u16).unwrap()),
            ("- a - done\n- b - done\n".to_string(), "UTF-16 LE")
        );
        let _ = fs::remove_dir_all(&dir);
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
