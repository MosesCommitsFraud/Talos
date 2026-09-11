import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adminResetPassword,
  adminSetDisplayName,
  createUser,
  deleteUser,
  fetchAuthStatus,
  fetchModels,
  fetchUsers,
  setUserAdmin,
  setUserPrivileges,
  toggleSignup,
  type AppUser,
  type UserPrivileges,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Page, Row, Section } from '../SettingsDialog';
import { Input, Switch } from '../ui/misc';

/* Mirrors the legacy admin panel's privilege keys (static/js/admin.js);
   labels come from i18n at settings.users.priv.<key>. */
const PRIV_KEYS: Array<keyof UserPrivileges> = [
  'can_use_agent',
  'can_use_browser',
  'can_use_documents',
  'can_use_research',
  'can_generate_images',
  'can_manage_memory',
];

/* Tool-group privileges (src/tool_security.py TOOL_PRIVILEGE_GROUPS). Kept in
   their own section because these hand out capability rather than switch a
   feature on: the shell runs code, the vault holds credentials. Each carries a
   hint naming the tools it covers, so an admin isn't guessing what a toggle
   does. Order runs least to most privileged. */
const TOOL_PRIV_KEYS: Array<keyof UserPrivileges> = [
  'can_use_shell',
  'can_use_files',
  'can_search_chats',
  'can_use_mcp',
  'can_use_vault',
  'can_manage_instance',
];

/** Compact row used inside an expanded user card's privileges sub-panel. */
function MiniRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Flat list of selectable model ids across online endpoints (legacy parity:
 *  offline endpoints are skipped, display name is the id's last segment). */
function useAllModels(enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['models'],
    queryFn: fetchModels,
    enabled,
    staleTime: 60_000,
  });
  return (data ?? [])
    .filter((ep) => ep.is_enabled)
    .flatMap((ep) => ep.models.map((mid) => ({ mid, epName: ep.name, display: mid.split('/').pop() ?? mid })));
}

