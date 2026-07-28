import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchUsageOverview, fetchUsers, type AppUser, type UsageUserRow } from '@/api/client';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { useAuth } from '../auth/AuthGate';
import { SettingsDialog } from '../SettingsDialog';
import { SearchInput } from '../ui/search';
import { Tile, useNum } from './parts';
import { UserDetail } from './UserDetail';

/** Windows the whole workspace is scoped to. `0` = all time, matching the
 *  home screen's range selector (components/Welcome.tsx). */
const RANGES = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: 'all', days: 0 },
] as const;

function UserRow({ row, selected, onSelect }: {
  row: UsageUserRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const { compact } = useNum();
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
        {(row.display_name || row.username).slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{row.display_name || row.username}</div>
        <div className="truncate text-[10px] text-muted-foreground">
          {row.turns > 0
            ? t('users.list.summary', { tokens: compact(row.total_tokens), turns: row.turns })
            : t('users.list.idle')}
        </div>
      </div>
      {row.is_admin && (
        <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-primary">
          {t('settings.users.admin')}
        </span>
      )}
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
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]);
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

  return (
    <main className="flex min-w-0 flex-1 overflow-hidden">
      {/* Left: user list + window selector. */}
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 px-2.5 pt-3 pb-2">
          <button
            type="button"
            onClick={() => setView('chat')}
            aria-label={t('users.backToChat')}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{t('users.title')}</h1>
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            aria-label={t('users.manageAccounts')}
            title={t('users.manageAccounts')}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <SettingsIcon className="size-4" />
          </button>
        </div>
        <div className="px-2.5 pb-2">
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('users.searchPlaceholder')}
            aria-label={t('users.searchPlaceholder')}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {visible.map((row) => (
            <UserRow
              key={row.username}
              row={row}
              selected={row.username === active?.username}
              onSelect={() => setSelected(row.username)}
            />
          ))}
          {visible.length === 0 && (
            <div className="px-2.5 py-8 text-center text-xs text-muted-foreground">{t('users.noResults')}</div>
          )}
        </div>
        {/* Deployment totals — the baseline every per-user number is read against. */}
        {overview && (
          <div className="border-t px-2.5 py-2.5">
            <div className="pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t('users.deployment')}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Tile label={t('users.tiles.activeUsers')} value={num(overview.totals.active_users)} />
              <Tile label={t('users.tiles.totalTokens')} value={compact(overview.totals.total_tokens)} />
              <Tile label={t('users.tiles.turns')} value={num(overview.totals.turns)} />
              <Tile label={t('users.tiles.toolCalls')} value={num(overview.totals.tool_calls)} />
            </div>
          </div>
        )}
      </div>

      {/* Right: the selected user's detail. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="relative z-20 shrink-0 bg-transparent">
          <div className="mx-auto flex w-full max-w-4xl items-center justify-end gap-1 px-5 py-3">
            <div className="flex shrink-0 gap-1 rounded-lg bg-muted/50 p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    'rounded-md px-2 py-0.5 text-xs transition-colors',
                    range.key === r.key
                      ? 'bg-background font-medium shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`users.range.${r.key}`)}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,black_24px)] [mask-image:linear-gradient(to_bottom,transparent_0,black_24px)]">
          <div className="mx-auto w-full max-w-4xl px-5 pt-2 pb-5">
            {activeAccount ? (
              <UserDetail user={activeAccount} days={range.days} onManage={() => setManageOpen(true)} />
            ) : (
              <p className="pt-10 text-center text-sm text-muted-foreground">{t('users.selectPrompt')}</p>
            )}
          </div>
        </div>
      </div>

      <SettingsDialog open={manageOpen} onClose={() => setManageOpen(false)} scope="admin" initialPanel="users" />
    </main>
  );
}
