// Mini-utilitaires DOM (pas de framework : léger et rapide).

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
        if (sv == null) continue;
        if (sk.startsWith("--")) el.style.setProperty(sk, sv);
        else (el.style as unknown as Record<string, string>)[sk] = sv;
      }
    } else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const ICONS: Record<string, string> = {
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  file: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/>',
  fileDone: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/><path d="m9 14.5 2 2 4-4"/>',
  fileMd: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/><path d="M8.5 17v-4l2 2 2-2v4M15.5 13v4m-1.3-1.3 1.3 1.3 1.3-1.3"/>',
  files: '<path d="M15 3H9.5A2.5 2.5 0 0 0 7 5.5v10A2.5 2.5 0 0 0 9.5 18h7a2.5 2.5 0 0 0 2.5-2.5V7z"/><path d="M15 3v4h4"/><path d="M4 8v10.5A2.5 2.5 0 0 0 6.5 21H14"/>',
  tasks: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5"/><circle cx="5.5" cy="18" r="1.6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M17 7 7 17M7 7l10 10"/>',
  chevron: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  chevronDown: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  newFile: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  newFolder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/><path d="M12 10v6M9 13h6"/>',
  collapse: '<path d="m7 10 5-5 5 5M7 19l5-5 5 5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  archive: '<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4"/>',
  cycle: '<path d="M4.5 12a7.5 7.5 0 0 1 13-5.1L19.5 9"/><path d="M19.5 4v5h-5"/><path d="M19.5 12a7.5 7.5 0 0 1-13 5.1L4.5 15"/><path d="M4.5 20v-5h5"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>',
  command: '<path d="m5 8 4 4-4 4M12 16.5h7"/>',
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9 4.5v15"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-1.2-1-1.5-1-2.6 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="10" cy="7" r="1.1"/><circle cx="14.5" cy="7" r="1.1"/>',
  dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14.5h10"/>',
  folderOpen: '<path d="M3 17V7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h6.5A2.5 2.5 0 0 1 20 9.5V10"/><path d="M3 17.5 5.6 11.4A2 2 0 0 1 7.4 10.2H20a1 1 0 0 1 .9 1.4l-2.6 6.2A2 2 0 0 1 16.5 19h-12A1.5 1.5 0 0 1 3 17.5z"/>',
};

export function icon(name: keyof typeof ICONS | string, cls = ""): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `kn-icon ${cls}`.trim();
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  return span;
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove();
}

/** Met en évidence les positions trouvées par la recherche floue. */
export function highlighted(text: string, positions: number[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const set = new Set(positions);
  let buf = "";
  let inMatch = false;
  const flush = () => {
    if (!buf) return;
    frag.append(inMatch ? h("mark", {}, buf) : document.createTextNode(buf));
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMatch) {
      flush();
      inMatch = m;
    }
    buf += text[i];
  }
  flush();
  return frag;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}
