// Document types: which syntax coloring a file gets, from its name.
// Code languages use the CodeMirror "legacy" stream modes, loaded on demand
// (a separate chunk each): the start-up stays as light as before.

import type { StreamParser } from "@codemirror/language";
import { basename, extname, isProbablyBinary } from "../core/path";

/** What a file is, for its icon and for the note features (tasks, tags…). */
export type FileKind = "text" | "markdown" | "json" | "code" | "config" | "markup";

export interface LanguageInfo {
  id: string;
  label: string;
  kind: FileKind;
  /** Extensions, lowercase, without the dot. */
  exts: string[];
  /** Exact file names, lowercase (Dockerfile, .bashrc…). */
  names?: string[];
  load?: () => Promise<StreamParser<unknown>>;
}

type Parser = StreamParser<unknown>;

const BATCH_KEYWORDS = new Set(
  "if else for in do goto call exit set setlocal endlocal echo not exist defined errorlevel equ neq lss leq gtr geq shift pause start cd chdir pushd popd title cls copy del move mkdir rmdir ren type choice timeout".split(" "),
);

/** Windows batch files (.bat, .cmd): no legacy mode exists for them. */
const batch: Parser = {
  name: "batch",
  token(stream) {
    if (stream.sol()) {
      stream.eatSpace();
      if (stream.match(/^(?:rem\b|::)/i)) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match(/^:[\w.-]+/)) return "labelName";
      if (stream.eat("@")) return "meta";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^%%~?[a-z]|^%~?[\w]+%?|^![\w]+!/i)) return "variableName.special";
    if (stream.match(/^"[^"]*"?/)) return "string";
    if (stream.match(/^[<>|&]+/)) return "operator";
    if (stream.match(/^\d+\b/)) return "number";
    if (stream.match(/^[\w.-]+/)) return BATCH_KEYWORDS.has(stream.current().toLowerCase()) ? "keyword" : null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "REM " } },
};

