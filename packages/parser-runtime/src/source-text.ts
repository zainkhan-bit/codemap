import type { SourceSpan } from "@codemap/contracts";

/**
 * Decoded source text plus exact position mapping.
 *
 * web-tree-sitter indexes JavaScript strings in UTF-16 code units. CodeMap spans
 * use UTF-8 byte offsets and one-based UTF-16 columns, so we precompute a
 * UTF-16-index → UTF-8-offset table and line starts.
 */
export class SourceText {
  readonly text: string;
  /** False when the bytes were not valid UTF-8; byte offsets are then approximate. */
  readonly exact: boolean;
  private readonly byteAt: Uint32Array;
  private readonly lineStarts: number[];

  constructor(bytes: Uint8Array) {
    // ignoreBOM keeps a BOM as U+FEFF so offsets stay aligned with the original bytes.
    this.text = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(bytes);
    const len = this.text.length;
    this.byteAt = new Uint32Array(len + 1);
    this.lineStarts = [0];
    let bytePos = 0;
    for (let i = 0; i < len; i++) {
      this.byteAt[i] = bytePos;
      const c = this.text.charCodeAt(i);
      if (c < 0x80) bytePos += 1;
      else if (c < 0x800) bytePos += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
        const d = this.text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          bytePos += 4;
          this.byteAt[++i] = bytePos; // low surrogate maps to the end of the pair; never a span boundary in practice
          if (c === 0x0a) this.lineStarts.push(i + 1);
          continue;
        }
        bytePos += 3;
      } else bytePos += 3;
      if (c === 0x0a) this.lineStarts.push(i + 1);
    }
    this.byteAt[len] = bytePos;
    this.exact = bytePos === bytes.length;
  }

  get length(): number {
    return this.text.length;
  }

  byteOffset(utf16Index: number): number {
    return this.byteAt[Math.max(0, Math.min(utf16Index, this.text.length))]!;
  }

  /** One-based line and one-based UTF-16 column for a UTF-16 index. */
  position(utf16Index: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= utf16Index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: utf16Index - this.lineStarts[lo]! + 1 };
  }

  span(startIndex: number, endIndex: number): SourceSpan {
    const s = this.position(startIndex);
    const e = this.position(endIndex);
    return {
      startByte: this.byteOffset(startIndex),
      endByte: this.byteOffset(endIndex),
      startLine: s.line,
      startColumn: s.column,
      endLine: e.line,
      endColumn: e.column,
    };
  }
}
