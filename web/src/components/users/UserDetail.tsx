import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteUserStorage,
  fetchUsageDetail,
  fetchUserStorage,
  type AppUser,
  type StorageCategory,
} from '@/api/client';
import { Button } from '../ui/button';
import { BarList, Card, DailyChart, HourStrip, Tile, useNum, VersusMedian, WeekdayStrip } from './parts';

/** The four knowledge modes the composer offers (state/prefs.ts ChatMode),
 *  in the order the dropdown lists them. */
const MODE_ORDER = ['full', 'knowledge', 'sql', 'chat'];

function UsageSection({ username, days }: { username: string; days: number }) {
  const { t } = useTranslation();
  const { num, compact, hour, date, duration } = useNum();
  const { data, isError, error, fetchStatus, refetch } = useQuery({
    queryKey: ['usage-detail', username, days],
    queryFn: () => fetchUsageDetail(username, days),
    staleTime: 30_000,
    // Deliberately NOT placeholderData:(prev)=>prev — carrying the previous
    // user's numbers under the new user's name reads as real data for the
    // split second before the fetch lands.
    //
    // A failed request here must surface, not hang. With the app-wide default
    // (retry: 1) React Query parks the PENDING RETRY in fetchStatus 'paused'
    // with no error attached — the panel then spins forever and the Retry
    // button is a no-op, because refetch() cannot resume a paused query.
    // Verified against @tanstack/react-query 5.101.2: networkMode 'always'
    // alone does not prevent that parking, but having no retry to park does.
    // One attempt, then a real error and an explicit Retry, which is the right
    // shape for an admin panel anyway.
    networkMode: 'always',
    retry: false,
  });

  // Failure is checked BEFORE pending, and `paused` counts as failure. React
  // Query keeps status 'pending' while a query is retrying or parked by its
  // network manager, so guarding on isPending first swallows both states and
  // leaves the panel spinning with no explanation of what went wrong.
  if (isError || fetchStatus === 'paused') {
    return (
      <Card title={t('users.section.activity')}>
        <p className="text-xs text-destructive-foreground">
          {t('users.loadFailed', { user: username })}
        </p>
        <p className="mt-1 text-[11px] break-words text-muted-foreground">
          {(error as Error)?.message ?? t('users.unreachable')}
        </p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
          {t('users.retry')}
        </Button>
      </Card>
    );
  }
  if (!data) {
    return <p className="py-6 text-center text-xs text-muted-foreground">{t('common.loading')}</p>;
  }

  const { tiles, comparison } = data;
  const modeRows = MODE_ORDER.filter((m) => data.modes[m]).map((m) => ({
    key: m,
    label: t(`users.modes.${m}`),
    value: data.modes[m],
  }));
  // Every turn recorded before the knowledge mode was persisted has no mode
  // (see scripts/backfill_usage_events.py) — say so instead of showing a
  // misleadingly empty chart.
  const modesUnknown = data.tiles.turns > 0 && modeRows.length === 0;
  const modelRows = Object.entries(data.models)
    .map(([key, value]) => ({ key, label: key.split('/').pop() ?? key, value }))
    .sort((a, b) => b.value - a.value);
  const sessionModeRows = Object.entries(data.session_modes)
    .map(([key, value]) => ({ key, label: t(`users.sessionModes.${key}`, { defaultValue: key }), value }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-4">
      <Card
        title={t('users.section.activity')}
        action={
          <span className="text-xs text-muted-foreground">
            {t('users.rankOf', { rank: comparison.rank, of: comparison.of })}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label={t('users.tiles.turns')} value={num(tiles.turns)} />
          <Tile label={t('users.tiles.totalTokens')} value={compact(tiles.total_tokens)} />
          <Tile
            label={t('users.tiles.outputTokens')}
            value={compact(tiles.output_tokens)}
            hint={t('users.tiles.outputHint')}
          />
          <Tile label={t('users.tiles.avgPerTurn')} value={compact(tiles.avg_tokens_per_turn)} />
          <Tile label={t('users.tiles.sessions')} value={num(tiles.sessions)} />
          <Tile label={t('users.tiles.activeDays')} value={num(tiles.active_days)} />
          <Tile label={t('users.tiles.toolCalls')} value={num(tiles.tool_calls)} />
          <Tile
            label={t('users.tiles.toolErrors')}
            value={num(tiles.tool_errors)}
            tone={tiles.tool_errors > 0 ? 'warn' : undefined}
            hint={
              tiles.tool_calls
                ? t('users.tiles.errorRate', {
                  pct: ((tiles.tool_errors / tiles.tool_calls) * 100).toFixed(1),
                })
                : undefined
            }
          />
        </div>
        {/* Second tile row: cost/latency shape rather than volume. */}
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile
            label={t('users.tiles.avgResponse')}
            value={tiles.avg_response_ms ? duration(tiles.avg_response_ms) : '—'}
          />
          <Tile
            label={t('users.tiles.totalCompute')}
            value={tiles.total_compute_ms ? duration(tiles.total_compute_ms) : '—'}
            hint={t('users.tiles.computeHint')}
          />
          <Tile
            label={t('users.tiles.avgRounds')}
            value={tiles.avg_rounds ? tiles.avg_rounds.toString() : '—'}
            hint={t('users.tiles.roundsHint')}
          />
          <Tile
            label={t('users.tiles.busiestDay')}
            value={tiles.busiest_day ? date(tiles.busiest_day) : '—'}
            hint={tiles.busiest_day ? compact(tiles.busiest_day_tokens) : undefined}
          />
        </div>
        <div className="mt-3">
          <DailyChart daily={data.daily} days={days} />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <VersusMedian mine={tiles.total_tokens} median={comparison.median_tokens} label={t('users.tiles.totalTokens')} />
          <VersusMedian mine={tiles.turns} median={comparison.median_turns} label={t('users.tiles.turns')} />
          <VersusMedian mine={tiles.tool_calls} median={comparison.median_tools} label={t('users.tiles.toolCalls')} />
        </div>
        {data.limit.max_messages_per_day > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('users.limitPressure', {
              limit: data.limit.max_messages_per_day,
              days: data.limit.hit_days,
            })}
          </p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('users.section.tools')}>
          <BarList
            empty={t('users.empty.tools')}
            rows={data.tools.slice(0, 12).map((r) => ({
              key: r.tool,
              label: r.tool,
              value: r.count,
              sub: r.errors ? t('users.errorsShort', { count: r.errors }) : undefined,
              tone: r.errors ? 'warn' : undefined,
            }))}
          />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Tile label={t('users.tiles.webSearches')} value={num(tiles.web_searches)} />
            <Tile label={t('users.tiles.skillLoads')} value={num(tiles.skill_loads)} />
          </div>
        </Card>

        <Card title={t('users.section.skills')}>
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t('users.skillsUsed')}
          </div>
          <BarList
            empty={t('users.empty.skills')}
            rows={data.skills.used.slice(0, 8).map((s) => ({ key: s.name, label: s.name, value: s.count }))}
          />
          <div className="mt-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t('users.skillsAuthored')}
          </div>
          {data.skills.authored.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">{t('users.empty.authored')}</p>
          ) : (
            <div className="flex flex-wrap gap-1 pt-1">
              {data.skills.authored.map((name) => (
                <span key={name} className="rounded bg-muted px-1.5 py-0.5 text-xs">{name}</span>
              ))}
            </div>
          )}
        </Card>

        <Card title={t('users.section.modes')}>
          {modesUnknown ? (
            <p className="py-2 text-xs text-muted-foreground">{t('users.modesUnknown')}</p>
          ) : (
            <BarList empty={t('users.empty.modes')} rows={modeRows} />
          )}
          {sessionModeRows.length > 0 && (
            <>
              <div className="mt-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {t('users.section.sessionModes')}
              </div>
              <BarList empty="" rows={sessionModeRows} />
            </>
          )}
          {/* A single-model deployment gets no model chart — it would just be
              one bar at 100%. It appears on its own once a second model runs. */}
          {modelRows.length > 1 && (
            <>
              <div className="mt-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {t('users.section.models')}
              </div>
              <BarList empty="" rows={modelRows} />
            </>
          )}
        </Card>

        <Card title={t('users.section.hours')}>
          <HourStrip hours={data.hours} />
          <div className="mt-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t('users.section.weekday')}
          </div>
          <div className="mt-1">
            <WeekdayStrip weekday={data.weekday} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {tiles.peak_hour === null
              ? t('users.empty.hours')
              : t('users.peakHour', { hour: hour(tiles.peak_hour) })}
            {tiles.last_active && ` · ${t('users.lastActive', { when: date(tiles.last_active) })}`}
            {tiles.first_seen && ` · ${t('users.firstSeen', { when: date(tiles.first_seen) })}`}
          </p>
        </Card>
      </div>
    </div>
  );
}

