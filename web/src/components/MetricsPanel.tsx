import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { GaugeIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { fetchSessionMetrics, type TurnMetricsRow } from '@/api/client';
import { cn } from '@/lib/utils';
import { useChat } from '@/state/chat';
import { useUi } from '@/state/ui';
import { BarList, Tile, useHoverTip, useNum } from './users/parts';

/* Admin pane in the right dock: the open chat's turn metrics as charts. Same
 * rows as the CSV export (src/turn_metrics_export.py) plus their `detail` —
 * output split into thinking / answer / tool calls, prefix-cache hits, where
 * the time went and how full the context was.
 *
 * Every chart is per turn on the x-axis, so the panel reads top to bottom as
 * one story about the same turns. Colors carry one meaning across all charts
 * (--viz-* in styles/index.css): thinking is orange wherever it appears. */

type Series = { key: string; label: string; color: string };
type Bar = { label: string; title: string; values: number[] };

const iconBtn =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

/** Swatch + label (+ total) — the legend under every multi-series chart, so
 *  identity never rests on color alone. */
function Legend({ series, totals, format }: { series: Series[]; totals?: number[]; format?: (n: number) => string }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {series.map((s, i) => (
        <span key={s.key} className="flex items-center gap-1">
          <i className="size-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
          {s.label}
          {totals && format && <span className="tabular-nums text-foreground">{format(totals[i])}</span>}
        </span>
      ))}
    </div>
  );
}

/** Vertical stacked bars, one per turn. Segments stack bottom-up in series
 *  order with a 1px surface gap; the hover bubble lists every part. */
function StackedBars({ bars, series, format, height = 'h-32', scaleMax }: {
  bars: Bar[];
  series: Series[];
  format: (n: number) => string;
  height?: string;
  /** Fixed top of the scale (e.g. the context window) instead of the
   *  tallest bar, for values that are a share of a known whole. */
  scaleMax?: number;
}) {
  const { show, clear, node } = useHoverTip();
  const max = scaleMax || Math.max(...bars.map((b) => b.values.reduce((a, v) => a + v, 0)), 1);
  return (
    <div className="relative" onMouseLeave={clear}>
      <div className={cn('flex items-end gap-1', height)}>
        {bars.map((b) => {
          const sum = b.values.reduce((a, v) => a + v, 0);
          return (
            <div
              key={b.label}
              className="flex min-w-1 flex-1 flex-col-reverse justify-start self-stretch"
              onMouseEnter={(e) =>
                show({
                  x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2,
                  y: e.currentTarget.offsetTop,
                  label: `${b.title}: ${format(sum)} — ${series
                    .map((s, i) => (b.values[i] ? `${s.label} ${format(b.values[i])}` : ''))
                    .filter(Boolean)
                    .join(' · ')}`,
                })
              }
            >
              {sum === 0 ? (
                <div className="h-px" style={{ background: 'color-mix(in srgb, var(--foreground) 10%, transparent)' }} />
              ) : (
                series.map((s, i) =>
                  b.values[i] > 0 ? (
                    <div
                      key={s.key}
                      className="border-t border-background first:border-t-0 last:rounded-t-[3px]"
                      style={{ height: `${(b.values[i] / max) * 100}%`, minHeight: 2, background: s.color }}
                    />
                  ) : null,
                )
              )}
            </div>
          );
        })}
      </div>
      <TurnAxis labels={bars.map((b) => b.label)} />
      {node}
    </div>
  );
}

/** Turn numbers under a chart; thinned out so long chats stay legible. */
function TurnAxis({ labels }: { labels: string[] }) {
  const step = Math.ceil(labels.length / 12);
  return (
    <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground tabular-nums">
      {labels.map((l, i) => (
        <span key={l} className="min-w-1 flex-1 truncate text-center">
          {i % step === 0 || i === labels.length - 1 ? l : ''}
        </span>
      ))}
    </div>
  );
}

