// Payments workspace router: payments (list) · payments/refunds · payments/:id (detail page).
import { useConsoleRoute } from '../../route';
import { PaymentsList } from './PaymentsList';
import { PaymentDetailPage } from './PaymentDetailPage';
import { RefundsPage } from './RefundsPage';

export default function PaymentsModule() {
  const { segments } = useConsoleRoute();
  const sub = segments[1];
  if (sub === 'refunds') return <RefundsPage />;
  if (sub) return <PaymentDetailPage paymentId={sub} />;
  return <PaymentsList />;
}
