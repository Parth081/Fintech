// Breaker state -> how a provider hub, its routes, its panel row and the map alert look. Pure.
import type { BreakerView, ProviderOutage } from '@ct/contracts/browser';

export type HubTone = 'closed' | 'open' | 'half-open' | 'failing' | 'recovered' | 'unknown';

export interface HubStyle {
  tone: HubTone;
  /** Big status word(s) on the map and in the panel ('' = nothing to say). */
  label: string;
  /** Smaller explanation (breaker reason, outage reason). */
  detail: string;
  /** CSS colour for the hub ring and label. */
  color: string;
  /** Routes are greyed out and carry no traffic. */
  routesMuted: boolean;
  /** Draw attention (pulsing ring). */
  alert: boolean;
}

/** Provider colours (CSS variables defined in stage.css; distinct from ok/warn/bad). */
export const PROVIDER_COLOR: Readonly<Record<string, string>> = {
  orion: 'var(--ms-orion)',
  lyra: 'var(--ms-lyra)',
  vega: 'var(--ms-vega)',
};

export function providerColor(providerId: string): string {
  return PROVIDER_COLOR[providerId] ?? 'var(--accent)';
}

/** How long a breaker that closed again is shown as "RECOVERED". */
export const RECOVERED_MS = 12_000;

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * `breaker` undefined means the breaker is unknown (control API missing or provider not listed);
 * the hub then shows plain provider colours and no status. `outage` is the injected fault, if any:
 * it shows while the breaker is still closed (failures are being seen, it has not tripped yet).
 * A closed breaker whose `since` is recent (it was open/half-open before) shows RECOVERED briefly.
 */
export function hubStyle(providerId: string, breaker: BreakerView | undefined, outage?: ProviderOutage, nowMs = Date.now()): HubStyle {
  const base = providerColor(providerId);
  if (breaker?.state === 'open') {
    return { tone: 'open', label: 'CIRCUIT OPEN', detail: breaker.reason || 'Traffic re-routed', color: 'var(--bad)', routesMuted: true, alert: true };
  }
  if (breaker?.state === 'half-open') {
    return { tone: 'half-open', label: 'HALF-OPEN · PROBING', detail: breaker.reason || 'Testing with a few payments', color: 'var(--warn)', routesMuted: false, alert: true };
  }
  if (outage) {
    const what = outage.mode === 'down' ? 'Rejecting payments' : `Degraded${outage.failureRate !== undefined ? ` · ${pct(outage.failureRate)} failing` : ''}`;
    return { tone: 'failing', label: 'FAILING', detail: what, color: 'var(--bad)', routesMuted: false, alert: true };
  }
  if (breaker?.state === 'closed') {
    const since = breaker.since ? Date.parse(breaker.since) : Number.NaN;
    if (Number.isFinite(since) && nowMs - since >= 0 && nowMs - since < RECOVERED_MS) {
      return { tone: 'recovered', label: 'RECOVERED', detail: 'Circuit closed · taking traffic again', color: 'var(--ok)', routesMuted: false, alert: false };
    }
    const detail = breaker.attempts > 0 ? `${pct(1 - breaker.failureRate)} success · ${breaker.attempts} recent` : 'Circuit closed';
    return { tone: 'closed', label: 'HEALTHY', detail, color: base, routesMuted: false, alert: false };
  }
  return { tone: 'unknown', label: '', detail: '', color: base, routesMuted: false, alert: false };
}

/** Breakers by provider id. */
export function breakerMap(breakers: readonly BreakerView[] | undefined): Map<string, BreakerView> {
  return new Map((breakers ?? []).map((b) => [b.providerId, b]));
}

export interface StageAlert {
  tone: 'open' | 'failing' | 'half-open' | 'recovered';
  providerId: string;
  /** Big line, e.g. "ORION · CIRCUIT OPEN". */
  headline: string;
  /** What it means, e.g. "Traffic re-routed to Lyra and Vega". */
  sub: string;
}

const PRIORITY: readonly StageAlert['tone'][] = ['open', 'failing', 'half-open', 'recovered'];

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The one message the map shouts (null when all is well). `providers` is the display order with
 * short names; the most serious state wins (open > failing > half-open > recovered).
 */
export function stageAlert(
  styles: Readonly<Record<string, HubStyle>>,
  providers: readonly { id: string; name: string }[],
  /** Recent traffic share per provider: when known, only providers actually taking traffic are named. */
  shares?: Readonly<Record<string, number>>,
): StageAlert | null {
  for (const tone of PRIORITY) {
    const hit = providers.find((p) => styles[p.id]?.tone === tone);
    if (!hit) continue;
    const healthy = providers.filter((p) => p.id !== hit.id && styles[p.id]?.tone !== 'open' && styles[p.id]?.tone !== 'failing');
    const busy = shares ? healthy.filter((p) => (shares[p.id] ?? 0) > 0) : [];
    const others = (busy.length ? busy : healthy).map((p) => p.name);
    const name = hit.name.toUpperCase();
    switch (tone) {
      case 'open':
        return { tone, providerId: hit.id, headline: `${name} · CIRCUIT OPEN`, sub: others.length ? `Traffic re-routed to ${joinNames(others)}` : 'Traffic held until a provider recovers' };
      case 'failing':
        return { tone, providerId: hit.id, headline: `${name} IS FAILING`, sub: 'Rejected payments are retried on another provider' };
      case 'half-open':
        return { tone, providerId: hit.id, headline: `${name} · HALF-OPEN`, sub: 'Testing recovery with a few probe payments' };
      default:
        return { tone, providerId: hit.id, headline: `${name} RECOVERED`, sub: 'Circuit closed · winning its traffic back' };
    }
  }
  return null;
}
