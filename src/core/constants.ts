// Every number the specification fixes, in one place.
//
// The event kinds are PROVISIONAL (spec §11.4): chosen from the ephemeral range and
// checked free of collision, but not reserved by a NIP. They live here and nowhere
// else so that a change is a one-line change.

export const KINDS = {
  SEAL: 13,
  WRAP: 1059,
  AUTH: 22242,
  HELLO: 24401,
  REQUEST: 24402,
  NONCE: 24403,
  REVEAL: 24404,
  PAYLOAD: 24405,
  ACK: 24406,
  ABORT: 24407,
} as const;

/** Protocol version carried in the QR as `v=1` and hashed as a single byte (§6). */
export const VERSION = 1;

/** A session lives ten minutes (§2). */
export const SESSION_SECONDS = 600;

/** Tolerance at each end of the session window, in seconds. Normative (§11.4). */
export const SLACK_SECONDS = 120;

/** The Sender zeroizes its burner on ACK or after this long (§7 step 18, §8 step 18). */
export const ACK_WAIT_SECONDS = 60;

/** Code-entry attempts per session (§9.2). */
export const MAX_ATTEMPTS = 5;

/** Candidates a Receiver that showed the QR holds at once (§13). */
export const MAX_HELD = 3;

/** Requests a Sender that showed the QR queues at once (§8). */
export const MAX_PENDING = 5;

/** Default maximum payload, in bytes of binary (§4, P1). */
export const DEFAULT_MAX_PAYLOAD = 2048;

/** A Sender remembers peer burners it failed a code against for at least this long (§9.3). */
export const THROTTLE_SECONDS = 3600;

/** Failed sessions within THROTTLE_SECONDS before the interference warning (§9.3). */
export const FAILED_SESSIONS_BEFORE_WARNING = 3;

/** Relays a QR may name (§11.2). */
export const MAX_RELAYS = 4;

export const PROFILE_ID = /^[a-z0-9-]{1,24}$/;
