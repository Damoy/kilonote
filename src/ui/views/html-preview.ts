// HTML (and SVG) preview, in a sandboxed frame:
//  - no script ever runs (no "allow-scripts"), forms, pop-ups and navigation
//    are off, and the page is cleaned first (scripts, frames, plugins, <base>,
//    <link>, refresh and event attributes removed);
//  - nothing is loaded from the network or the disk: the frame's own policy
//    only allows inline styles and data: images and fonts;
//  - links open in the browser (http, https, mailto), like in the Markdown preview.
// "allow-same-origin" (without "allow-scripts") only lets KiloNote keep the
// scroll position and catch the link clicks.

export const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

const DROP = [
  "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
  "base", "link", "meta[http-equiv]", "set", "animate[attributeName='href' i]", "animate[attributeName='xlink:href' i]",
].join(",");
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "data", "poster", "background", "srcset"]);

/** A cleaned copy of a page: what is left cannot run code nor load anything. */
export function sanitizeHtml(src: string): Document {
  const doc = new DOMParser().parseFromString(src, "text/html");
  doc.querySelectorAll(DROP).forEach((e) => e.remove());
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      // Browsers ignore tabs, line breaks and control characters in URLs ("java\nscript:").
      const url = attr.value.replace(/[\u0000-\u0020]/g, "");
      // autofocus would take the keyboard from the editor at every update.
      if (name.startsWith("on") || name === "srcdoc" || name === "http-equiv" || name === "autofocus" || name === "autoplay") el.removeAttribute(attr.name);
      else if (URL_ATTRS.has(name) && /^(?:javascript|vbscript|data:text\/html|data:application)/i.test(url)) el.removeAttribute(attr.name);
      // SVG <image>, <use>, <feImage>: nothing from outside.
      else if ((name === "href" || name === "xlink:href") && !["a", "area"].includes(el.localName) && /^(?:[a-z][\w+.-]*:|\/\/)/i.test(url) && !/^data:image\//i.test(url)) el.removeAttribute(attr.name);
    }
  }
  for (const form of doc.querySelectorAll("form")) form.removeAttribute("action");
  // Remote images, videos… are not even requested (the frame policy would block them anyway).
  for (const el of doc.querySelectorAll("[src], [srcset], [poster], [data]")) {
    for (const name of ["src", "srcset", "poster", "data"]) {
      const v = el.getAttribute(name);
      if (v && /^\s*(?:[a-z][\w+.-]*:|\/\/)/i.test(v) && !/^\s*data:/i.test(v)) el.removeAttribute(name);
    }
  }
  return doc;
}

/** An SVG file shown as an image (an image never runs scripts), on a checkerboard. */
export function svgPage(src: string): Document {
  const doc = document.implementation.createHTMLDocument("");
  doc.body.setAttribute(
    "style",
    "margin:0;min-height:100vh;display:grid;place-items:center;background:#fff repeating-conic-gradient(#e8e8e8 0 25%, #fff 0 50%) 0 0/20px 20px",
  );
  const img = doc.createElement("img");
  img.alt = "SVG preview";
  img.setAttribute("style", "max-width:92%;max-height:92vh");
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
  doc.body.append(img);
  return doc;
}

// ---------------------------------------------------------------------------
// Editing the text of the page in the preview

/** Elements whose content is not markup (never made editable). */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

export interface TextRun {
  from: number;
  to: number;
}

/**
 * The runs of text of a page (between tags, outside comments, scripts, styles
 * and SVG), with their place in the source, and the page with each run wrapped
 * in a <kn-t data-kn="n"> element, so that an edit in the preview can be
 * written back at the right place.
 */
export function markTextRuns(src: string): { marked: string; runs: TextRun[] } {
  const runs: TextRun[] = [];
  let out = "";
  let last = 0;
  let foreign = 0; // inside <svg> or <math>: text there is not plain HTML text
  let seg = 0; // start of the current text segment
  const n = src.length;
  const text = (from: number, to: number) => {
    if (foreign || to <= from) return;
    const s = src.slice(from, to);
    const a = from + (s.length - s.trimStart().length);
    const b = to - (s.length - s.trimEnd().length);
    if (b <= a) return;
    runs.push({ from: a, to: b });
    out += `${src.slice(last, a)}<kn-t data-kn="${runs.length - 1}">${src.slice(a, b)}</kn-t>`;
    last = b;
  };
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    const next = src[lt + 1] ?? "";
    // "a < b": not a tag, still text.
    if (!/[A-Za-z/!?]/.test(next)) {
      i = lt + 1;
      continue;
    }
    text(seg, lt);
    if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt + 4);
      i = seg = e < 0 ? n : e + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      const close = src.startsWith("<![CDATA[", lt) ? "]]>" : ">";
      const e = src.indexOf(close, lt + 2);
      i = seg = e < 0 ? n : e + close.length;
      continue;
    }
    let j = lt + 1;
    let q: string | null = null;
    for (; j < n; j++) {
      const c = src[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    const tag = src.slice(lt, j + 1);
    i = seg = Math.min(n, j + 1);
    const m = /^<(\/?)([A-Za-z][^\s/>]*)/.exec(tag);
    if (!m) continue;
    const name = m[2].toLowerCase();
    if (name === "svg" || name === "math") {
      if (m[1]) foreign = Math.max(0, foreign - 1);
      else if (!/\/\s*>$/.test(tag)) foreign++;
    } else if (!m[1] && !foreign && RAW_TEXT.has(name)) {
      const re = new RegExp(`</${name}\\s*>`, "ig");
      re.lastIndex = i;
      const r = re.exec(src);
      i = seg = r ? r.index + r[0].length : n;
    }
  }
  text(seg, n);
  out += src.slice(last);
  return { marked: out, runs };
}

