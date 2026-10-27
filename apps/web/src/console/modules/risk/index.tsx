// Risk & Compliance module root: #/console/risk/alerts[/:alertId], #/console/risk/cases[/:caseId].
import { useEffect } from 'react';
import { links, matchPattern, useConsoleRoute } from '../../route';
import { useApi } from '../../ui/hooks';
import { riskApi } from './data';
import AlertsPage from './AlertsPage';
import CasesPage from './CasesPage';
import CaseDetailPage from './CaseDetailPage';
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader, ToastHost } from './kit';

export default function RiskModule() {
  const { path, navigate } = useConsoleRoute();
  const caseMatch = matchPattern('risk/cases/:id', path);
  const alertMatch = matchPattern('risk/alerts/:id', path);
  let page;
  if (caseMatch?.id) page = <CaseDetailPage key={caseMatch.id} caseId={caseMatch.id} />;
  else if (alertMatch?.id) page = <AlertRedirect alertId={alertMatch.id} />;
  else if (path === 'risk/cases') page = <CasesPage />;
  else if (path === 'risk/alerts') page = <AlertsPage />;
  else page = <Redirect to={links.alerts()} navigate={navigate} />;
  return (
    <>
      {page}
      <ToastHost />
    </>
  );
}

function Redirect({ to, navigate }: { to: string; navigate(to: string, opts?: { replace?: boolean }): void }) {
  useEffect(() => navigate(to, { replace: true }), [to, navigate]);
  return null;
}

/** Deep link to an alert: open its case (alerts are worked through cases). */
function AlertRedirect({ alertId }: { alertId: string }) {
  const { navigate } = useConsoleRoute();
  const found = useApi((s) => riskApi.alerts({ q: alertId, status: 'all', limit: 5 }, s), [alertId]);
  const alert = found.data?.items.find((a) => a.alertId === alertId);
  useEffect(() => {
    if (alert) navigate(alert.caseId ? links.case(alert.caseId) : links.payment(alert.paymentId), { replace: true });
  }, [alert, navigate]);
  return (
    <div className="ct-page">
      <PageHeader breadcrumb={[{ label: 'Risk & Compliance' }, { label: 'Alerts', href: links.alerts() }, { label: alertId }]} title={alertId} />
      <Card>
        {found.loading || alert ? (
          <LoadingBlock lines={3} />
        ) : found.error ? (
          <ErrorState error={found.error} onRetry={found.refresh} />
        ) : (
          <EmptyState title="Alert not found" hint="It may belong to a reset demo run." />
        )}
      </Card>
    </div>
  );
}
