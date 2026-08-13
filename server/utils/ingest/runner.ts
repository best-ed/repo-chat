/**
 * One ingestion at a time, per process.
 *
 * Nitro keeps a single running instance per task name. A second
 * `runTask('ingest')` while one is running does not queue and does not throw —
 * it returns the first task's promise and discards the new payload entirely, so
 * the second job never runs at all and rests at QUEUED forever. Nothing rejects,
 * so no error handler can catch it.
 *
 * The slot has to be claimed rather than merely checked. Two requests can
 * interleave at any `await` between reading the state and starting the task, so
 * a check-then-act would let both through. Claiming is synchronous, which makes
 * it atomic on a single-threaded runtime: exactly one caller can hold the slot.
 *
 * Per process is the right scope because that is the scope of the limit being
 * modelled. Two serverless instances running an ingest each are genuinely
 * parallel and never collide.
 */

let held = false

/** Takes the slot, or reports that someone else holds it. */
export function claimIngestSlot(): boolean {
  if (held) return false
  held = true
  return true
}

/** Gives the slot back. Safe to call when it is not held. */
export function releaseIngestSlot(): void {
  held = false
}

/** Releases the slot once `run` settles, however it settles. */
export function holdIngestSlot<T>(run: Promise<T>): Promise<T> {
  return run.finally(releaseIngestSlot)
}
