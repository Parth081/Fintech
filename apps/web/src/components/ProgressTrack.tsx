import { PIPELINE } from '@ct/contracts/browser';
import { progressDots } from '../lib/progress';
import { STAGE_LABELS } from '../lib/format';
import type { PaymentSummary } from '../lib/types';

export function ProgressTrack({ payment }: { payment: PaymentSummary }) {
  const dots = progressDots(payment);
  return (
    <span className="track" aria-label={`Stage ${payment.status}`}>
      {PIPELINE.map((stage, i) => (
        <span key={stage} className={`dot dot-${dots[i]}`} title={STAGE_LABELS[stage].title} />
      ))}
    </span>
  );
}
