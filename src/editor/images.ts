// Images shown in notes: under each line that references an image
// (`![image](images/shot.png)`), the image itself. The text is left as it is:
// the note stays a plain text file that any editor can open.
// Pasting an image (a screenshot…) saves it next to the note and writes the
// reference (app/images.ts does the saving).

import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { imageRefs } from "../text/images";

/** What the editor needs from the app: loading an image, saving a pasted one. */
export interface ImageHost {
  /** The image as a data URL, or null when it cannot be shown (missing, web image…). */
  load(ref: string): Promise<string | null>;
  /** An image was pasted in the note shown by `view`. */
  paste(view: EditorView, image: File): void;
  /** Image files were dropped on the note, at `pos`. */
  drop(view: EditorView, images: File[], pos: number): void;
}

let host: ImageHost | null = null;
export function setImageHost(h: ImageHost) {
  host = h;
}

/** Heights of the images already shown, so that lines don't jump when they come back into view. */
const heights = new Map<string, number>();

class ImagesWidget extends WidgetType {
  constructor(readonly refs: string[]) {
    super();
  }

  eq(other: ImagesWidget) {
    return other.refs.length === this.refs.length && other.refs.every((r, i) => r === this.refs[i]);
  }

  get estimatedHeight() {
    return Math.max(...this.refs.map((r) => heights.get(r) ?? 120)) + 12;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-note-images";
    for (const ref of this.refs) {
      const img = document.createElement("img");
      img.className = "cm-note-image";
      img.alt = ref;
      img.title = `${ref} · click to enlarge`;
      img.draggable = false;
      const known = heights.get(ref);
      if (known) img.style.minHeight = `${known}px`;
      img.addEventListener("load", () => {
        img.style.minHeight = "";
        heights.set(ref, img.getBoundingClientRect().height || img.naturalHeight);
        view.requestMeasure();
      });
      img.addEventListener("click", () => {
        img.classList.toggle("full");
        view.requestMeasure();
      });
      box.append(img);
      void (host?.load(ref) ?? Promise.resolve(null)).then((url) => {
        if (url) img.src = url;
        else {
          const missing = document.createElement("span");
          missing.className = "cm-note-image-missing";
          missing.textContent = `Image not found: ${ref}`;
          img.replaceWith(missing);
          view.requestMeasure();
        }
      });
    }
    return box;
  }

  ignoreEvent() {
    return true;
  }
}

const imageLine = Decoration.line({ class: "cm-note-image-line" });

function lineDecorations(state: EditorState, from: number, to: number): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (let pos = from; pos <= to; ) {
    const line = state.doc.lineAt(pos);
    const refs = imageRefs(line.text);
    if (refs.length) {
      // The reference itself stays discreet: the image is what matters.
      out.push(imageLine.range(line.from));
      out.push(Decoration.widget({ widget: new ImagesWidget(refs), block: true, side: 1 }).range(line.to));
    }
    pos = line.to + 1;
  }
  return out;
}

/** The image blocks, kept up to date line by line (only the edited lines are read again). */
export const imagesField = StateField.define<DecorationSet>({
  create: (state) => Decoration.set(lineDecorations(state, 0, state.doc.length)),
  update(decos, tr) {
    if (!tr.docChanged) return decos;
    decos = decos.map(tr.changes);
    const doc = tr.state.doc;
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      const from = doc.lineAt(fromB).from;
      const to = doc.lineAt(Math.min(toB, doc.length)).to;
      decos = decos.update({ filter: (f) => f < from || f > to, filterFrom: from, filterTo: to, add: lineDecorations(tr.state, from, to), sort: true });
    });
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * A pasted image (and no text with it: text from a spreadsheet comes with a
 * picture of it), and image files dropped on the note (the editor would
 * otherwise insert their bytes as text).
 */
const addImages = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    if (!data || !host || data.getData("text/plain")) return false;
    const file = [...data.items].find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
    if (!file) return false;
    event.preventDefault();
    host.paste(view, file);
    return true;
  },
  drop(event, view) {
    const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length || !host) return false;
    event.preventDefault();
    host.drop(view, files, view.posAtCoords({ x: event.clientX, y: event.clientY }, false));
    return true;
  },
});

/** Images in notes: shown under their line, pasted from the clipboard or dropped. */
export function noteImages(show: boolean): Extension {
  return show ? [imagesField, addImages] : addImages;
}
