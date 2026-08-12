/**
 * Ingestion caps, shared by the server that enforces them and the UI that
 * states them. Kept in one place so the number a user is shown can't drift away
 * from the number that actually rejects their repository.
 */

export const MAX_FILES = 500
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024

export const MAX_TOTAL_MB = MAX_TOTAL_BYTES / (1024 * 1024)

/** One-line statement of the cap, for display before a repository is submitted. */
export const LIMITS_SUMMARY =
  `Up to ${MAX_FILES} files and ${MAX_TOTAL_MB} MB of indexable text. ` +
  'Repositories over the limit are rejected rather than partly indexed.'
