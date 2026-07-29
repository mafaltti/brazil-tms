/** Business-rule conflicts (last-admin guard, duplicate email) → HTTP 409. */
export class Conflict extends Error {
  readonly status = 409;
  /**
   * Optional structured payload surfaced alongside the error code. Feature 006 uses it to carry the
   * eligibility `Finding[]` on `ASSIGNMENT_BLOCKED` / `OVERRIDE_REQUIRED` so the BFF can return the
   * conflicting findings to the client (`{ error: { code, message }, findings }`). The 2-arg
   * `new Conflict(code, message)` signature is unchanged — `details` defaults to `undefined`.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "Conflict";
  }
}

/** A missing resource (no row for the given id) → HTTP 404 (distinct from a 409 business conflict). */
export class NotFound extends Error {
  readonly status = 404;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NotFound";
  }
}
