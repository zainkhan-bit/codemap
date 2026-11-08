/** Application-level error taxonomy mapped to stable CLI exit codes. */
export const ExitCodes = {
  OK: 0,
  PARTIAL: 1,
  INVALID_INPUT: 2,
  PATH_ERROR: 3,
  STORAGE_ERROR: 4,
  INTERNAL: 5,
  CANCELLED: 130,
} as const;

export type ErrorKind = "invalid_input" | "path" | "storage" | "internal" | "cancelled" | "not_found";

export class CodeMapError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly details: string[] = [],
    override readonly cause?: unknown,
  ) {
    super(message);
  }

  get exitCode(): number {
    switch (this.kind) {
      case "invalid_input":
      case "not_found":
        return ExitCodes.INVALID_INPUT;
      case "path":
        return ExitCodes.PATH_ERROR;
      case "storage":
        return ExitCodes.STORAGE_ERROR;
      case "cancelled":
        return ExitCodes.CANCELLED;
      default:
        return ExitCodes.INTERNAL;
    }
  }
}
