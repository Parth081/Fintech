// M6 (show-ready): self-healing supervision, recorded backup run ("safe mode"), preflight checks.
// Shared by the launcher, the gateway, the presenter console and the verification tools.

/** The system runs live, or plays a recorded backup run of a scenario (nothing live behind it). */
export type SystemMode = 'live' | 'safe';

/** Crash-restart policy of the launcher's supervisor. Services are restarted with exponential backoff. */
export interface SupervisorPolicy {
  /** Restart crashed services (default true for `npm start`; tests that expect a crash to stop everything opt out). */
  enabled: boolean;
  /** Give up on a service after this many restarts inside `windowMs` (then stop everything as before). */
  maxRestarts: number;
  windowMs: number;
  /** First delay; doubles per consecutive crash up to maxBackoffMs. */
  backoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  enabled: true,
  maxRestarts: 5,
  windowMs: 120_000,
  backoffMs: 500,
  maxBackoffMs: 8_000,
};

export interface ServiceHealthView {
  name: string;
  running: boolean;
  /** Restarts by the supervisor since the system started (a demo reset does not count). */
  restarts: number;
  lastRestartAt: string | null;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
}

/** Metadata stored next to a recording (`<dataDir>/recordings/<name>.meta.json`). */
export interface RecordingMeta {
  name: string;
  recordedAt: string; // ISO
  scenarioId: string | null; // scenario that was running, if any
  eventCount: number;
  /** First and last occurredAt in the recording (ISO). Playback shifts all timestamps by (start of playback - first). */
  firstOccurredAt: string;
  lastOccurredAt: string;
  durationMs: number;
  /** Format version of the .jsonl file (one BusEvent JSON object per line, in log order). */
  format: 1;
}

/**
 * Launcher control API additions (http://127.0.0.1:7079, only when started by the launcher):
 *   GET  /status                 -> { ...existing, mode: SystemMode, services: ServiceHealthView[], recording: string | null }
 *   POST /safe-mode {on, name?}  -> { ok, mode, recording, durationMs }
 *        on=true : stop the live pipeline and start the SAFE system: broker + gateway (+ assistant, booth) with the
 *                  named recording (default: the newest) played into a fresh log with original timing, looped.
 *                  Visitor leads (DATA_DIR/booth) are preserved. Payment sending is disabled (the kiosk shows "demo
 *                  paused"); every screen keeps working from the recorded events.
 *        on=false: back to a fresh live system (like a reset).
 *   409 while a reset or mode change is running; 404 when the named recording does not exist.
 * Gateway: GET /health and GET /api/control/state expose { mode, recording } so every screen can show
 * "RECORDED RUN" and the kiosk can disable "Send".
 * CLI:
 *   npm run booth:record -- --name <n> [--scenario provider-outage] [--duration 90]   record a run
 *   npm run booth:replay -- --name <n>                                                  start the safe system directly
 *   npm run booth:preflight                                                             readiness check of this laptop
 */
export const SHOW_API_DOC = true;
