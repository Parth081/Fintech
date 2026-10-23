// Reset notice for the main stage (pure). The gateway broadcasts {kind:'reset'} when the presenter
// resets the demo; the stage dims, says "Resetting the demo…", and recovers on the first snapshot
// from the restarted gateway. A failed reset, or one that never completes, drops the notice.

export type StageResetState =
  | { phase: 'idle' }
  | { phase: 'resetting'; sinceMs: number }
  /** Back after a reset: a short, calm confirmation. */
  | { phase: 'back'; sinceMs: number };

export type StageResetEvent =
  | { type: 'reset'; failed: boolean; nowMs: number }
  | { type: 'snapshot'; nowMs: number }
  | { type: 'tick'; nowMs: number };

/** Give up on a reset that never completes (the gateway never went away). */
export const RESET_GIVE_UP_MS = 45_000;
/** How long "Back" stays up. */
export const BACK_MS = 3_500;

export const RESET_IDLE: StageResetState = { phase: 'idle' };

export function stageResetReducer(state: StageResetState, ev: StageResetEvent): StageResetState {
  switch (ev.type) {
    case 'reset':
      if (ev.failed) return RESET_IDLE;
      return state.phase === 'resetting' ? state : { phase: 'resetting', sinceMs: ev.nowMs };
    case 'snapshot':
      return state.phase === 'resetting' ? { phase: 'back', sinceMs: ev.nowMs } : state;
    case 'tick':
      if (state.phase === 'resetting' && ev.nowMs - state.sinceMs > RESET_GIVE_UP_MS) return RESET_IDLE;
      if (state.phase === 'back' && ev.nowMs - state.sinceMs > BACK_MS) return RESET_IDLE;
      return state;
    default:
      return state;
  }
}
