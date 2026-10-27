// Treasury & Reconciliation module root: #/console/treasury (overview), /treasury/breaks[/:id], /treasury/statements.
import { useSession } from '../../session';
import { links, useConsoleRoute } from '../../route';
import { useApi, useNow } from '../../ui/hooks';
import { treasuryApi } from './data';
import OverviewTab from './OverviewTab';
import BreaksTab from './BreaksTab';
import StatementsTab from './StatementsTab';
import { Button, PageHeader, Tabs, ToastHost } from '../risk/kit';

type Tab = 'overview' | 'breaks' | 'statements';

export default function TreasuryModule() {
  const route = useConsoleRoute();
  const { can } = useSession();
  const now = useNow(5000);
  const seg = route.segments[1];
  const tab: Tab = seg === 'breaks' ? 'breaks' : seg === 'statements' ? 'statements' : 'overview';
  const breaks = useApi((s) => treasuryApi.breaks({}, s), [], { intervalMs: 10_000, enabled: can('recon.read') });
  const openBreaks = breaks.data ? breaks.data.items.filter((b) => b.status !== 'resolved').length : null;

  return (
    <div className="ct-page">
      <PageHeader
        breadcrumb={[{ label: 'Treasury' }, { label: tab === 'overview' ? 'Overview' : tab === 'breaks' ? 'Reconciliation breaks' : 'Provider statements' }]}
        title="Treasury & reconciliation"
        subtitle="FX positions and provider balances from the ledger, today’s flows, and statement-to-ledger reconciliation."
        actions={
          <Button icon="refresh" onClick={() => breaks.refresh()}>
            Refresh
          </Button>
        }
      />
      <Tabs<Tab>
        label="Treasury sections"
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'breaks', label: 'Reconciliation breaks', count: openBreaks ?? undefined },
          { id: 'statements', label: 'Provider statements' },
        ]}
        value={tab}
        onChange={(id) => route.navigate(id === 'overview' ? links.treasury() : id === 'breaks' ? links.breaks() : '#/console/treasury/statements')}
      />
      {tab === 'overview' && <OverviewTab now={now} openBreaks={openBreaks} />}
      {tab === 'breaks' && <BreaksTab now={now} breaks={breaks} />}
      {tab === 'statements' && <StatementsTab />}
      <ToastHost />
    </div>
  );
}
