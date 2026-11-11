// The Markdown language of the editor, loaded with the first Markdown note:
// GitHub's extensions, without embedded languages (HTML/CSS/JS): much lighter.

import { defineLanguageFacet, Language } from "@codemirror/language";
import { GFM, parser } from "@lezer/markdown";

export const markdownLanguage = new Language(
  defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } }),
  parser.configure(GFM),
  [],
  "markdown",
);
