// Secrets in notes, in the editor: an encrypted block (text/secrets.ts) is shown
// as a small "Secret" box instead of its armored text, that the cursor steps
// over. A click on it asks for the password (app/secrets.ts).

import { EditorState, type Extension, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { findSecrets, SECRET_BEGIN, SECRET_END, type SecretBlock } from "../text/secrets";
import { icon } from "../ui/icons";

/** What the editor needs from the app: showing a secret, saying why an edit was refused. */
export interface SecretHost {
  reveal(view: EditorView, block: SecretBlock): void;
  refused(): void;
}

let host: SecretHost | null = null;
export function setSecretHost(h: SecretHost) {
  host = h;
}

class SecretWidget extends WidgetType {
  constructor(readonly size: number) {
    super();
  }

  eq(other: SecretWidget) {
    return other.size === this.size;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-secret";
    box.title = "Encrypted with a password: click to reveal it";
    const part = (cls: string, text: string) => {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      return span;
    };
    box.append(icon("lock", "cm-secret-lock"), part("cm-secret-label", "Secret"), part("cm-secret-hint", "click to reveal"));
    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const block = view.state.field(secretsField).blocks.find((b) => b.from <= pos && pos <= b.to);
      if (block) host?.reveal(view, block);
    });
    return box;
  }

  ignoreEvent() {
    return true;
  }
}

interface Secrets {
  blocks: SecretBlock[];
  decorations: DecorationSet;
}

function scan(state: EditorState): Secrets {
  const blocks = findSecrets(state.doc.iterLines());
  const decorations = Decoration.set(
    blocks.map((b) => Decoration.replace({ widget: new SecretWidget(b.to - b.from), block: true }).range(b.from, b.to)),
  );
  return { blocks, decorations };
}

const isMarker = (text: string) => {
  const t = text.trim();
  return t === SECRET_BEGIN || t === SECRET_END;
};

/** The secret blocks of the note: read again only when an edit touches one, or writes a marker line. */
export const secretsField = StateField.define<Secrets>({
  create: scan,
  update(value, tr) {
    if (!tr.docChanged) return value;
    let again = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB) => {
      if (again) return;
      if (value.blocks.some((b) => fromA <= b.to && toA >= b.from)) again = true;
      else {
        const doc = tr.state.doc;
        for (let n = doc.lineAt(fromB).number, last = doc.lineAt(toB).number; n <= last && !again; n++) again = isMarker(doc.line(n).text);
      }
    });
    if (again) return scan(tr.state);
    return {
      blocks: value.blocks.map((b) => ({ from: tr.changes.mapPos(b.from, 1), to: tr.changes.mapPos(b.to, -1) })),
      decorations: value.decorations.map(tr.changes),
    };
  },
  provide: (f) => [EditorView.decorations.from(f, (s) => s.decorations), EditorView.atomicRanges.of((view) => view.state.field(f).decorations)],
});

/**
 * No edit changes a part of a secret (its text would not open any more): a
 * secret is replaced or deleted as a whole. "Replace all" skips the matches in
 * secrets; any other edit that would change one is refused.
 */
const protectSecrets = EditorState.changeFilter.of((tr) => {
  const blocks = tr.startState.field(secretsField, false)?.blocks;
  if (!blocks?.length || !tr.docChanged) return true;
  const touched: SecretBlock[] = [];
  tr.changes.iterChangedRanges((fromA, toA) => {
    for (const b of blocks) {
      const partly = fromA < b.to && toA > b.from && !(fromA <= b.from && toA >= b.to);
      if (partly && !touched.includes(b)) touched.push(b);
    }
  });
  if (!touched.length) return true;
  if (tr.isUserEvent("input.replace.all")) return touched.flatMap((b) => [b.from, b.to]);
  host?.refused();
  return false;
});

/** Secrets shown as boxes in notes, and kept whole. */
export const noteSecrets: Extension = [secretsField, protectSecrets];
