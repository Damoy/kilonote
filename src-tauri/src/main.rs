// KiloNote — native backend.
// All the interface logic lives in the frontend (TypeScript). Only what must be
// native stays here: fast disk access, atomic writes, trash, single instance.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
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

#[tauri::command]
async fn read_text(path: String) -> Result<FileText, String> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(err)?;
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
            Some(decode(fs::read(p).ok()?).0)
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

/// Paths passed on the command line (`kilonote notes/` or `kilonote work.txt`).
#[tauri::command]
fn startup_paths() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    resolve_paths(std::env::args().skip(1), &cwd)
}

fn main() {
    tauri::Builder::default()
        // A single KiloNote window: launching the app again (pinned shortcut,
        // "Open with"…) brings the existing window back and opens the files there.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let paths = resolve_paths(argv.into_iter().skip(1), Path::new(&cwd));
            if !paths.is_empty() {
                let _ = app.emit("kilonote://open-paths", paths);
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // The frontend shows the window once ready (no white flash).
            // Safety net: show it anyway after a short delay.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2500));
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                });
            }
            Ok(())
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
            startup_paths
        ])
        .run(tauri::generate_context!())
        .expect("failed to start KiloNote");
}
