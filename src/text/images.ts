// Images in notes: a note keeps a plain text reference, in the Markdown way
// (`![image](images/notes-2026-11-09-153012.png)`), to an image file stored next
// to it. The editor shows the image under that line; the text stays plain text.

import { isWindowsPath, join } from "../core/path";

/** The image types a note can show or receive (the native side checks the same list). */
export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** Largest image pasted or shown (bytes), as on the native side. */
export const MAX_IMAGE_SIZE = 50 * 1024 * 1024;

/** `![alt](destination "title")`; the destination may be written `<with spaces>`. */
const IMAGE_REF = /!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g;

/** The image destinations written on a line, in order. */
export function imageRefs(line: string): string[] {
  if (!line.includes("![")) return [];
  const out: string[] = [];
  for (const m of line.matchAll(IMAGE_REF)) out.push(m[1] ?? m[2]);
  return out;
}

/** The extension for a pasted image type (`image/jpeg` → `jpg`), or null if not an image a note can hold. */
export function extForMime(mime: string): string | null {
  if (mime === "image/jpeg") return "jpg";
  const ext = Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k] === mime);
  return ext ?? null;
}

/** The file name of an image pasted into a note: `<note>-<date>-<time>[-n].<ext>`. */
export function pastedImageName(noteStem: string, at: Date, ext: string, n = 1): string {
  const safe = noteStem.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "image";
  const p = (x: number) => String(x).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${safe}-${stamp}${n > 1 ? `-${n}` : ""}.${ext}`;
}

/** The file name of an image dropped on a note, after its own name: `diagram.png`, `diagram-2.png`… */
export function droppedImageName(fileName: string, n = 1): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "png";
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "image";
  return `${base}${n > 1 ? `-${n}` : ""}.${ext}`;
}

/** True for a file a note can show (by its extension). */
export function isImageFile(path: string): boolean {
  return Object.hasOwn(IMAGE_TYPES, extOf(path));
}

/** The reference written in the note for an image in `folder` (relative to the note). */
export function imageMarkup(folder: string, name: string): string {
  const parts = [...folder.split(/[\\/]+/).filter(Boolean), name];
  const dest = parts.join("/");
  return `![image](${/[\s()<>]/.test(dest) ? `<${dest}>` : dest})`;
}

/**
 * The file an image reference points to: relative to the note's folder, or an
 * absolute path. Web images and inline data are not loaded (null).
 */
export function resolveImage(ref: string, noteDir: string | null): string | null {
  let dest = ref.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(dest) || /^(data|mailto|javascript):/i.test(dest)) return null;
  if (!(Object.hasOwn(IMAGE_TYPES, extOf(dest)))) return null;
  try {
    dest = decodeURI(dest);
  } catch {
    /* a lone % stays as it is */
  }
  if (isWindowsPath(dest) || dest.startsWith("/")) return dest;
  if (!noteDir) return null;
  return join(noteDir, ...dest.split(/[\\/]+/).filter((s) => s && s !== "."));
}

function extOf(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1].toLowerCase() : "";
}