function AllowedModels({ user, onSaved, readOnly }: { user: AppUser; onSaved: () => void; readOnly?: boolean }) {
  const { t } = useTranslation();
  const allModels = useAllModels(true);
  const stored = user.privileges?.allowed_models ?? [];
  // Empty stored list = no restrictions = everything checked.
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(stored.length === 0 ? allModels.map((m) => m.mid) : stored),
  );
  // When the models query resolves after mount with "no restrictions", check everything.
  const effectiveChecked = stored.length === 0 && checked.size === 0 ? new Set(allModels.map((m) => m.mid)) : checked;

  const save = (next: Set<string>) => {
    if (readOnly) return;
    setChecked(next);
    // All checked ⇒ persist [] = unrestricted (legacy semantics).
    const value = next.size === allModels.length ? [] : [...next];
    void setUserPrivileges(user.username, { allowed_models: value }).then(onSaved).catch(() => {});
  };
  const toggle = (mid: string) => {
    const next = new Set(effectiveChecked);
    if (next.has(mid)) next.delete(mid);
    else next.add(mid);
    save(next);
  };

  const unrestricted = stored.length === 0;
  return (
    <div className="pt-2">
      <div className="flex items-center justify-between">
        <span className="text-sm">{t('settings.users.allowedModels')}</span>
        {!readOnly && (
          <div className="flex gap-3 text-xs">
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => save(new Set(allModels.map((m) => m.mid)))}>{t('settings.users.all')}</button>
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => save(new Set())}>{t('settings.users.none')}</button>
          </div>
        )}
      </div>
      <div className="pb-1 text-xs text-muted-foreground">
        {unrestricted ? t('settings.users.unrestricted') : t('settings.users.restricted', { count: stored.length })}
      </div>
      {allModels.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('settings.users.noModels')}</div>
      ) : (
        <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border bg-background p-1.5">
          {allModels.map((m) => (
            <label key={m.mid} className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 text-sm', readOnly ? 'opacity-70' : 'cursor-pointer hover:bg-accent/60')} title={m.mid}>
              <input type="checkbox" checked={effectiveChecked.has(m.mid)} disabled={readOnly} onChange={() => toggle(m.mid)} className="accent-primary" />
              <span className="min-w-0 flex-1 truncate">{m.display}</span>
              <span className="text-[10px] text-muted-foreground">{m.epName}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** `readOnly` is used for admin accounts: the server refuses to change an
 *  admin's privileges (core/auth.py set_privileges — admins always have full
 *  access), so the controls are shown inert rather than hidden. Hiding them
 *  made admin rows un-openable, which reads as "I can't look at other admins"
 *  when the real rule is only "I can't edit them". */
function PrivilegesPanel({ user, onSaved, readOnly }: {
  user: AppUser;
  onSaved: () => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(String(user.privileges?.max_messages_per_day ?? 0));
  const savePriv = (patch: UserPrivileges) =>
    void setUserPrivileges(user.username, patch).then(onSaved).catch(() => {});
  return (
    <div className="border-t px-3 pt-2 pb-3">
      {readOnly && (
        <p className="pt-1.5 pb-1 text-xs text-muted-foreground">{t('settings.users.adminReadOnly')}</p>
      )}
      <div className="pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t('settings.users.features')}</div>
      {PRIV_KEYS.map((key) => (
        <MiniRow key={key} label={t(`settings.users.priv.${key}`)}>
          <Switch
            checked={!!user.privileges?.[key]}
            disabled={readOnly}
            className={cn(readOnly && 'cursor-default opacity-70')}
            onCheckedChange={(v) => savePriv({ [key]: v })}
          />
        </MiniRow>
      ))}
      <div className="pt-2 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t('settings.users.tools')}</div>
      {TOOL_PRIV_KEYS.map((key) => (
        <MiniRow key={key} label={t(`settings.users.priv.${key}`)} hint={t(`settings.users.privHint.${key}`)}>
          <Switch
            checked={!!user.privileges?.[key]}
            disabled={readOnly}
            className={cn(readOnly && 'cursor-default opacity-70')}
            onCheckedChange={(v) => savePriv({ [key]: v })}
          />
        </MiniRow>
      ))}
      <div className="pt-2 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t('settings.users.limits')}</div>
      <MiniRow
        label={t('settings.users.dailyLimit')}
        hint={readOnly ? t('settings.users.noLimit') : t('settings.users.dailyLimitHint')}
      >
        <Input
          type="number"
          min={0}
          value={limit}
          readOnly={readOnly}
          disabled={readOnly}
          onChange={(e) => setLimit(e.target.value)}
          onBlur={() => savePriv({ max_messages_per_day: Math.max(0, parseInt(limit, 10) || 0) })}
          className={cn('w-20 text-center', readOnly && 'opacity-70')}
        />
      </MiniRow>
      <AllowedModels user={user} onSaved={onSaved} readOnly={readOnly} />
    </div>
  );
}

function UserRow({ user, currentUser, adminCount, onChanged }: {
  user: AppUser;
  currentUser?: string;
  adminCount: number;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const isSelf = user.username === (currentUser ?? '').toLowerCase();
  // Server blocks self-demote and last-admin demote; hiding the button is clearer.
  const canDemote = user.is_admin && !isSelf && adminCount > 1;

  const setAdmin = (makeAdmin: boolean) => {
    const msg = makeAdmin
      ? t('settings.users.makeAdminConfirm', { name: user.username })
      : t('settings.users.demoteConfirm', { name: user.username });
    if (!window.confirm(msg)) return;
    void setUserAdmin(user.username, makeAdmin).then(onChanged).catch((e) => window.alert((e as Error).message));
  };
  const remove = () => {
    if (!window.confirm(t('settings.users.removeConfirm', { name: user.username }))) return;
    void deleteUser(user.username).then(onChanged).catch((e) => window.alert((e as Error).message));
  };
  // "Rename" here means the display name only. The login username is an
  // ownership key (session/document owner columns, prefs keys, sandbox
  // workspace directories), so changing it is an account migration, not a
  // relabel — it is deliberately not offered as a one-click admin action.
  const rename = () => {
    const next = window.prompt(
      t('settings.users.displayNamePrompt', { name: user.username }),
      user.display_name ?? '',
    );
    if (next === null || next.trim() === (user.display_name ?? '')) return;
    void adminSetDisplayName(user.username, next.trim())
      .then(() => {
        onChanged();
        // Editing your own name must also refresh the sidebar/account header.
        if (isSelf) void queryClient.invalidateQueries({ queryKey: ['auth'] });
      })
      .catch((e) => window.alert((e as Error).message));
  };
  const resetPassword = () => {
    const next = (window.prompt(t('settings.users.resetPasswordPrompt', { name: user.username })) ?? '').trim();
    if (!next) return;
    if (next.length < 8) { window.alert(t('settings.users.passwordTooShort')); return; }
    void adminResetPassword(user.username, next)
      .then(() => window.alert(t('settings.users.passwordResetDone', { name: user.username })))
      .catch((e) => window.alert((e as Error).message));
  };

  return (
    <div className="rounded-lg border bg-background">
      <div
        className="flex cursor-pointer items-center gap-3 px-3 py-2"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
          {(user.display_name || user.username).slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm">{user.display_name || user.username}</span>
          {user.is_admin
            && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-primary">{t('settings.users.admin')}</span>}
          <div className="truncate text-[10px] text-muted-foreground">
            {user.display_name ? user.username : t('settings.users.manageHint')}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={rename}>{t('settings.users.rename')}</Button>
          <Button variant="outline" size="sm" onClick={resetPassword}>{t('settings.users.resetPassword')}</Button>
          {user.is_admin
            ? canDemote && <Button variant="outline" size="sm" onClick={() => setAdmin(false)}>{t('settings.users.demote')}</Button>
            : <Button variant="outline" size="sm" onClick={() => setAdmin(true)}>{t('settings.users.makeAdmin')}</Button>}
          {!user.is_admin && (
            <button
              type="button"
              aria-label={t('settings.users.deleteUser', { name: user.username })}
              onClick={remove}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive-foreground"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          )}
          <ChevronDownIcon className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </div>
      </div>
      {open && <PrivilegesPanel user={user} onSaved={onChanged} readOnly={user.is_admin} />}
    </div>
  );
}

export function UsersPanel({ currentUser }: { currentUser?: string }) {
  const { t } = useTranslation();
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: fetchUsers });
  const { data: status, refetch: refetchStatus } = useQuery({ queryKey: ['auth-status'], queryFn: fetchAuthStatus });
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['users'] });
  const adminCount = (users ?? []).filter((u) => u.is_admin).length;
  const create = useMutation({
    mutationFn: () => createUser(username.trim(), password, isAdmin, displayName.trim()),
    onSuccess: () => { setUsername(''); setDisplayName(''); setPassword(''); setIsAdmin(false); refresh(); },
  });

  return (
    <Page>
      <Section title={t('settings.users.registration')}>
        <Row label={t('settings.users.openSignup')} hint={t('settings.users.openSignupHint')}>
          <Switch checked={!!status?.signup_enabled} onCheckedChange={() => void toggleSignup().then(() => refetchStatus())} />
        </Row>
      </Section>

      <Section title={t('settings.users.usersTitle')} padded>
        <div className="space-y-1.5">
          {(users ?? []).map((u) => (
            <UserRow key={u.username} user={u} currentUser={currentUser} adminCount={adminCount} onChanged={refresh} />
          ))}
        </div>
      </Section>

      <Section title={t('settings.users.addUser')} padded>
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input placeholder={t('settings.users.email')} type="email" value={username} onChange={(e) => setUsername(e.target.value)} />
            <Input placeholder={t('settings.users.displayName')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <Input placeholder={t('settings.users.passwordMin')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={isAdmin} onCheckedChange={setIsAdmin} /> {t('settings.users.administrator')}
          </label>
          <Button size="sm" disabled={!username.trim() || password.length < 8 || create.isPending} onClick={() => create.mutate()}>
            <PlusIcon /> {t('settings.users.createUser')}
          </Button>
          {create.isError && <p className="text-xs text-destructive-foreground">{(create.error as Error).message}</p>}
        </div>
      </Section>
    </Page>
  );
}
