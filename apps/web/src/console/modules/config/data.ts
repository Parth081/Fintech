// Routing & Providers configuration data access: effective config and maker-checker change requests (Ops API),
// live breaker / outage state (gateway control view), provider catalogue and recent routing decisions.
import type { ChangeRequest, ConfigKey, ConfigValues, ControlView } from '@ct/contracts/browser';
import { apiGet, gatewayApi, opsApi, opsGet, opsPost, type Query } from '../../api';
import { samplesFromEvents, type RoutingSample } from './lib/config';

const enc = encodeURIComponent;

export interface EffectiveConfig {
  values: ConfigValues;
  versions: Partial<Record<ConfigKey, number>>;
  defaults?: ConfigValues;
}

export const configApi = {
  config: (signal?: AbortSignal) => opsGet<EffectiveConfig>('/config', { signal }),
  changes: (query: Query, signal?: AbortSignal) => opsApi.changes(query, signal),
  change: (id: string, signal?: AbortSignal) => opsGet<ChangeRequest>(`/changes/${enc(id)}`, { signal }),
  propose: <K extends ConfigKey>(key: K, proposedValue: unknown, reason: string) => opsPost<ChangeRequest>('/changes', { key, proposedValue, reason }, { permission: 'config.request' }),
  approve: (id: string, comment: string) => opsPost<ChangeRequest>(`/changes/${enc(id)}/approve`, { comment }, { permission: 'config.approve' }),
  reject: (id: string, comment: string) => opsPost<ChangeRequest>(`/changes/${enc(id)}/reject`, { comment }, { permission: 'config.approve' }),
  withdraw: (id: string) => opsPost<ChangeRequest>(`/changes/${enc(id)}/withdraw`, {}, { permission: 'config.request' }),
  control: (signal?: AbortSignal) => apiGet<ControlView>('/api/control/state', { signal }),
  providers: (signal?: AbortSignal) => gatewayApi.providers(signal),
  /** Recent routed payments with their recorded scoring (for the weights effect preview). */
  async routingSamples(n = 24, signal?: AbortSignal): Promise<RoutingSample[]> {
    const page = await gatewayApi.payments({ status: ['sent', 'settled', 'reconciled'], limit: n }, signal);
    const details = await Promise.all(
      page.items.map((p) =>
        gatewayApi
          .payment(p.paymentId, signal)
          .then((d) => ({ paymentId: p.paymentId, corridor: p.corridor, events: d.events as unknown as { type: string; payload: unknown }[] }))
          .catch(() => null),
      ),
    );
    return samplesFromEvents(details.filter((d): d is NonNullable<typeof d> => d !== null));
  },
};
