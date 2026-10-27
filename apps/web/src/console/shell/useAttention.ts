// Shell-wide polling of "what needs attention": overview counters + notification centre inputs.
import { useMemo } from 'react';
import type { CaseView, ChangeRequest, OpsOverview, ReconBreak } from '@ct/contracts/browser';
import { opsApi, type RefundRequest } from '../api';
import { buildNotices, type Notice } from '../lib/notifications';
import { useSession } from '../session';
import { useApi, useNow } from '../ui';

export interface Attention {
  overview: OpsOverview | null;
  notices: Notice[];
  loading: boolean;
  refresh(): void;
}

interface Snapshot {
  urgentCases?: CaseView[];
  pendingCases?: CaseView[];
  pendingChanges?: ChangeRequest[];
  pendingRefunds?: RefundRequest[];
  openBreaks?: ReconBreak[];
}

const settle = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);

export function useAttention(): Attention {
  const { can, user } = useSession();
  const now = useNow(30_000);
  const overview = useApi((s) => opsApi.overview(s), [user?.id], { intervalMs: 15_000, enabled: can('payments.read') });
  const permsKey = [can('alerts.read'), can('cases.approve'), can('config.approve'), can('payments.refund.approve'), can('recon.read')].join();
  const snap = useApi(
    async (signal): Promise<Snapshot> => {
      const [urgent, pending, changes, refunds, breaks] = await Promise.all([
        can('alerts.read') ? settle(opsApi.cases({ status: 'active', priority: 'critical,high', limit: 20 }, signal)) : undefined,
        can('cases.approve') ? settle(opsApi.cases({ status: 'pending_approval', limit: 20 }, signal)) : undefined,
        can('config.approve') ? settle(opsApi.changes({ status: 'pending' }, signal)) : undefined,
        can('payments.refund.approve') ? settle(opsApi.refunds({ status: 'pending' }, signal)) : undefined,
        can('recon.read') ? settle(opsApi.breaks({}, signal)) : undefined,
      ]);
      return { urgentCases: urgent?.items, pendingCases: pending?.items, pendingChanges: changes?.items, pendingRefunds: refunds?.items, openBreaks: breaks?.items };
    },
    [user?.id, permsKey],
    { intervalMs: 20_000 },
  );
  const notices = useMemo(
    () => (user && snap.data ? buildNotices({ userId: user.id, can, nowMs: now, ...snap.data }) : []),
    [user, snap.data, can, now],
  );
  return {
    overview: overview.data,
    notices,
    loading: overview.loading || snap.loading,
    refresh: () => {
      overview.refresh();
      snap.refresh();
    },
  };
}
