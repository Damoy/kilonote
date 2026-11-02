// Petits utilitaires de chemins, compatibles Windows (\) et Unix (/).

const lastSep = (p: string) => Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));

export const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");

export function sepOf(p: string): string {
  return isWindowsPath(p) || (p.includes("\\") && !p.includes("/")) ? "\\" : "/";
}

export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = lastSep(trimmed);
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function dirname(p: string): string {
  const i = lastSep(p);
  if (i < 0) return "";
  if (i === 0) return p.slice(0, 1);
  return p.slice(0, i);
}

export function join(dir: string, ...names: string[]): string {
  let out = dir;
  const sep = sepOf(dir);
  for (const n of names) {
    if (!n) continue;
    out = /[\\/]$/.test(out) ? out + n : out + sep + n;
  }
  return out;
}

/** Extension en minuscules, sans le point (`mc.TXT` → `txt`). */
export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}

/** Nom sans extension (`mc_done.txt` → `mc_done`). */
export function stem(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

export function relative(root: string | null, p: string): string {
  if (!root) return p;
  if (samePath(p, root)) return "";
  if (isInside(p, root)) return p.slice(root.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "");
  return p;
}

export function samePath(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return isWindowsPath(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export function isInside(child: string, parent: string): boolean {
  const c = child.replace(/\\/g, "/");
  const p = parent.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return isWindowsPath(child) ? c.toLowerCase().startsWith(p.toLowerCase()) : c.startsWith(p);
}

/** `projets/mc.txt` → `projets/mc_done.txt` */
export function doneFileFor(p: string, suffix: string): string {
  const ext = extname(p) ? p.slice(p.lastIndexOf(".")) : "";
  return join(dirname(p), stem(p) + suffix + ext);
}

export function isDoneFile(p: string, suffix: string): boolean {
  return !!suffix && stem(p).toLowerCase().endsWith(suffix.toLowerCase());
}

/** Nom de projet associé à un fichier (sans le suffixe d'archive). */
export function projectName(p: string, suffix: string): string {
  const s = stem(p);
  return isDoneFile(p, suffix) ? s.slice(0, s.length - suffix.length) : s;
}

const BINARY_EXT = new Set(
  "png jpg jpeg gif bmp ico icns webp avif tiff psd pdf zip gz tgz 7z rar xz bz2 exe dll so dylib bin dat iso dmg msi deb rpm appimage class jar war pyc o a lib woff woff2 ttf otf eot mp3 mp4 m4a wav ogg flac avi mov mkv webm doc docx xls xlsx ppt pptx odt ods odp sqlite db".split(
    " ",
  ),
);

export const isProbablyBinary = (p: string) => BINARY_EXT.has(extname(p));
