import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchMyUsage } from '@/api/client';
import { Button } from '../ui/button';
import { Page, Row, Section, Segmented } from '../SettingsDialog';
import { BarList, DailyChart, useNum } from '../users/parts';

/** Settings → Usage: the signed-in user's own token/turn/tool consumption.
 *  Same numbers the admin Users workspace shows for them, minus the ranking
 *  against everyone else. Laid out like Claude's usage page — a limit meter
 *  first, then plain label/value rows. */

const PERIODS = ['7', '30', '90', '0'] as const;
type Period = (typeof PERIODS)[number];

function Meter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted sm:w-56" aria-hidden>
      <div
        className="h-full rounded-full transition-[width]"
        style={{
          width: `${clamped}%`,
          background: clamped >= 90 ? 'var(--destructive)' : 'var(--primary)',
        }}
      />
    </div>
  );
}

function Value({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-foreground tabular-nums">{children}</span>;
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
    networkMode: 'always',
    retry: false,
  });

  if (isError) {
    return (
      <Page>
        <Section title={t('settings.usage.title')} padded>
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
  const periodSwitch = (
    <Segmented<Period>
      label={t('settings.usage.period')}
      value={period}
      onChange={setPeriod}
      options={PERIODS.map((p) => ({ value: p, label: t(`settings.usage.periods.${p}`) }))}
    />
  );

  return (
    <Page>
      {limit.max_messages_per_day > 0 && (
        <Section title={t('settings.usage.limits')}>
          <Row label={t('settings.usage.messagesToday')} hint={t('settings.usage.resetsMidnight')}>
            <div className="flex w-full items-center gap-3 sm:w-auto">
              <Meter pct={limitPct} />
              <span className="w-24 shrink-0 text-right text-[13px] text-muted-foreground tabular-nums">
                {t('settings.usage.used', { used: num(today), limit: num(limit.max_messages_per_day) })}
              </span>
            </div>
          </Row>
        </Section>
      )}

      <Section title={t('settings.usage.title')} action={periodSwitch}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 py-3 sm:grid-cols-4">
          {[
            { label: t('users.tiles.totalTokens'), value: compact(tiles.total_tokens) },
            { label: t('users.tiles.turns'), value: num(tiles.turns) },
            { label: t('users.tiles.sessions'), value: num(tiles.sessions) },
            { label: t('users.tiles.activeDays'), value: num(tiles.active_days) },
          ].map((s) => (
            <div key={s.label} className="min-w-0">
              <div className="truncate text-xs text-muted-foreground">{s.label}</div>
              <div className="truncate text-xl font-semibold tracking-[-0.01em] tabular-nums">{s.value}</div>
            </div>
          ))}
        </div>
        <div className="border-t border-border/60 pt-4 pb-1">
          <DailyChart daily={data.daily} days={days > 0 ? days : data.daily.length} />
        </div>
      </Section>

      <Section title={t('settings.usage.tokens')}>
        <Row label={t('settings.usage.input')} hint={t('settings.usage.inputHint')}>
          <Value>{num(tiles.input_tokens)}</Value>
        </Row>
        <Row label={t('settings.usage.output')} hint={t('settings.usage.outputHint')}>
          <Value>{num(tiles.output_tokens)}</Value>
        </Row>
        <Row label={t('users.tiles.avgPerTurn')}>
          <Value>{num(tiles.avg_tokens_per_turn)}</Value>
        </Row>
      </Section>

      <Section title={t('settings.usage.activity')}>
        <Row label={t('users.tiles.toolCalls')}>
          <Value>{num(tiles.tool_calls)}</Value>
        </Row>
        <Row label={t('users.tiles.webSearches')}>
          <Value>{num(tiles.web_searches)}</Value>
        </Row>
        <Row label={t('users.tiles.avgResponse')}>
          <Value>{tiles.avg_response_ms ? duration(tiles.avg_response_ms) : '—'}</Value>
        </Row>
        <Row label={t('users.tiles.totalCompute')} hint={t('users.tiles.computeHint')}>
          <Value>{tiles.total_compute_ms ? duration(tiles.total_compute_ms) : '—'}</Value>
        </Row>
      </Section>

      {modelRows.length > 1 && (
        <Section title={t('settings.usage.models')} padded>
          <BarList empty={t('settings.usage.empty')} rows={modelRows} />
        </Section>
      )}

      <Section title={t('users.section.tools')} padded>
        <BarList
          empty={t('settings.usage.empty')}
          rows={data.tools.slice(0, 8).map((r) => ({ key: r.tool, label: r.tool, value: r.count }))}
        />
      </Section>
    </Page>
  );
}
