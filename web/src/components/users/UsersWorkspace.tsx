import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchUsageOverview, fetchUsers, type AppUser, type UsageUserRow } from '@/api/client';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { useSidebarAway } from '@/lib/useNarrowWindow';
import { useAuth } from '../auth/AuthGate';
import { SettingsDialog } from '../SettingsDialog';
import { SearchInput } from '../ui/search';
import { Segmented } from '../ui/segmented';
import { Badge, StatGrid, SubLabel, UserAvatar, useNum } from './parts';
import { UserDetail } from './UserDetail';

/** Windows the whole workspace is scoped to. `0` = all time, matching the
 *  home screen's range selector (components/Welcome.tsx). */
const RANGES = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: 'all', days: 0 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/** One account in the rail: who, and on the same line how much — the list is
 *  sorted by it, so the column of numbers is the ranking. */
function UserRow({ row, selected, onSelect }: {
  row: UsageUserRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const { compact } = useNum();
  const name = row.display_name || row.username;
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      title={row.turns > 0 ? t('users.list.summary', { tokens: compact(row.total_tokens), turns: row.turns }) : t('users.list.idle')}
      onClick={onSelect}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors',
        selected ? 'bg-sidebar-active text-strong' : 'text-foreground hover:bg-sidebar-accent',
      )}
    >
      <UserAvatar name={name} className="size-5 text-[10px]" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {row.is_admin && <Badge tone="primary">{t('settings.users.admin')}</Badge>}
      <span className={cn('shrink-0 text-xs tabular-nums', row.turns > 0 ? 'text-muted-foreground' : 'text-muted-foreground/50')}>
        {row.turns > 0 ? compact(row.total_tokens) : '—'}
      </span>
    </button>
  );
}

/** The /users workspace: a user list rail on the left, the selected user's
 *  usage + storage + account controls on the right. Mirrors the /rag
 *  workspace's shell (components/rag/RagWorkspace.tsx). */
export function UsersWorkspace() {
  const { t } = useTranslation();
  const { num, compact } = useNum();
  const setView = useUi((s) => s.setView);
  const auth = useAuth();
  const sidebarAway = useSidebarAway();
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d');
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[1];
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  // The account-management panel (create/rename/privileges) still lives in the
  // settings dialog — opened over the workspace rather than duplicated here.
  const [manageOpen, setManageOpen] = useState(false);

  // Admin-only surface. The API enforces this too (require_admin on every
  // route), but `#/users` is typeable, and a wall of failed requests is a worse
  // answer than sending them back to chat.
  const isAdmin = auth?.is_admin || auth?.auth_enabled === false;
  useEffect(() => {
    if (auth && !isAdmin) setView('chat');
  }, [auth, isAdmin, setView]);

  const { data: overview } = useQuery({
    queryKey: ['usage-overview', range.days],
    queryFn: () => fetchUsageOverview(range.days),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    enabled: !!isAdmin,
    // See UserDetail: don't let a failed request park silently as 'paused'.
    networkMode: 'always',
    retry: false,
  });
  const { data: accounts } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
    enabled: !!isAdmin,
  });

  const rows = overview?.users ?? [];
  const q = query.trim().toLowerCase();
  const visible = rows.filter(
    (r) => !q || r.username.toLowerCase().includes(q) || (r.display_name ?? '').toLowerCase().includes(q),
  );
  // Selection is sticky: once an admin picks someone, a background refetch or a
  // reordering of the list (it sorts by tokens, which moves as data arrives)
  // must not bounce them back to the top row. Only fall back to the first row
  // while nothing has been picked, or when the pick is filtered out entirely.
  const picked = selected ? rows.find((r) => r.username === selected) : undefined;
  const active = picked ?? visible[0];
  const activeAccount: (AppUser & { orphaned?: boolean }) | undefined = active
    ? {
      ...(accounts ?? []).find((a) => a.username === active.username)
        ?? { username: active.username, is_admin: active.is_admin },
      display_name: active.display_name,
      orphaned: active.orphaned,
    }
    : undefined;

  const iconBtn =
    'flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground';
  const rangeSwitch = (
    <Segmented<RangeKey>
      size="sm"
      label={t('settings.usage.period')}
      value={rangeKey}
      onChange={setRangeKey}
      options={RANGES.map((r) => ({ value: r.key, label: t(`users.range.${r.key}`) }))}
    />
  );

  return (
    // A container, so the layout follows the room this page really has (the
    // window minus sidebar), not the window: side by side when there is width
    // for both, the list on top as a short strip when there is not. The
    // container is `main` and the layout the box inside it: an element cannot
    // query its own size, only that of a container around it.
    <main className="@container/users min-w-0 flex-1 overflow-hidden">
      <div className="flex size-full min-h-0 flex-col @3xl/users:flex-row">
      {/* The user list, with the deployment's totals under it. */}
      <div className="flex max-h-[38%] shrink-0 flex-col border-b bg-sidebar @3xl/users:max-h-none @3xl/users:w-60 @3xl/users:border-r @3xl/users:border-b-0">
        <div className={cn('flex h-11 shrink-0 items-center gap-1 px-2', sidebarAway && 'pl-11')}>
          <button type="button" onClick={() => setView('chat')} aria-label={t('users.backToChat')} title={t('users.backToChat')} className={iconBtn}>
            <ArrowLeftIcon className="size-4" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-strong">{t('users.title')}</h1>
          <button type="button" onClick={() => setManageOpen(true)} aria-label={t('users.manageAccounts')} title={t('users.manageAccounts')} className={iconBtn}>
            <SettingsIcon className="size-4" />
          </button>
        </div>
        <div className="px-2 pb-1.5">
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('users.searchPlaceholder')}
            aria-label={t('users.searchPlaceholder')}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2">
          {visible.map((row) => (
            <UserRow
              key={row.username}
              row={row}
              selected={row.username === active?.username}
              onSelect={() => setSelected(row.username)}
            />
          ))}
          {visible.length === 0 && (
            <div className="px-2 py-6 text-xs text-muted-foreground">{t('users.noResults')}</div>
          )}
        </div>
        {/* Deployment totals — the baseline every per-user number is read against. */}
        {overview && (
          <div className="hidden pt-2 @3xl/users:block">
            <SubLabel className="px-3 pb-1.5">{t('users.deployment')}</SubLabel>
            <StatGrid
              columns={2}
              className="border-b-0"
              stats={[
                { label: t('users.tiles.activeUsers'), value: num(overview.totals.active_users) },
                { label: t('users.tiles.totalTokens'), value: compact(overview.totals.total_tokens) },
                { label: t('users.tiles.turns'), value: num(overview.totals.turns) },
                { label: t('users.tiles.toolCalls'), value: num(overview.totals.tool_calls) },
              ]}
            />
          </div>
        )}
      </div>

      {/* Right: the selected user's detail. One scroller, nothing layered over
          it — a mask or a fading header here would have the whole column
          re-rasterised on every scrolled frame. */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-4xl px-4 py-5 @3xl/users:px-6">
          {activeAccount ? (
            <UserDetail user={activeAccount} days={range.days} onManage={() => setManageOpen(true)} toolbar={rangeSwitch} />
          ) : (
            <p className="pt-10 text-sm text-muted-foreground">{t('users.selectPrompt')}</p>
          )}
        </div>
      </div>

      </div>

      <SettingsDialog open={manageOpen} onClose={() => setManageOpen(false)} scope="admin" initialPanel="users" />
    </main>
  );
}
