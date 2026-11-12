// The image and video viewer: an image or a video opened in KiloNote (a click in
// the explorer, Ctrl+O, a file dropped outside a note, the command line) is
// shown here instead of being refused. ← → go through the images and videos of
// its folder.
// - An image: a click (or Space) switches between the whole image and its
//   actual size, + and − zoom, Ctrl+C copies it, "Add to the note" writes it
//   into the note being edited. It is read by the app (image files only) and
//   shown as a data: image.
// - A video: played with the usual controls, Space plays or pauses, Shift+← →
//   go back or forward 5 seconds. It is streamed piece by piece by the app's
//   own protocol (video files only, read only), never loaded whole.
// Nothing is handed to another program, nothing runs.

import type { App } from "../app/app";
import { addImagesToNote, loadImageFile } from "../app/images";
import { basename, dirname } from "../core/path";
import { isVideoFile, isViewableMedia } from "../text/images";
import { h, icon } from "./dom";
import { toast } from "./overlay";

const formatSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 83 → "1:23", 3725 → "1:02:05". */
function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}` : `${Math.floor(s / 60)}:${p2(s % 60)}`;
}

/** Zoom levels of + and −; "fit" shows the whole image. */
const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

const IMAGE_HINT = "← → other files · click or Space: actual size · + − zoom · Ctrl+C copy · Esc close";
const VIDEO_HINT = "← → other files · Space: play / pause · Shift+← →: 5 seconds back / forward · Esc close";

let current: MediaViewer | null = null;

/**
 * Shows an image or a video. ← → go through `list` when given (several files
 * opened at once), otherwise through the images and videos of its folder.
 */
export async function showMedia(app: App, path: string, list?: string[]): Promise<void> {
  current?.close(false);
  current = new MediaViewer(app, path, list);
  await current.ready;
}

/** The images and videos of a folder, by name (the way the explorer lists them). */
async function folderMedia(app: App, path: string): Promise<string[]> {
  const entries = await app.backend.listDir(dirname(path), app.settings?.show_hidden_files ?? false).catch(() => []);
  const media = (entries ?? []).filter((e) => !e.isDir && isViewableMedia(e.path)).map((e) => e.path);
  return media.length ? media : [path];
}

class MediaViewer {
  private backdrop: HTMLElement;
  private stage = h("div", { class: "kn-viewer-stage" });
  private img = h("img", { class: "kn-viewer-img", alt: "", draggable: "false" }) as HTMLImageElement;
  // (No "Download" in the player's menu: the video is already a file of this computer.)
  private video = h("video", { class: "kn-viewer-video", controls: true, preload: "metadata", playsinline: true, controlslist: "nodownload noremoteplayback" }) as HTMLVideoElement;
  private kindIcon = h("span", { class: "kn-viewer-kind" });
  private title = h("span", { class: "kn-viewer-name" });
  private info = h("span", { class: "kn-viewer-info" });
  private count = h("span", { class: "kn-viewer-count" });
  private hint = h("div", { class: "kn-viewer-hint" });
  private zoomBtn = h("button", { class: "kn-btn kn-viewer-zoom", title: "Whole image / actual size (click, Space)" });
  private copyBtn = h("button", { class: "kn-btn", title: "Copy the image (Ctrl+C)" }, "Copy");
  private addBtn = h("button", { class: "kn-btn", title: "Write this image into the note being edited" }, icon("plus"), "Add to the note");
  private prevBtn = h("button", { class: "kn-icon-btn", title: "Previous file (←)" }, icon("chevron", "kn-viewer-back"));
  private nextBtn = h("button", { class: "kn-icon-btn", title: "Next file (→)" }, icon("chevron"));
  private list: string[] = [];
  private index = 0;
  /** null: the whole image, fitted to the window; otherwise a scale. */
  private zoom: number | null = null;
  private token = 0;
  private isVideo = false;
  readonly ready: Promise<void>;

  constructor(private app: App, private path: string, list?: string[]) {
    const panel = h(
      "div",
      { class: "kn-viewer", role: "dialog", "aria-label": "Image or video" },
      h("div", { class: "kn-viewer-head" },
        this.kindIcon, this.title, this.info, h("span", { class: "kn-spacer" }), this.count, this.prevBtn, this.nextBtn,
        this.zoomBtn, this.copyBtn, this.addBtn,
        h("button", { class: "kn-icon-btn", title: "Reveal in file manager", onclick: () => void app.backend.reveal(this.path) }, icon("folderOpen")),
        h("button", { class: "kn-icon-btn", title: "Close (Esc)", onclick: () => this.close() }, icon("x"))),
      this.stage,
      this.hint,
    );
    this.stage.append(this.img, this.video);
    // "kn-modal-backdrop": global shortcuts stay off while the viewer is open.
    this.backdrop = h("div", { class: "kn-modal-backdrop kn-viewer-backdrop" }, panel);
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    this.img.addEventListener("click", () => this.setZoom(this.zoom == null ? 1 : null));
    // Ctrl+wheel zooms the image (not the text of the notes behind it).
    this.stage.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (!this.isVideo) this.step(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this.video.addEventListener("loadedmetadata", () => this.showVideoInfo());
    this.video.addEventListener("error", () => {
      if (!this.isVideo || !this.video.getAttribute("src")) return;
      this.fail(`"${basename(this.path)}" cannot be played here: its format or codec is not supported. "Reveal in file manager" opens its folder.`);
    });
    this.zoomBtn.addEventListener("click", () => this.setZoom(this.zoom == null ? 1 : null));
    this.copyBtn.addEventListener("click", () => void this.copy());
    this.prevBtn.addEventListener("click", () => this.go(-1));
    this.nextBtn.addEventListener("click", () => this.go(1));
    this.addBtn.addEventListener("click", () => void this.addToNote());
    document.getElementById("overlay-root")!.append(this.backdrop);
    document.addEventListener("keydown", this.onKey, true);
    this.list = list?.length ? list : [path];
    this.ready = this.show(path).then(async () => {
      if (list?.length) return;
      // The other images and videos of the folder, for ← and →.
      const all = await folderMedia(app, path);
      if (!this.backdrop.isConnected) return;
      this.list = all.some((p) => p === path) ? all : [path, ...all];
      this.index = Math.max(0, this.list.indexOf(this.path));
      this.updateCount();
    });
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.backdrop.isConnected) return;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (key === "Escape" || (mod && key.toLowerCase() === "w")) this.close();
    else if (this.isVideo && e.shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) this.seek(key === "ArrowLeft" ? -5 : 5);
    else if (key === "ArrowLeft" || key === "PageUp") this.go(-1);
    else if (key === "ArrowRight" || key === "PageDown") this.go(1);
    else if (key === "Home") this.goTo(0);
    else if (key === "End") this.goTo(this.list.length - 1);
    else if (this.isVideo) {
      if (key === " " || key === "Enter" || key.toLowerCase() === "k") this.togglePlay();
      else handled = false;
    } else if (key === " " || key === "Enter") this.setZoom(this.zoom == null ? 1 : null);
    else if (key === "+" || key === "=") this.step(1);
    else if (key === "-") this.step(-1);
    else if (key === "0") this.setZoom(null);
    else if (mod && key.toLowerCase() === "c") void this.copy();
    else handled = false;
    // Inside the viewer, keys belong to it (the video's own controls keep theirs).
    if (handled || !(e.target as HTMLElement).closest?.("input, textarea, video")) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private async show(path: string) {
    const token = ++this.token;
    this.path = path;
    this.index = Math.max(0, this.list.indexOf(path));
    this.isVideo = isVideoFile(path);
    this.title.textContent = basename(path);
    this.title.title = path;
    this.info.textContent = "";
    this.kindIcon.replaceChildren(icon(this.isVideo ? "fileVideo" : "fileImage"));
    this.hint.textContent = this.isVideo ? VIDEO_HINT : IMAGE_HINT;
    this.updateCount();
    this.stopVideo();
    this.stage.classList.remove("failed");
    this.stage.classList.toggle("video", this.isVideo);
    this.stage.querySelector(".kn-viewer-error")?.remove();
    if (this.isVideo) return this.showVideo(path);
    const [url, meta] = await Promise.all([loadImageFile(this.app, path), this.app.backend.stat(path).catch(() => null)]);
    if (token !== this.token || !this.backdrop.isConnected) return;
    if (!url) {
      this.img.removeAttribute("src");
      this.fail(`"${basename(path)}" cannot be shown: missing, too large (over 50 MB) or not an image.`);
      return;
    }
    this.img.src = url;
    this.img.alt = basename(path);
    await (this.img.decode ? this.img.decode() : Promise.resolve()).catch(() => {});
    if (token !== this.token) return;
    const size = meta ? ` · ${formatSize(meta.size)}` : "";
    this.info.textContent = this.img.naturalWidth ? `${this.img.naturalWidth} × ${this.img.naturalHeight}${size}` : size.slice(3);
    this.setZoom(null);
    // The next and previous images, ready before they are asked for.
    for (const d of [1, -1]) {
      const next = this.list[(this.index + d + this.list.length) % this.list.length];
      if (next && next !== path && !isVideoFile(next)) void loadImageFile(this.app, next);
    }
  }

  private async showVideo(path: string) {
    const token = this.token;
    this.img.removeAttribute("src");
    this.setZoom(null);
    const url = this.app.backend.mediaUrl(path);
    if (typeof url !== "string") {
      this.fail("Videos play in the desktop app.");
      return;
    }
    this.size = null;
    void this.app.backend.stat(path).then(
      (meta) => {
        if (token !== this.token) return;
        this.size = meta?.size ?? null;
        this.showVideoInfo();
      },
      () => {},
    );
    this.video.src = url;
    this.video.focus({ preventScroll: true });
  }

  /** The size of the file shown (null: not known yet). */
  private size: number | null = null;

  private showVideoInfo() {
    if (!this.isVideo) return;
    const parts: string[] = [];
    if (this.video.videoWidth) parts.push(`${this.video.videoWidth} × ${this.video.videoHeight}`);
    if (Number.isFinite(this.video.duration) && this.video.duration > 0) parts.push(formatDuration(this.video.duration));
    if (this.size != null) parts.push(formatSize(this.size));
    this.info.textContent = parts.join(" · ");
  }

  /** Stops the video shown before (playing and streaming). */
  private stopVideo() {
    if (!this.video.getAttribute("src")) return;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }

  private togglePlay() {
    if (this.video.paused) void this.video.play().catch(() => {});
    else this.video.pause();
  }

  private seek(by: number) {
    const d = this.video.duration;
    if (!Number.isFinite(d)) return;
    this.video.currentTime = Math.max(0, Math.min(d, this.video.currentTime + by));
  }

  private fail(message: string) {
    this.stage.classList.add("failed");
    this.stage.querySelector(".kn-viewer-error")?.remove();
    this.stage.append(h("div", { class: "kn-viewer-error" }, message));
  }

  private updateCount() {
    const many = this.list.length > 1;
    this.count.textContent = many ? `${this.index + 1} / ${this.list.length}` : "";
    this.prevBtn.hidden = this.nextBtn.hidden = !many;
    const doc = this.app.active;
    // Images only: zoom, copy, and adding to a note (a note shows images, not videos).
    this.zoomBtn.hidden = this.copyBtn.hidden = this.isVideo;
    this.addBtn.hidden = this.isVideo || !doc || (doc.lang !== "text" && doc.lang !== "markdown");
  }

  private go(by: number) {
    if (this.list.length < 2) return;
    this.goTo((this.index + by + this.list.length) % this.list.length);
  }

  private goTo(i: number) {
    const path = this.list[i];
    if (path && path !== this.path) void this.show(path);
  }

  /** null: the whole image in the window; a number: that scale (1: actual size). */
  private setZoom(zoom: number | null) {
    this.zoom = zoom;
    const fit = zoom == null;
    this.stage.classList.toggle("fit", fit);
    if (fit) {
      this.img.style.width = "";
      this.img.style.height = "";
    } else {
      this.img.style.width = `${Math.round(this.img.naturalWidth * zoom)}px`;
      this.img.style.height = `${Math.round(this.img.naturalHeight * zoom)}px`;
    }
    this.zoomBtn.textContent = fit ? "Fit" : `${Math.round(zoom * 100)} %`;
  }

  /** The scale the image is shown at (fitted: how much of its actual size). */
  private shownScale(): number {
    if (this.zoom != null) return this.zoom;
    return this.img.naturalWidth ? this.img.getBoundingClientRect().width / this.img.naturalWidth : 1;
  }

  private step(dir: 1 | -1) {
    const now = this.shownScale();
    const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.001) : [...ZOOMS].reverse().find((z) => z < now - 0.001);
    if (next != null) this.setZoom(next);
  }

  /** Ctrl+C: the image on the clipboard (as PNG, which every app accepts). */
  private async copy() {
    if (this.isVideo || !this.img.naturalWidth) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = this.img.naturalWidth;
      canvas.height = this.img.naturalHeight;
      canvas.getContext("2d")!.drawImage(this.img, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("no image");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Image copied", { timeout: 1500 });
    } catch {
      toast("Could not copy the image", { kind: "error" });
    }
  }

  /** The image into the note being edited, at its cursor (copied next to it when it lives elsewhere). */
  private async addToNote() {
    const doc = this.app.active;
    if (!doc || this.isVideo) return;
    const path = this.path;
    this.close();
    if (await addImagesToNote(this.app, [path])) toast(`"${basename(path)}" added to ${this.app.docName(doc)}`, { timeout: 1800 });
  }

  close(focus = true) {
    if (!this.backdrop.isConnected) return;
    this.token++;
    this.stopVideo();
    this.backdrop.remove();
    document.removeEventListener("keydown", this.onKey, true);
    if (current === this) current = null;
    if (focus) this.app.focusEditor();
  }
}
