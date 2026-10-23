// Hash routes: #/stage (default once the main stage exists), #/live, #/ledger, #/fx, #/providers,
// and #/presenter (the presenter's tablet; not in the audience nav). Hash routing needs nothing
// from the gateway's static serving.
export const VIEWS = ['stage', 'live', 'ledger', 'fx', 'providers', 'presenter'] as const;
export type View = (typeof VIEWS)[number];

/** Views shown in the audience header nav (in order). */
export const NAV_VIEWS: readonly View[] = ['stage', 'live', 'ledger', 'fx', 'providers'];

export const VIEW_LABELS: Record<View, string> = {
  stage: 'Stage',
  live: 'Live',
  ledger: 'Ledger',
  fx: 'FX',
  providers: 'Providers',
  presenter: 'Presenter',
};

export function parseHash(hash: string, fallback: View = 'live'): View {
  const name = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : fallback;
}

export function hashFor(view: View): string {
  return `#/${view}`;
}
