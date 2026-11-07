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

const SHELL = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"></head><body></body></html>`;

export class HtmlFrame {
  readonly el: HTMLIFrameElement;
  private ready: Promise<void>;
  private resolveReady!: () => void;

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
      if (e.type === "click" && /^(https?:|mailto:)/i.test(href)) this.openUrl(href);
    };
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("auxclick", onClick, true);
    doc.addEventListener("submit", (e) => e.preventDefault(), true);
    this.resolveReady();
  }

  /** Shows a page; the scroll position is kept from one update to the next. */
  async show(src: string, kind: "html" | "svg") {
    await this.ready;
    const doc = this.el.contentDocument;
    if (!doc?.documentElement) return;
    const scroller = doc.scrollingElement;
    const top = scroller?.scrollTop ?? 0;
    const left = scroller?.scrollLeft ?? 0;
    const clean = kind === "svg" ? svgPage(src) : sanitizeHtml(src);
    // The frame keeps its policy: it belongs to the document, not to the <meta>.
    doc.replaceChild(doc.importNode(clean.documentElement, true), doc.documentElement);
    if (doc.scrollingElement) {
      doc.scrollingElement.scrollTop = top;
      doc.scrollingElement.scrollLeft = left;
    }
  }
}
