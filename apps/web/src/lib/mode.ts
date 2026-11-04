// M6 pure logic: system mode (live / recorded backup run), launcher service health, safe-mode switch.
import type { RecordingMeta, ServiceHealthView, SystemMode } from '@ct/contracts/browser';
import type { Health } from './types';

export const RIBBON_TEXT = 'RECORDED RUN · not live';
export const KIOSK_PAUSED_TITLE = 'The live demo is taking a short break.';
export const KIOSK_PAUSED_TEXT = 'Watch the big screen!';
export const SAFE_CONFIRM_ON = 'Switch the big screen to the recorded backup run? Live payments stop; visitor leads are kept.';
export const SAFE_CONFIRM_OFF = 'Go back to the live demo? This starts a fresh live system, like a reset; visitor leads are kept.';

export interface ModeInfo {
  mode: SystemMode;
  recording: string | null;
  safe: boolean;
}

/** Mode from a control view, health body or anything that carries { mode, recording }. Missing = live. */
export function modeInfo(src: { mode?: unknown; recording?: unknown } | null | undefined): ModeInfo {
  const safe = src?.mode === 'safe';
  const recording = safe && typeof src?.recording === 'string' && src.recording !== '' ? src.recording : null;
  return { mode: safe ? 'safe' : 'live', recording, safe };
}

/** Ribbon subtitle: which recording plays. */
export function ribbonDetail(info: ModeInfo): string {
  return info.recording ? `Playing “${info.recording}”` : 'Playing the recorded backup run';
}

export interface LauncherStatusView {
  mode: SystemMode;
  recording: string | null;
  services: ServiceHealthView[];
}

/** Defensive parse of GET /api/control/status. null when it is not a launcher status. */
export function parseLauncherStatus(raw: unknown): LauncherStatusView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.services)) return null;
  const services: ServiceHealthView[] = [];
  for (const s of o.services) {
    if (typeof s !== 'object' || s === null) continue;
    const x = s as Record<string, unknown>;
    if (typeof x.name !== 'string') continue;
    services.push({
      name: x.name,
      running: x.running === true,
      restarts: typeof x.restarts === 'number' ? x.restarts : 0,
      lastRestartAt: typeof x.lastRestartAt === 'string' ? x.lastRestartAt : null,
      lastExit: (x.lastExit as ServiceHealthView['lastExit']) ?? null,
    });
  }
  const m = modeInfo(o);
  return { mode: m.mode, recording: m.recording, services };
}

export type HealthTone = 'ok' | 'warn' | 'bad';

export interface HealthRow {
  name: string;
  tone: HealthTone;
  label: string;
}

/** One row per service: Running / Running (restarted N×) / Down. */
export function healthRows(status: LauncherStatusView | null): HealthRow[] {
  return (status?.services ?? []).map((s) => {
    if (!s.running) return { name: s.name, tone: 'bad', label: 'Down' };
    if (s.restarts > 0) return { name: s.name, tone: 'warn', label: `Running · restarted ${s.restarts}×` };
    return { name: s.name, tone: 'ok', label: 'Running' };
  });
}

export function healthSummary(rows: readonly HealthRow[]): { tone: HealthTone; text: string } {
  if (rows.length === 0) return { tone: 'warn', text: 'No status' };
  const down = rows.filter((r) => r.tone === 'bad').length;
  if (down > 0) return { tone: 'bad', text: `${down} service${down === 1 ? '' : 's'} down` };
  const restarted = rows.filter((r) => r.tone === 'warn').length;
  if (restarted > 0) return { tone: 'warn', text: `All running · ${restarted} restarted` };
  return { tone: 'ok', text: 'All services running' };
}

/** Newest recording first (for display); the launcher plays the newest by default. */
export function newestOf(list: readonly RecordingMeta[]): RecordingMeta | undefined {
  return [...list].sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
}

/**
 * Is the system back in the wanted mode after a switch? The health body must be replayed AND report the
 * target mode (an old gateway still answering in the previous mode does not count).
 */
export function modeSwitchReady(health: Health | null, target: SystemMode): boolean {
  return health !== null && health.replayed && modeInfo(health).mode === target;
}

/** Services that must answer before a switch counts as done (safe mode has no ledger / orchestrator). */
export function requiredAfterSwitch(target: SystemMode): readonly ('ledger' | 'orchestrator')[] {
  return target === 'safe' ? [] : ['ledger', 'orchestrator'];
}
