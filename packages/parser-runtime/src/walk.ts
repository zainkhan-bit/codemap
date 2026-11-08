import { DiagnosticCodes, type AdapterDiagnostic } from "@codemap/contracts";
import type { Node } from "web-tree-sitter";
import type { SourceText } from "./source-text.js";

/** Collapses whitespace and bounds a syntax summary. Never used to store whole bodies. */
export function summarize(text: string, max = 120): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Reports up to `limit` ERROR/MISSING nodes as recoverable-syntax diagnostics. */
export function collectSyntaxErrors(root: Node, src: SourceText, limit = 5): AdapterDiagnostic[] {
  if (!root.hasError) return [];
  const out: AdapterDiagnostic[] = [];
  const stack: Node[] = [root];
  let total = 0;
  while (stack.length) {
    const n = stack.pop()!;
    if (n.isError || n.isMissing) {
      total++;
      if (out.length < limit) {
        out.push({
          code: DiagnosticCodes.PARSE_RECOVERED,
          severity: "warning",
          message: n.isMissing ? `syntax error: missing ${n.type}` : "syntax error; extraction continued with recovered tree",
          span: src.span(n.startIndex, n.endIndex),
        });
      }
      continue;
    }
    if (!n.hasError) continue;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  if (total > limit) out.push({ code: DiagnosticCodes.PARSE_RECOVERED, severity: "info", message: `${total - limit} further syntax errors not listed` });
  return out;
}

/** Converts a dotted/member expression of identifiers into a chain; undefined when any part is computed. */
export function identifierChain(node: Node | null, memberType: string, objectField: string, propertyField: string, identTypes: ReadonlySet<string>): string[] | undefined {
  const parts: string[] = [];
  let cur: Node | null = node;
  for (let guard = 0; cur && guard < 64; guard++) {
    if (identTypes.has(cur.type)) {
      parts.unshift(cur.text);
      return parts;
    }
    if (cur.type !== memberType) return undefined;
    const prop = cur.childForFieldName(propertyField);
    if (!prop || !(identTypes.has(prop.type) || prop.type === "property_identifier" || prop.type === "private_property_identifier")) return undefined;
    parts.unshift(prop.text);
    cur = cur.childForFieldName(objectField);
  }
  return undefined;
}

/**
 * Summary for a callee that is not a plain identifier chain, e.g. `open(path).write` → "(…).write".
 * Never echoes the receiver expression, which may contain string literals or other source content.
 */
export function computedCalleeSummary(callee: Node, memberType: string, propertyField: string): string {
  if (callee.type === memberType) {
    const prop = callee.childForFieldName(propertyField);
    if (prop && /^[\p{L}_$#][\p{L}\p{N}_$]*$/u.test(prop.text)) return `(…).${prop.text}`;
  }
  return `<${callee.type}>`;
}
