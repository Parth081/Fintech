// Current-vs-proposed diff of one configuration key, field by field.
import type { ConfigKey } from '@ct/contracts/browser';
import { diffValues, formatValue } from './lib/config';

export function DiffTable({ configKey, before, after, beforeLabel = 'Current', afterLabel = 'Proposed', includeSame }: { configKey: ConfigKey; before: unknown; after: unknown; beforeLabel?: string; afterLabel?: string; includeSame?: boolean }) {
  const rows = diffValues(before, after, includeSame);
  if (!rows.length) return <div className="ct-muted">No difference.</div>;
  return (
    <div className="ct-table-wrap" style={{ border: '1px solid var(--ct-border)', borderRadius: 'var(--ct-radius-sm)' }}>
      <table className="ct-table ctm-table-dense">
        <thead>
          <tr>
            <th>Setting</th>
            <th>{beforeLabel}</th>
            <th>{afterLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path || '_'}>
              <td className="ct-mono">{r.path || configKey}</td>
              <td className={r.kind === 'same' ? '' : 'ctm-diff-before'}>{formatValue(configKey, r.path, r.before)}</td>
              <td className={r.kind === 'same' ? '' : 'ctm-diff-after'}>{formatValue(configKey, r.path, r.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