function StorageSection({ username }: { username: string }) {
  const { t } = useTranslation();
  const { bytes } = useNum();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ['user-storage', username],
    queryFn: () => fetchUserStorage(username),
    staleTime: 30_000,
    networkMode: 'always',
    retry: false, // same reasoning as the usage query above
  });

  const remove = useMutation({
    mutationFn: ({ kind }: { kind: string }) => deleteUserStorage(username, kind),
    onSettled: () => {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: ['user-storage', username] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => window.alert((e as Error).message),
  });

  const confirmDelete = (cat: StorageCategory) => {
    const label = t(`users.storage.kind.${cat.kind}`);
    // Typed confirmation: these deletes are irreversible and hit another
    // person's data, so a stray click must not be enough.
    const typed = window.prompt(
      t('users.storage.confirmPrompt', { count: cat.count, label, user: username }),
      '',
    );
    if ((typed ?? '').trim().toLowerCase() !== username) {
      if (typed !== null) window.alert(t('users.storage.confirmMismatch'));
      return;
    }
    setBusy(cat.kind);
    remove.mutate({ kind: cat.kind });
  };

  if (!data) return null;
  const nonEmpty = data.categories.filter((c) => c.count > 0);

  return (
    <Card
      title={t('users.section.storage')}
      action={<span className="text-xs text-muted-foreground">{bytes(data.total_bytes)}</span>}
    >
      {nonEmpty.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{t('users.storage.empty')}</p>
      ) : (
        <div className="space-y-1">
          {nonEmpty.map((cat) => (
            <div key={cat.kind} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{t(`users.storage.kind.${cat.kind}`)}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {t('users.storage.items', { count: cat.count })}
                  {cat.detail && ` · ${cat.detail}`}
                  {cat.bytes > 0 && ` · ${bytes(cat.bytes)}`}
                </div>
              </div>
              <button
                type="button"
                aria-label={t('users.storage.deleteAria', { label: t(`users.storage.kind.${cat.kind}`), user: username })}
                disabled={busy === cat.kind}
                onClick={() => confirmDelete(cat)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive-foreground disabled:opacity-50"
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        {t('users.storage.note')}
        {!data.uploads_attributable && ` ${t('users.storage.uploadsNote')}`}
      </p>
    </Card>
  );
}

/** Right-hand detail column for the selected user: usage, then storage, then
 *  the account controls (privileges) so an admin can act on what they just saw
 *  without leaving the screen. */
export function UserDetail({ user, days, onManage }: {
  user: AppUser & { orphaned?: boolean };
  days: number;
  onManage: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {(user.display_name || user.username).slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">
              {user.display_name || user.username}
            </h1>
            {user.is_admin && (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-primary">
                {t('settings.users.admin')}
              </span>
            )}
            {user.orphaned && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground">
                {t('users.orphaned')}
              </span>
            )}
          </div>
          {user.display_name && (
            <div className="truncate text-xs text-muted-foreground">{user.username}</div>
          )}
        </div>
        {!user.orphaned && (
          <Button variant="outline" size="sm" onClick={onManage}>{t('users.manageAccount')}</Button>
        )}
      </div>

      <UsageSection username={user.username} days={days} />
      {!user.orphaned && <StorageSection username={user.username} />}
      <p className="pb-2 text-[11px] text-muted-foreground">{t('users.privacyNote')}</p>
    </div>
  );
}
