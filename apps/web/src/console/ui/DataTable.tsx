// DataTable: dense enterprise table with sortable headers, row click, loading skeleton, empty state and paging.
//   <DataTable columns={cols} rows={items} rowKey={(r) => r.id} onRowClick={...}
//              loading={loading} empty="No payments match" paging={{ offset, limit, total, onChange }} />
// Sorting: client-side by default (column.sortValue); pass `sort` + `onSortChange` for server-side sorting.
import { useMemo, useState, type ReactNode } from 'react';
import { pageInfo } from '../lib/http';
import { nextSort, sortRows, type SortDir, type SortState, type SortValue } from '../lib/table';
import { formatNumber } from '../lib/format';
import { Icon } from './Icon';
import { Button, EmptyState, ErrorState, Select, Skeleton, cx } from './primitives';

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Right-aligned tabular numbers. */
  numeric?: boolean;
  /** Enables sorting on this column. */
  sortValue?: (row: T) => SortValue;
  defaultSortDir?: SortDir;
  width?: number | string;
  /** Always shown (column chooser cannot hide it). */
  required?: boolean;
  className?: string;
}

export interface Paging {
  offset: number;
  limit: number;
  total: number;
  onChange(offset: number, limit: number): void;
  pageSizes?: readonly number[];
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[] | null | undefined;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Href for the row (middle-click / ctrl-click opens a new tab; plain click navigates). */
  rowHref?: (row: T) => string;
  selectedKey?: string | null;
  loading?: boolean;
  error?: string | null;
  forbidden?: boolean;
  onRetry?: () => void;
  empty?: ReactNode;
  emptyHint?: ReactNode;
  paging?: Paging;
  /** Controlled sort (server-side): the table only reports clicks. */
  sort?: SortState | null;
  onSortChange?: (s: SortState) => void;
  initialSort?: SortState;
  compact?: boolean;
  /** Visible column ids (column chooser); default all. */
  visible?: readonly string[];
  caption?: string;
  skeletonRows?: number;
}

export function DataTable<T>(props: DataTableProps<T>) {
  const { columns, rows, rowKey, onRowClick, rowHref, selectedKey, loading, error, paging, compact, caption } = props;
  const [localSort, setLocalSort] = useState<SortState | null>(props.initialSort ?? null);
  const controlled = props.onSortChange !== undefined;
  const sort = controlled ? (props.sort ?? null) : localSort;
  const cols = useMemo(() => (props.visible ? columns.filter((c) => c.required || props.visible!.includes(c.id)) : columns), [columns, props.visible]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    if (controlled || !sort) return rows;
    const col = columns.find((c) => c.id === sort.key);
    return col?.sortValue ? sortRows(rows, col.sortValue, sort.dir) : rows;
  }, [rows, sort, columns, controlled]);

  const onHeader = (c: Column<T>) => {
    const next = nextSort(sort, c.id, c.defaultSortDir ?? (c.numeric ? 'desc' : 'asc'));
    if (controlled) props.onSortChange!(next);
    else setLocalSort(next);
  };

  const showSkeleton = loading && (!rows || rows.length === 0);
  const clickable = !!(onRowClick || rowHref);

  return (
    <div>
      <div className="ct-table-wrap">
        <table className={cx('ct-table', compact && 'ct-table-compact')}>
          {caption && <caption className="ct-sr-only">{caption}</caption>}
          <thead>
            <tr>
              {cols.map((c) => {
                const active = sort?.key === c.id;
                return (
                  <th
                    key={c.id}
                    className={cx(c.numeric && 'ct-num', c.className)}
                    style={c.width !== undefined ? { width: c.width } : undefined}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    scope="col"
                  >
                    {c.sortValue || (controlled && c.sortValue !== undefined) ? (
                      <button type="button" className="ct-th-sort" onClick={() => onHeader(c)}>
                        {c.header}
                        <Icon name={active ? (sort!.dir === 'asc' ? 'chevronUp' : 'chevronDown') : 'sort'} size={12} style={{ opacity: active ? 1 : 0.4 }} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {showSkeleton &&
              Array.from({ length: props.skeletonRows ?? 8 }, (_, i) => (
                <tr key={`sk${i}`}>
                  {cols.map((c) => (
                    <td key={c.id}>
                      <Skeleton width={c.numeric ? '60%' : `${55 + ((i * 17 + c.id.length * 7) % 40)}%`} style={c.numeric ? { marginLeft: 'auto' } : undefined} />
                    </td>
                  ))}
                </tr>
              ))}
            {!showSkeleton && error && (
              <tr>
                <td colSpan={cols.length}>
                  <ErrorState error={error} onRetry={props.onRetry} forbidden={props.forbidden} />
                </td>
              </tr>
            )}
            {!showSkeleton && !error && sorted.length === 0 && (
              <tr>
                <td colSpan={cols.length}>
                  <EmptyState title={props.empty ?? 'Nothing to show'} icon="search">
                    {props.emptyHint}
                  </EmptyState>
                </td>
              </tr>
            )}
            {!showSkeleton &&
              !error &&
              sorted.map((r) => {
                const key = rowKey(r);
                const href = rowHref?.(r);
                return (
                  <tr
                    key={key}
                    className={cx(clickable && 'ct-row-link', selectedKey === key && 'ct-row-selected')}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={(e) => {
                      if (!clickable) return;
                      const target = e.target as HTMLElement;
                      if (target.closest('a,button,input,select,textarea,label')) return;
                      if (href && (e.ctrlKey || e.metaKey)) {
                        window.open(href, '_blank');
                        return;
                      }
                      if (onRowClick) onRowClick(r);
                      else if (href) window.location.hash = href;
                    }}
                    onKeyDown={(e) => {
                      if (!clickable || e.target !== e.currentTarget) return;
                      if (e.key === 'Enter') {
                        if (onRowClick) onRowClick(r);
                        else if (href) window.location.hash = href;
                      }
                    }}
                  >
                    {cols.map((c) => (
                      <td key={c.id} className={cx(c.numeric && 'ct-num', c.className)}>
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      {paging && <Pager {...paging} loading={loading} />}
    </div>
  );
}

export function Pager({ offset, limit, total, onChange, pageSizes = [25, 50, 100], loading }: Paging & { loading?: boolean }) {
  const p = pageInfo(offset, limit, total);
  return (
    <div className="ct-pager">
      <span>
        {total === 0 ? 'No results' : `${formatNumber(p.from)}–${formatNumber(p.to)} of ${formatNumber(total)}`}
        {loading && <span className="ct-spinner" style={{ marginLeft: 8, width: 12, height: 12 }} aria-hidden="true" />}
      </span>
      <div className="ct-row">
        <label className="ct-row ct-small">
          Rows
          <Select
            compact
            value={String(limit)}
            onChange={(e) => onChange(0, Number(e.target.value))}
            options={pageSizes.map((n) => ({ value: String(n), label: String(n) }))}
            aria-label="Rows per page"
          />
        </label>
        <Button size="sm" icon="chevronLeft" disabled={!p.hasPrev} onClick={() => onChange(Math.max(0, offset - limit), limit)} aria-label="Previous page" />
        <span className="ct-small">
          Page {formatNumber(p.page)} of {formatNumber(p.pages)}
        </span>
        <Button size="sm" icon="chevronRight" disabled={!p.hasNext} onClick={() => onChange(offset + limit, limit)} aria-label="Next page" />
      </div>
    </div>
  );
}
