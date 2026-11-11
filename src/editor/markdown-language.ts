// The Markdown language of the editor, loaded with the first Markdown note:
// GitHub's extensions, without embedded languages (HTML/CSS/JS): much lighter.

import { defineLanguageFacet, Language } from "@codemirror/language";
import { GFM, parser } from "@lezer/markdown";
import { MAX_MARKDOWN_DEPTH, markdownNestingBound, treeDepth } from "../text/markdown-guard";

const markdownParser = parser.configure(GFM);

export const markdownLanguage = new Language(
  defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } }),
  markdownParser,
  [],
  "markdown",
);

/**
 * True for Markdown nested deeper than real notes ever are (a crafted file):
 * parsing and coloring it would freeze the editor or run out of stack. Most
 * notes are cleared by a quick scan; the others are parsed once to measure.
 */
export function markdownTooDeep(text: string): boolean {
  if (markdownNestingBound(text) <= MAX_MARKDOWN_DEPTH) return false;
  try {
    return treeDepth(markdownParser.parse(text).cursor(), MAX_MARKDOWN_DEPTH) > MAX_MARKDOWN_DEPTH;
  } catch {
    return true; // (out of stack while parsing)
  }
}
