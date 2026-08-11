import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, ArrowUpIcon, DownloadIcon, TableIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WidgetProps } from './registry';

type Dict = Record<string, unknown>;
type Cell = string | number | boolean | null;

const asDict = (value: unknown): Dict =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {};
const asStr = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNum = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A column is numeric only if every value in it that isn't null is a number.
 *  One stray string (a "n/a" placeholder, a formatted total) makes the column
 *  text, because right-aligning a column that is mostly-but-not-quite numbers
 *  produces a ragged edge that is worse than left-aligning all of it. */
function numericColumns(rows: Cell[][], count: number): boolean[] {
  const numeric = new Array(count).fill(false);
  for (let c = 0; c < count; c++) {
    let seen = false;
    let allNumbers = true;
    for (const row of rows) {
      const value = row[c];
      if (value === null || value === undefined) continue;
      seen = true;
      if (typeof value !== 'number') {
        allNumbers = false;
        break;
      }
    }
    numeric[c] = seen && allNumbers;
  }
  return numeric;
}

/** Sort comparator that keeps nulls at the bottom in BOTH directions.
 *
 *  A null is the absence of a value, not the smallest one, so flipping the sort
 *  must not sweep a block of empty cells to the top — the first screenful is
 *  what the sort was for. Hence `desc` is applied INSIDE, to the value
 *  comparison only: negating the comparator's whole result from the caller would
 *  flip the null rule along with it. */
function compare(a: Cell, b: Cell, desc: boolean): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;
  const order =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return desc ? -order : order;
}

function toCsv(columns: string[], rows: Cell[][]): string {
  const quote = (value: Cell): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(quote).join(','), ...rows.map((row) => row.map(quote).join(','))].join('\r\n');
}

export function TableWidget({ data }: WidgetProps) {
  const { t } = useTranslation();
  const payload = asDict(data);
  const columns = useMemo(
    () => (Array.isArray(payload.columns) ? payload.columns.map((c) => String(c)) : []),
    [payload.columns],
  );
  const rows = useMemo<Cell[][]>(
    () =>
      Array.isArray(payload.rows)
        ? payload.rows
            .filter((r): r is unknown[] => Array.isArray(r))
            .map((r) => r.map((v) => (v as Cell) ?? null))
        : [],
    [payload.rows],
  );

  const [sort, setSort] = useState<{ column: number; desc: boolean } | null>(null);

  const numeric = useMemo(() => numericColumns(rows, columns.length), [rows, columns.length]);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    // A copy: `rows` is the payload's own array, and sorting in place would
    // reorder the source every render and make the order depend on history.
    const copy = [...rows];
    copy.sort((a, b) => compare(a[sort.column], b[sort.column], sort.desc));
    return copy;
  }, [rows, sort]);

  if (columns.length === 0) return null;

  const rowCount = asNum(payload.rowCount);
  const shown = rows.length;
  const spillPath = asStr(payload.spillPath);
  const label = asStr(payload.label);
  const database = asStr(payload.database);

  const toggleSort = (index: number) =>
    setSort((prev) =>
      prev?.column !== index ? { column: index, desc: false } : prev.desc ? null : { column: index, desc: true },
    );

  const download = () => {
    // Leading BOM, written as an escape rather than as the invisible character
    // it is: without it Excel reads a UTF-8 CSV as the local codepage and every
    // umlaut in a customer name arrives mangled.
    const blob = new Blob([`\ufeff${toCsv(columns, sorted)}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'result.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <TableIcon className="size-3.5 shrink-0" />
        {database && <span className="shrink-0 font-medium">{database}</span>}
        <span className="min-w-0 flex-1 truncate font-mono" title={label}>
          {label}
        </span>
        <button
          type="button"
          onClick={download}
          title={t('table.downloadHint')}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
        >
          <DownloadIcon className="size-3.5" />
          CSV
        </button>
      </div>

      {/* The table scrolls inside this box in both directions. A wide result set
          must never make the message column itself scroll sideways. */}
      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              {columns.map((column, i) => {
                const active = sort?.column === i;
                return (
                  <th
                    key={column + i}
                    scope="col"
                    aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                    className={cn(
                      'border-b bg-card px-3 py-1.5 font-medium whitespace-nowrap',
                      numeric[i] ? 'text-right' : 'text-left',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(i)}
                      className={cn(
                        'inline-flex items-center gap-1 transition-colors hover:text-foreground',
                        active ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {column}
                      {active &&
                        (sort.desc ? <ArrowDownIcon className="size-3" /> : <ArrowUpIcon className="size-3" />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, r) => (
              <tr key={r} className="border-b border-border/40 last:border-0 hover:bg-accent/50">
                {columns.map((_column, c) => {
                  const value = row[c];
                  return (
                    <td
                      key={c}
                      className={cn(
                        'px-3 py-1 align-top',
                        numeric[c] ? 'text-right tabular-nums whitespace-nowrap' : 'max-w-72 truncate',
                      )}
                      title={value === null ? undefined : String(value)}
                    >
                      {value === null ? (
                        // Rendered, not blank: an empty cell is ambiguous between
                        // NULL and the empty string, and in a database that is a
                        // distinction people are usually querying about.
                        <span className="text-muted-foreground/50 italic">NULL</span>
                      ) : typeof value === 'boolean' ? (
                        String(value)
                      ) : (
                        String(value)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 border-t px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {shown < rowCount
            ? t('table.showingOf', { shown, total: rowCount })
            : t('table.rows', { count: rowCount })}
        </span>
        {spillPath && (
          <>
            <span aria-hidden>·</span>
            <span className="truncate font-mono">{t('table.fullSetIn', { path: spillPath })}</span>
          </>
        )}
      </div>
    </div>
  );
}
