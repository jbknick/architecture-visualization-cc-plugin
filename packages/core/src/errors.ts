/** The codes `GantryError` carries. The `team_*` codes come from talking to a team server (spec section 20). */
export type GantryErrorCode =
  | "team_config"
  | "team_unauthorized"
  | "team_forbidden"
  | "team_unreachable"
  | "team_protocol"
  | "team_rejected";

/** An error with a stable `code`, so a command can print one line that names it and choose its advice. */
export class GantryError extends Error {
  constructor(
    readonly code: GantryErrorCode,
    message: string,
    /** For an error the server answered: the HTTP status and the protocol `error` code (`conflict`, `budget`, ...). */
    readonly answer?: { status: number; error?: string },
  ) {
    super(message);
    this.name = "GantryError";
  }
}
