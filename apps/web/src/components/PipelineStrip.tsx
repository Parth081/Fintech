import { PIPELINE, type PaymentStatus } from '@ct/contracts/browser';
import { STAGE_LABELS } from '../lib/format';
import type { Stats } from '../lib/types';

interface Props {
  stats: Stats | null;
  pulses: Partial<Record<PaymentStatus, number>>;
}

export function PipelineStrip({ stats, pulses }: Props) {
  const by = stats?.byStatus;
  return (
    <section className="pipeline" aria-label="Payment pipeline">
      <ol className="stages">
        {PIPELINE.map((s, i) => {
          const label = STAGE_LABELS[s];
          const n = pulses[s] ?? 0;
          const count = by?.[s] ?? 0;
          return (
            <li key={s} className={`stage${count > 0 ? ' stage-active' : ''}`}>
              {n > 0 && <span key={n} className="stage-pulse" aria-hidden="true" />}
              <span className="stage-num">{i + 1}</span>
              <span className="stage-title">{label.title}</span>
              <span className="stage-detail">{label.detail ?? ' '}</span>
              <span className="stage-count">{count}</span>
            </li>
          );
        })}
      </ol>
      <div className="offpath" aria-label="Stopped payments">
        {(['held', 'rejected'] as const).map((s) => {
          const n = pulses[s] ?? 0;
          return (
            <div key={s} className={`offpath-tile offpath-${s}`}>
              {n > 0 && <span key={n} className="stage-pulse" aria-hidden="true" />}
              <span className="stage-title">{STAGE_LABELS[s].title}</span>
              <span className="stage-count">{by?.[s] ?? 0}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