/** 100% bar of a whole: the chat's output share per kind at a glance. */
function ShareBar({ series, values, format }: { series: Series[]; values: number[]; format: (n: number) => string }) {
  const { show, clear, node } = useHoverTip();
  const sum = values.reduce((a, v) => a + v, 0);
  if (sum === 0) return null;
  return (
    <div className="relative" onMouseLeave={clear}>
      <div className="flex h-3 w-full gap-px overflow-hidden rounded-[4px]">
        {series.map((s, i) =>
          values[i] > 0 ? (
            <div
              key={s.key}
              style={{ width: `${(values[i] / sum) * 100}%`, background: s.color }}
              onMouseEnter={(e) =>
                show({
                  x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2,
                  y: e.currentTarget.offsetTop,
                  label: `${s.label}: ${format(values[i])} (${Math.round((values[i] / sum) * 100)} %)`,
                })
              }
            />
          ) : null,
        )}
      </div>
      {node}
    </div>
  );
}

/** "Ø 44 · min 40 · max 48" — the numbers a single-series chart is read for,
 *  as text, so nobody has to hover every bar. */
function spread(values: number[], format: (n: number) => string, t: (k: string) => string) {
  if (!values.length) return undefined;
  const avg = values.reduce((a, v) => a + v, 0) / values.length;
  return `Ø ${format(avg)} · ${t('metrics.min')} ${format(Math.min(...values))} · ${t('metrics.max')} ${format(Math.max(...values))}`;
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-3">
      <h3 className="text-xs font-medium">{title}</h3>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const sum = (rows: TurnMetricsRow[], pick: (r: TurnMetricsRow) => number) => rows.reduce((a, r) => a + pick(r), 0);

export function MetricsPane({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { num, compact } = useNum();
  const close = useUi((s) => s.setMetricsPanelOpen);
  const sessionId = useChat((s) => s.sessionId);
  const streaming = useChat((s) => s.streaming);
  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['session-metrics', sessionId],
    queryFn: () => fetchSessionMetrics(sessionId!),
    enabled: !!sessionId,
    retry: false,
  });

  // A finished turn changes the numbers: refetch once the stream ends.
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) void refetch();
    wasStreaming.current = streaming;
  }, [streaming, refetch]);

  const secs = (s: number) => `${s.toLocaleString(undefined, { maximumFractionDigits: s < 10 ? 1 : 0 })} s`;
  const turns = data?.turns ?? [];
  const total = data?.total ?? null;
  const td = total?.detail;
  const label = (r: TurnMetricsRow) => String(r.Turn);
  const title = (r: TurnMetricsRow) => `${t('metrics.turn')} ${r.Turn}`;

  const outSeries: Series[] = [
    { key: 'reasoning', label: t('metrics.thinking'), color: 'var(--viz-thinking)' },
    { key: 'answer', label: t('metrics.answer'), color: 'var(--viz-answer)' },
    { key: 'tools', label: t('metrics.toolCalls'), color: 'var(--viz-tools)' },
    ...(td?.unsplit_tokens ? [{ key: 'unsplit', label: t('metrics.unsplit'), color: 'var(--viz-unsplit)' }] : []),
  ];
  const outValues = (r: TurnMetricsRow) => [
    r.detail.reasoning_tokens,
    r.detail.answer_tokens,
    r.detail.tool_call_tokens,
    ...(td?.unsplit_tokens ? [r.detail.unsplit_tokens] : []),
  ];
  const inSeries: Series[] = [
    { key: 'cached', label: t('metrics.cached'), color: 'color-mix(in srgb, var(--primary) 35%, transparent)' },
    { key: 'fresh', label: t('metrics.fresh'), color: 'color-mix(in srgb, var(--primary) 85%, transparent)' },
  ];
  const inValues = (r: TurnMetricsRow) => {
    const cached = Math.min(r.detail.cached_tokens, r['Input-Tokens (Summe)']);
    return [cached, r['Input-Tokens (Summe)'] - cached];
  };
  const timeSeries: Series[] = [
    { key: 'prep', label: t('metrics.time.prep'), color: 'var(--viz-prep)' },
    { key: 'wait', label: t('metrics.time.wait'), color: 'var(--viz-wait)' },
    { key: 'thinking', label: t('metrics.time.thinking'), color: 'var(--viz-thinking)' },
    { key: 'writing', label: t('metrics.time.writing'), color: 'var(--viz-answer)' },
    { key: 'tools', label: t('metrics.time.tools'), color: 'var(--viz-tools)' },
  ];
  const timeValues = (r: TurnMetricsRow) => {
    const tm = r.detail.time;
    return [tm.context_build + tm.prep, tm.wait, tm.thinking, tm.writing, tm.tools];
  };
  const single = (key: string, color: string): Series[] => [{ key, label: key, color }];

  const outTotals = total ? outValues(total) : [];
  const outSum = total?.['Ausgabe-Tokens'] ?? 0;
  const thinkingShare = outSum ? Math.round(((td?.reasoning_tokens ?? 0) / outSum) * 100) : 0;
  const tpsRows = turns.filter((r) => r['Tokens/s'] != null);
  const avgTps = tpsRows.length ? sum(tpsRows, (r) => r['Tokens/s'] ?? 0) / tpsRows.length : null;
  const ttftRows = turns.filter((r) => r['TTFT [s]'] != null);
  const avgTtft = ttftRows.length ? sum(ttftRows, (r) => r['TTFT [s]'] ?? 0) / ttftRows.length : null;
  const ctxMax = td?.context_length ?? 0;
  const toolRows = Object.entries(td?.tools ?? {})
    .map(([name, s]) => ({
      key: name,
      label: name,
      value: s.calls,
      sub: s.errors ? t('metrics.errors', { count: s.errors }) : undefined,
    }))
    .sort((a, b) => b.value - a.value);
  const ctxRows = Object.entries(td?.context_breakdown ?? {})
    .map(([k, v]) => ({ key: k, label: t(`contextMeter.categories.${k}`, { defaultValue: k }), value: v }))
    .sort((a, b) => b.value - a.value);
  const splitNote =
    td?.split_source === 'backend'
      ? t('metrics.splitBackend')
      : td?.split_source === 'none'
        ? t('metrics.splitNone')
        : t('metrics.splitEstimated');

  return (
    <section className={className} aria-label={t('metrics.title')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-3">
        <GaugeIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('metrics.title')}</span>
        {total && (
          <span className="shrink-0 text-xs text-muted-foreground">{t('metrics.turns', { count: turns.length })}</span>
        )}
        <button type="button" aria-label={t('metrics.refresh')} onClick={() => void refetch()} className={iconBtn}>
          <RefreshCwIcon className={cn('size-3.5', isFetching && 'animate-spin')} />
        </button>
        <button type="button" aria-label={t('metrics.closePanel')} onClick={() => close(false)} className={iconBtn}>
          <XIcon className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {isError ? (
          <p className="py-8 text-center text-sm text-destructive-foreground">{(error as Error).message}</p>
        ) : !data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : !total ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('metrics.empty')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Tile label={t('metrics.kpi.output')} value={compact(outSum)} hint={t('metrics.kpi.thinkingShare', { pct: thinkingShare })} />
              <Tile label={t('metrics.kpi.input')} value={compact(total['Input-Tokens (Summe)'])} hint={td?.cached_tokens ? t('metrics.kpi.cachedShare', { pct: Math.round((td.cached_tokens / Math.max(total['Input-Tokens (Summe)'], 1)) * 100) }) : undefined} />
              <Tile label={t('metrics.kpi.tps')} value={avgTps != null ? num(avgTps) : '—'} hint={td?.prefill_tps ? t('metrics.kpi.prefill', { tps: num(td.prefill_tps) }) : undefined} />
              <Tile label={t('metrics.kpi.ttft')} value={avgTtft != null ? secs(avgTtft) : '—'} />
              <Tile label={t('metrics.kpi.time')} value={secs(total['Antwortzeit [s]'])} hint={t('metrics.kpi.rounds', { count: total.Runden })} />
              <Tile
                label={t('metrics.kpi.toolCalls')}
                value={num(total['Tool-Calls'])}
                hint={total['Fehlerhafte Tool-Calls'] ? t('metrics.errors', { count: total['Fehlerhafte Tool-Calls'] }) : undefined}
                tone={total['Fehlerhafte Tool-Calls'] ? 'warn' : undefined}
              />
            </div>

            <Card title={t('metrics.outputTitle')} hint={splitNote}>
              <ShareBar series={outSeries} values={outTotals} format={num} />
              <div className="mt-3">
                <StackedBars
                  bars={turns.map((r) => ({ label: label(r), title: title(r), values: outValues(r) }))}
                  series={outSeries}
                  format={num}
                />
              </div>
              <Legend series={outSeries} totals={outTotals} format={compact} />
            </Card>

            <Card title={t('metrics.timeTitle')} hint={t('metrics.timeHint')}>
              <StackedBars
                bars={turns.map((r) => ({ label: label(r), title: title(r), values: timeValues(r) }))}
                series={timeSeries}
                format={secs}
              />
              <Legend series={timeSeries} totals={timeValues(total)} format={secs} />
            </Card>

            <Card title={t('metrics.inputTitle')} hint={t('metrics.inputHint')}>
              <StackedBars
                bars={turns.map((r) => ({ label: label(r), title: title(r), values: inValues(r) }))}
                series={inSeries}
                format={num}
                height="h-24"
              />
              <Legend series={inSeries} totals={inValues(total)} format={compact} />
            </Card>

            {tpsRows.length > 0 && (
              <Card title={t('metrics.tpsTitle')} hint={spread(tpsRows.map((r) => r['Tokens/s'] ?? 0), (n) => `${num(n)} t/s`, t)}>
                <StackedBars
                  bars={turns.map((r) => ({ label: label(r), title: title(r), values: [r['Tokens/s'] ?? 0] }))}
                  series={single(t('metrics.kpi.tps'), 'var(--viz-answer)')}
                  format={(n) => `${num(n)} t/s`}
                  height="h-20"
                />
              </Card>
            )}

            {ttftRows.length > 0 && (
              <Card title={t('metrics.ttftTitle')} hint={`${t('metrics.ttftHint')} ${spread(ttftRows.map((r) => r['TTFT [s]'] ?? 0), secs, t)}`}>
                <StackedBars
                  bars={turns.map((r) => ({ label: label(r), title: title(r), values: [r['TTFT [s]'] ?? 0] }))}
                  series={single(t('metrics.kpi.ttft'), 'var(--viz-wait)')}
                  format={secs}
                  height="h-20"
                />
              </Card>
            )}

            <Card
              title={t('metrics.contextTitle')}
              hint={ctxMax ? t('metrics.contextHint', { max: compact(ctxMax) }) : undefined}
            >
              <StackedBars
                bars={turns.map((r) => ({ label: label(r), title: title(r), values: [r['Kontext-Tokens']] }))}
                series={single(t('metrics.contextTitle'), 'color-mix(in srgb, var(--primary) 70%, transparent)')}
                format={(n) => (ctxMax ? `${compact(n)} (${Math.round((n / ctxMax) * 100)} %)` : compact(n))}
                height="h-20"
                scaleMax={ctxMax || undefined}
              />
              {ctxRows.length > 0 && (
                <div className="mt-3 border-t border-border/60 pt-3">
                  <p className="mb-1.5 text-[11px] text-muted-foreground">{t('metrics.contextLast')}</p>
                  <BarList rows={ctxRows} empty="" />
                </div>
              )}
            </Card>

            {toolRows.length > 0 && (
              <Card title={t('metrics.toolsTitle')}>
                <BarList rows={toolRows} empty="" />
              </Card>
            )}

            {/* The same numbers as a table — the readable fallback for every
                chart above (and what the CSV export holds). */}
            <Card title={t('metrics.tableTitle')}>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr className="text-right [&>th]:px-1.5 [&>th]:pb-1 [&>th]:font-normal">
                      <th className="text-left">#</th>
                      <th>{t('metrics.thinking')}</th>
                      <th>{t('metrics.answer')}</th>
                      <th>{t('metrics.toolCalls')}</th>
                      <th>t/s</th>
                      <th>TTFT</th>
                      <th>{t('metrics.kpi.time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...turns, total].map((r) => (
                      <tr
                        key={String(r.Turn)}
                        title={r.Frage}
                        className={cn('border-t border-border/60 text-right [&>td]:px-1.5 [&>td]:py-1', r === total && 'font-medium')}
                      >
                        <td className="text-left">{r === total ? t('metrics.total') : r.Turn}</td>
                        <td>{num(r.detail.reasoning_tokens)}</td>
                        <td>{num(r.detail.answer_tokens)}</td>
                        <td>{num(r.detail.tool_call_tokens)}</td>
                        <td>{r['Tokens/s'] != null ? num(r['Tokens/s']) : '—'}</td>
                        <td>{r['TTFT [s]'] != null ? secs(r['TTFT [s]']) : '—'}</td>
                        <td>{secs(r['Antwortzeit [s]'])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </section>
  );
}
