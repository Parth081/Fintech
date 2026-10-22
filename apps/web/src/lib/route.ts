// Hash routes: #/live (default), #/ledger, #/fx, #/providers. Hash routing needs nothing from the gateway's static serving.
export const VIEWS = ['live', 'ledger', 'fx', 'providers'] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<View, string> = { live: 'Live', ledger: 'Ledger', fx: 'FX', providers: 'Providers' };

export function parseHash(hash: string): View {
  const name = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : 'live';
}

export function hashFor(view: View): string {
  return `#/${view}`;
}
