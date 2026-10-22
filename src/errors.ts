/** Thrown when a called feature has no implementation. Never substitute a verdict. */
export class NotImplementedError extends Error {
  readonly code = "NOT_IMPLEMENTED" as const;

  constructor(feature: string) {
    super(`NotImplementedError: ${feature}`);
    this.name = "NotImplementedError";
  }
}