/** Text typed in the preview, written as HTML text (it can never become markup). */
export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
}

/** How editable text looks in the preview. */
const EDIT_STYLE = `kn-t[contenteditable]{outline:1px dashed rgba(123,108,246,.35);outline-offset:1px;border-radius:2px;cursor:text}
kn-t[contenteditable]:hover{outline-color:rgba(123,108,246,.85)}
kn-t[contenteditable]:focus{outline:2px solid #7b6cf6;background:rgba(123,108,246,.1)}`;

const SHELL = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"></head><body></body></html>`;

export class HtmlFrame {
  readonly el: HTMLIFrameElement;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private editing = false;
  /** Watches the edited text (an observer works in every engine: WebKit runs no
   *  event listener inside a frame that may not run scripts). */
  private observer: MutationObserver | null = null;
  /** A run of text was changed in the preview (its index, its new text). */
  onEdit: ((index: number, text: string) => void) | null = null;
  /** Key presses in the page (the app's shortcuts keep working there). */
  onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor(private openUrl: (url: string) => void) {
    const el = document.createElement("iframe");
    el.className = "pv-frame";
    el.title = "Page preview";
    el.setAttribute("sandbox", "allow-same-origin");
    el.setAttribute("referrerpolicy", "no-referrer");
    this.el = el;
    this.ready = new Promise((r) => (this.resolveReady = r));
    el.addEventListener("load", () => this.onLoad());
    el.srcdoc = SHELL;
  }

  private onLoad() {
    const doc = this.el.contentDocument;
    if (!doc) return;
    // The frame left the preview (a link that was not caught): back to the shell.
    if (doc.URL !== "about:srcdoc") {
      this.el.srcdoc = SHELL;
      return;
    }
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href], area[href]");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) return; // a link inside the page
      e.preventDefault();
      // While editing, a click on a link places the cursor in its text.
      if (this.editing) return;
      if (e.type === "click" && /^(https?:|mailto:)/i.test(href)) this.openUrl(href);
    };
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("auxclick", onClick, true);
    doc.addEventListener("submit", (e) => e.preventDefault(), true);
    doc.addEventListener("keydown", (e) => {
      const inRun = (e.target as Element | null)?.closest?.("kn-t[contenteditable]");
      // One run of text: Enter or Escape ends the edit (no new paragraph).
      if (inRun && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        (inRun as HTMLElement).blur();
        return;
      }
      this.onKey?.(e);
    }, true);
    this.resolveReady();
  }

  /**
   * Shows a page; the scroll position is kept from one update to the next.
   * With `edit`, its text can be changed in place (see markTextRuns).
   */
  async show(src: string, kind: "html" | "svg", edit = false) {
    await this.ready;
    const doc = this.el.contentDocument;
    if (!doc?.documentElement) return;
    const scroller = doc.scrollingElement;
    const top = scroller?.scrollTop ?? 0;
    const left = scroller?.scrollLeft ?? 0;
    this.editing = edit && kind === "html";
    const clean = kind === "svg" ? svgPage(src) : sanitizeHtml(this.editing ? markTextRuns(src).marked : src);
    if (this.editing) {
      for (const run of clean.querySelectorAll("kn-t[data-kn]")) {
        run.setAttribute("contenteditable", "plaintext-only");
        run.setAttribute("spellcheck", "false");
      }
      const style = clean.createElement("style");
      style.textContent = EDIT_STYLE;
      clean.head.append(style);
    }
    // The frame keeps its policy: it belongs to the document, not to the <meta>.
    this.observer?.disconnect();
    doc.replaceChild(doc.importNode(clean.documentElement, true), doc.documentElement);
    if (this.editing) {
      this.observer = new MutationObserver((records) => {
        const runs = new Set<Element>();
        for (const r of records) {
          const node = r.target.nodeType === Node.TEXT_NODE ? r.target.parentElement : (r.target as Element);
          const run = node?.closest?.("kn-t[data-kn]");
          if (run) runs.add(run);
        }
        for (const run of runs) this.onEdit?.(Number(run.getAttribute("data-kn")), run.textContent ?? "");
      });
      this.observer.observe(doc.documentElement, { characterData: true, childList: true, subtree: true });
    }
    if (doc.scrollingElement) {
      doc.scrollingElement.scrollTop = top;
      doc.scrollingElement.scrollLeft = left;
    }
  }
}
