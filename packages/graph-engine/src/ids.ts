/**
 * Deterministic graph identifiers.
 *
 * id = <prefix>_<first 32 hex chars of SHA-256(identity)>. 128 bits makes accidental
 * collisions negligible; IdRegistry still verifies the full identity string so a
 * collision is reported (GRAPH002) instead of silently merging entities.
 */
import { createHash } from "node:crypto";

export const ID_VERSION = "v1";
const DIGEST_CHARS = 32;

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function makeId(prefix: string, parts: readonly (string | number)[]): { id: string; identity: string } {
  // Each part is length-prefixed so that ("a|b","c") and ("a","b|c") cannot collide.
  const identity = [ID_VERSION, ...parts].map((p) => `${String(p).length}:${p}`).join("|");
  return { id: `${prefix}_${sha256Hex(identity).slice(0, DIGEST_CHARS)}`, identity };
}

export const Ids = {
  project: (projectIdentity: string) => makeId("prj", ["project", projectIdentity]),
  directory: (path: string) => makeId("dir", ["directory", path]),
  file: (path: string) => makeId("fil", ["file", path]),
  module: (path: string, name: string) => makeId("mod", ["module", path, name]),
  package: (ecosystem: string, name: string) => makeId("pkg", ["package", ecosystem, name]),
  symbol: (path: string, symbolKind: string, qualifiedName: string, signatureFingerprint: string, ordinal: number) =>
    makeId("sym", ["symbol", path, symbolKind, qualifiedName, signatureFingerprint, ordinal]),
  edge: (kind: string, sourceId: string, targetId: string) => makeId("edg", ["edge", kind, sourceId, targetId]),
  reference: (kind: string, path: string, startByte: number, endByte: number, payload: string) =>
    makeId("ref", ["reference", kind, path, startByte, endByte, payload]),
  diagnostic: (code: string, path: string, startByte: number, message: string) => makeId("dgn", ["diagnostic", code, path, startByte, message]),
};

export class IdCollisionError extends Error {
  constructor(
    readonly id: string,
    readonly first: string,
    readonly second: string,
  ) {
    super(`identifier collision for ${id}`);
  }
}

/** Tracks issued IDs and verifies that equal IDs always come from equal identities. */
export class IdRegistry {
  private readonly identities = new Map<string, string>();

  /** Registers an ID; returns false when it was already registered with the same identity. */
  register(entry: { id: string; identity: string }): boolean {
    const existing = this.identities.get(entry.id);
    if (existing === undefined) {
      this.identities.set(entry.id, entry.identity);
      return true;
    }
    if (existing !== entry.identity) throw new IdCollisionError(entry.id, existing, entry.identity);
    return false;
  }

  has(id: string): boolean {
    return this.identities.has(id);
  }
}
