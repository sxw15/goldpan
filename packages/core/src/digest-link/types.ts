export interface SharePayload {
  v: 1;
  did: number;
  exp: number;
  /** Optional render preset id. Used when a link points at a channel-level row. */
  pid?: number;
}
