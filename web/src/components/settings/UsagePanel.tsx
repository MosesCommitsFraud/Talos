import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchMyUsage } from '@/api/client';
import { Button } from '../ui/button';
import { Segmented } from '../ui/segmented';
import { Page } from '../SettingsDialog';
import { BarList, DailyChart, DailyLegend, Section, StatGrid, useNum } from '../users/parts';

/** Settings → Usage: the signed-in user's own token/turn/tool consumption.
 *  The same numbers, and the same layout, as the admin Users page shows for
 *  them (components/users/UserDetail.tsx) minus the ranking against everyone
 *  else: the day's limit, a ledger of figures, the daily chart, then the
 *  breakdowns side by side. */

const PERIODS = ['7', '30', '90', '0'] as const;
type Period = (typeof PERIODS)[number];

function Meter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{
          width: `${clamped}%`,
          background: clamped >= 90 ? 'var(--destructive)' : 'var(--primary)',
        }}
      />
    </div>
  );
}

export function UsagePanel() {
  const { t } = useTranslation();
  const { num, compact, duration } = useNum();
  const [period, setPeriod] = useState<Period>('30');
  const days = Number(period);
  const { data, isError, error, refetch } = useQuery({
    queryKey: ['my-usage', days],
    queryFn: () => fetchMyUsage(days),
    staleTime: 30_000,
    // Keep the figures up while another period loads, so the panel does not
    // collapse to "Loading" and jump back.
    placeholderData: (prev) => prev,
    networkMode: 'always',
    retry: false,
  });

  if (isError) {
    return (
      <Page>
        <Section title={t('settings.usage.title')}>
          <p className="text-[13px] text-destructive-foreground">{t('settings.usage.loadFailed')}</p>
          <p className="mt-1 text-xs break-words text-muted-foreground">{(error as Error)?.message}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
            {t('users.retry')}
          </Button>
        </Section>
      </Page>
    );
  }
  if (!data) return <Page><p className="text-sm text-muted-foreground">{t('common.loading')}</p></Page>;

  const { tiles, limit } = data;
  // The daily series always ends on today (local), whatever the window.
  const today = data.daily[data.daily.length - 1]?.turns ?? 0;
  const limitPct = limit.max_messages_per_day > 0 ? (today / limit.max_messages_per_day) * 100 : 0;
  const modelRows = Object.entries(data.models)
    .map(([key, value]) => ({ key, label: key.split('/').pop() ?? key, value }))
    .sort((a, b) => b.value - a.value);

  return (
    <Page className="gap-6">
      {limit.max_messages_per_day > 0 && (
        <Section
          title={t('settings.usage.messagesToday')}
          action={
            <span className="text-xs text-muted-foreground tabular-nums">
              {t('settings.usage.used', { used: num(today), limit: num(limit.max_messages_per_day) })}
            </span>
          }
        >
          <div className="flex items-center gap-3">
            <Meter pct={limitPct} />
            <span className="shrink-0 text-[11px] text-muted-foreground">{t('settings.usage.resetsMidnight')}</span>
          </div>
        </Section>
      )}

      <Section
        title={t('settings.usage.title')}
        action={
          <Segmented<Period>
            size="sm"
            label={t('settings.usage.period')}
            value={period}
            onChange={setPeriod}
            options={PERIODS.map((p) => ({ value: p, label: t(`settings.usage.periods.${p}`) }))}
          />
        }
      >
        <StatGrid
          stats={[
            { label: t('users.tiles.totalTokens'), value: compact(tiles.total_tokens) },
            { label: t('users.tiles.turns'), value: num(tiles.turns) },
            { label: t('users.tiles.sessions'), value: num(tiles.sessions) },
            { label: t('users.tiles.activeDays'), value: num(tiles.active_days) },
            { label: t('settings.usage.input'), value: compact(tiles.input_tokens), hint: t('settings.usage.inputShort') },
            { label: t('settings.usage.output'), value: compact(tiles.output_tokens), hint: t('settings.usage.outputShort') },
            { label: t('users.tiles.avgPerTurn'), value: compact(tiles.avg_tokens_per_turn) },
            { label: t('users.tiles.toolCalls'), value: num(tiles.tool_calls) },
            { label: t('users.tiles.webSearches'), value: num(tiles.web_searches) },
            { label: t('users.tiles.skillLoads'), value: num(tiles.skill_loads) },
            { label: t('users.tiles.avgResponse'), value: tiles.avg_response_ms ? duration(tiles.avg_response_ms) : '—' },
            {
              label: t('users.tiles.totalCompute'),
              value: tiles.total_compute_ms ? duration(tiles.total_compute_ms) : '—',
              hint: t('users.tiles.computeHint'),
            },
          ]}
        />
      </Section>

      <Section title={t('users.chart.label')} action={<DailyLegend />}>
        <DailyChart daily={data.daily} days={days > 0 ? days : data.daily.length} />
      </Section>

      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
        <Section title={t('users.section.tools')}>
          <BarList
            empty={t('settings.usage.empty')}
            rows={data.tools.slice(0, 8).map((r) => ({ key: r.tool, label: r.tool, value: r.count }))}
          />
        </Section>
        {modelRows.length > 1 && (
          <Section title={t('settings.usage.models')}>
            <BarList empty={t('settings.usage.empty')} rows={modelRows} />
          </Section>
        )}
      </div>
    </Page>
  );
}
