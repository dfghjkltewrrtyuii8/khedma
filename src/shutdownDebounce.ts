// Decides what a Ctrl+C/SIGINT should do, given shutdown state and timing.
// Pulled out as a pure function so this logic — which exists specifically to
// stop an accidental double Ctrl+C (key-repeat, an impatient double press)
// from force-quitting mid-shutdown and stranding real positions that were
// only given one chance to close — is covered by the test suite rather than
// only ever exercised live, with real money, during an actual shutdown.

export type ShutdownDecision = 'begin' | 'already-quitting' | 'force-quit';

export function decideShutdown(shutdownStartedAt: number | null, now: number, debounceMs: number): ShutdownDecision {
  if (shutdownStartedAt === null) return 'begin';
  return now - shutdownStartedAt < debounceMs ? 'already-quitting' : 'force-quit';
}