export const LANGUAGES: LanguageInfo[] = [
  { id: "text", label: "Text", kind: "text", exts: [] },
  { id: "markdown", label: "Markdown", kind: "markdown", exts: ["md", "markdown", "mdx"] },
  { id: "jsonc", label: "JSON", kind: "json", exts: ["json", "jsonc", "json5", "geojson", "webmanifest", "code-workspace"], names: [".prettierrc", ".eslintrc", ".babelrc"] },
  { id: "javascript", label: "JavaScript", kind: "code", exts: ["js", "mjs", "cjs", "jsx"], load: () => import("@codemirror/legacy-modes/mode/javascript").then((m) => m.javascript as Parser) },
  { id: "typescript", label: "TypeScript", kind: "code", exts: ["ts", "mts", "cts", "tsx"], load: () => import("@codemirror/legacy-modes/mode/javascript").then((m) => m.typescript as Parser) },
  { id: "python", label: "Python", kind: "code", exts: ["py", "pyw", "pyi"], load: () => import("@codemirror/legacy-modes/mode/python").then((m) => m.python as Parser) },
  { id: "shell", label: "Shell", kind: "code", exts: ["sh", "bash", "zsh", "ksh"], names: [".bashrc", ".zshrc", ".profile", ".bash_profile", ".bash_aliases"], load: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell as Parser) },
  { id: "powershell", label: "PowerShell", kind: "code", exts: ["ps1", "psm1", "psd1"], load: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell as Parser) },
  { id: "batch", label: "Batch", kind: "code", exts: ["bat", "cmd"], load: async () => batch },
  { id: "sql", label: "SQL", kind: "code", exts: ["sql"], load: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.standardSQL as Parser) },
  { id: "html", label: "HTML", kind: "markup", exts: ["html", "htm", "xhtml"], load: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.html as Parser) },
  { id: "xml", label: "XML", kind: "markup", exts: ["xml", "xsd", "xsl", "xslt", "svg", "plist", "csproj", "vbproj", "fsproj", "props", "targets", "resx", "xaml", "config", "nuspec", "wsdl", "rss", "atom", "pom"], load: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml as Parser) },
  { id: "css", label: "CSS", kind: "code", exts: ["css"], load: () => import("@codemirror/legacy-modes/mode/css").then((m) => m.css as Parser) },
  { id: "scss", label: "SCSS", kind: "code", exts: ["scss"], load: () => import("@codemirror/legacy-modes/mode/css").then((m) => m.sCSS as Parser) },
  { id: "less", label: "Less", kind: "code", exts: ["less"], load: () => import("@codemirror/legacy-modes/mode/css").then((m) => m.less as Parser) },
  { id: "yaml", label: "YAML", kind: "config", exts: ["yml", "yaml"], load: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml as Parser) },
  { id: "toml", label: "TOML", kind: "config", exts: ["toml"], load: () => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml as Parser) },
  { id: "ini", label: "INI / Properties", kind: "config", exts: ["ini", "cfg", "conf", "properties", "env", "inf", "editorconfig", "gitconfig"], names: [".env", ".editorconfig", ".gitconfig", ".npmrc", ".gitattributes"], load: () => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties as Parser) },
  { id: "dockerfile", label: "Dockerfile", kind: "config", exts: ["dockerfile"], names: ["dockerfile", "containerfile"], load: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile as Parser) },
  { id: "nginx", label: "Nginx", kind: "config", exts: [], names: ["nginx.conf"], load: () => import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx as Parser) },
  { id: "diff", label: "Diff", kind: "code", exts: ["diff", "patch"], load: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff as Parser) },
  { id: "c", label: "C", kind: "code", exts: ["c", "h"], load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c as Parser) },
  { id: "cpp", label: "C++", kind: "code", exts: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp as Parser) },
  { id: "csharp", label: "C#", kind: "code", exts: ["cs", "csx"], load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp as Parser) },
  { id: "java", label: "Java", kind: "code", exts: ["java"], load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.java as Parser) },
  { id: "kotlin", label: "Kotlin", kind: "code", exts: ["kt", "kts"], load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin as Parser) },
  { id: "scala", label: "Scala", kind: "code", exts: ["scala", "sc"], load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala as Parser) },
  { id: "dart", label: "Dart", kind: "code", exts: ["dart"], load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart as Parser) },
  { id: "go", label: "Go", kind: "code", exts: ["go"], load: () => import("@codemirror/legacy-modes/mode/go").then((m) => m.go as Parser) },
  { id: "rust", label: "Rust", kind: "code", exts: ["rs"], load: () => import("@codemirror/legacy-modes/mode/rust").then((m) => m.rust as Parser) },
  { id: "swift", label: "Swift", kind: "code", exts: ["swift"], load: () => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift as Parser) },
  { id: "lua", label: "Lua", kind: "code", exts: ["lua"], load: () => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua as Parser) },
  { id: "ruby", label: "Ruby", kind: "code", exts: ["rb", "rake", "gemspec"], names: ["gemfile", "rakefile"], load: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby as Parser) },
  { id: "perl", label: "Perl", kind: "code", exts: ["pl", "pm"], load: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl as Parser) },
  { id: "r", label: "R", kind: "code", exts: ["r"], load: () => import("@codemirror/legacy-modes/mode/r").then((m) => m.r as Parser) },
  { id: "groovy", label: "Groovy", kind: "code", exts: ["groovy", "gradle"], load: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy as Parser) },
  { id: "vb", label: "Visual Basic", kind: "code", exts: ["vb", "bas"], load: () => import("@codemirror/legacy-modes/mode/vb").then((m) => m.vb as Parser) },
  { id: "vbscript", label: "VBScript", kind: "code", exts: ["vbs"], load: () => import("@codemirror/legacy-modes/mode/vbscript").then((m) => m.vbScript as Parser) },
  { id: "protobuf", label: "Protocol Buffers", kind: "code", exts: ["proto"], load: () => import("@codemirror/legacy-modes/mode/protobuf").then((m) => m.protobuf as Parser) },
  { id: "cmake", label: "CMake", kind: "config", exts: ["cmake"], names: ["cmakelists.txt"], load: () => import("@codemirror/legacy-modes/mode/cmake").then((m) => m.cmake as Parser) },
  { id: "latex", label: "LaTeX", kind: "markup", exts: ["tex", "sty", "bib"], load: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex as Parser) },
];

const byId = new Map(LANGUAGES.map((l) => [l.id, l]));
const byExt = new Map<string, LanguageInfo>();
const byName = new Map<string, LanguageInfo>();
for (const l of LANGUAGES) {
  for (const e of l.exts) byExt.set(e, l);
  for (const n of l.names ?? []) byName.set(n, l);
}

export const isLangId = (id: unknown): id is string => typeof id === "string" && byId.has(id);
export const languageInfo = (id: string): LanguageInfo => byId.get(id) ?? byId.get("text")!;
export const languageLabel = (id: string) => languageInfo(id).label;

/** The document type of a file (by name, then by extension); text when unknown. */
export function languageForPath(path: string): string {
  return (byName.get(basename(path).toLowerCase()) ?? byExt.get(extname(path)))?.id ?? "text";
}

/**
 * Code and data files: no note features there (a "#include" is not a tag,
 * "@Override" is not a mention, "x - done" is not a task).
 */
export const isCodeLang = (id: string) => !["text", "markdown"].includes(languageInfo(id).kind);

const IMAGE_EXT = new Set("png jpg jpeg gif bmp ico icns webp avif tiff svgz psd".split(" "));

/** Icon of a file in the explorer: its kind, plus images and binaries. */
export function fileKindFor(path: string): FileKind | "image" | "binary" {
  const ext = extname(path);
  if (IMAGE_EXT.has(ext)) return "image";
  if (isProbablyBinary(path)) return "binary";
  return languageInfo(languageForPath(path)).kind;
}
