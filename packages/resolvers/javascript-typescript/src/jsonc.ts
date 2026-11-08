/** Parses JSON with comments and trailing commas (tsconfig/jsconfig dialect). Never evaluates code. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  // Remove trailing commas before } or ] (outside strings, which were copied verbatim above).
  let cleaned = "";
  for (let k = 0; k < out.length; k++) {
    const ch = out[k]!;
    if (ch === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      cleaned += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (ch === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j]!)) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    cleaned += ch;
  }
  return JSON.parse(cleaned.replace(/^﻿/, ""));
}
