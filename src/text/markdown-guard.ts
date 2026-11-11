// Markdown built to be nested thousands of levels deep (lists in lists, quotes
// in quotes, emphasis in emphasis: a crafted file) makes the Markdown parser and
// the editor's coloring run out of stack, or take seconds. Such a note opens as
// plain text instead. Real notes are never nested that deep.

/** Nesting depth from which a note is shown as plain text. */
export const MAX_MARKDOWN_DEPTH = 300;

/**
 * An upper bound of how deep the Markdown of `text` can nest, read in one pass:
 * container blocks need marks at the start of a line (`>`, `-`, `1.`, spaces),
 * inline nesting needs marks (`*`, `_`, `[`, `~`, `` ` ``) within one paragraph.
 * When it is low, the note is safe without parsing it.
 */
export function markdownNestingBound(text: string): number {
  let bound = 0;
  let inline = 0;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    // The marks and spaces opening the line.
    let i = start;
    while (i < end && " \t>*+-0123456789.)".includes(text[i])) i++;
    let lead = i - start;
    if (i === end) {
      // A blank line ends the paragraph (a line of marks only counts as its own).
      inline = 0;
      lead = Math.min(lead, end - start);
    }
    for (let j = i; j < end; j++) {
      const c = text.charCodeAt(j);
      // * _ [ ~ `
      if (c === 42 || c === 95 || c === 91 || c === 126 || c === 96) inline++;
    }
    bound = Math.max(bound, lead, inline);
    start = end + 1;
  }
  return bound;
}

/** How deep a syntax tree goes (stops counting past `limit`), without recursion. */
export function treeDepth(cursor: { firstChild(): boolean; nextSibling(): boolean; parent(): boolean }, limit: number): number {
  let depth = 0;
  let max = 0;
  for (;;) {
    if (cursor.firstChild()) {
      depth++;
      if (depth > max) max = depth;
      if (max > limit) return max;
      continue;
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return max;
      depth--;
    }
  }
}
