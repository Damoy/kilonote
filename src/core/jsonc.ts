// JSON avec commentaires (// et /* */) et virgules finales, comme Sublime Text.

export function stripJsonComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function parseJsonc<T = unknown>(src: string): T {
  const cleaned = stripJsonComments(src).replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned.trim() || "{}") as T;
}
