import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BotIcon,
  ChevronRightIcon,
  DatabaseIcon,
  KeyboardIcon,
  Link2Icon,
  LogOutIcon,
  PaletteIcon,
  PlusIcon,
  ServerIcon,
  SettingsIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  addModelEndpoint,
  changePassword,
  createIntegration,
  deleteIntegration,
  discoverEndpoints,
  fetchAppSettings,
  fetchBuiltinTools,
  fetchIntegrationPresets,
  fetchIntegrations,
  fetchModels,
  fetchRagConfig,
  fetchSqlConfig,
  fetchTotpStatus,
  importData,
  logout,
  personalAddDirectory,
  personalReload,
  personalUpload,
  ragSearch,
  saveAppSettings,
  saveDisabledTools,
  saveRagConfig,
  saveSqlConfig,
  deleteSqlConfig,
  testSqlConfig,
  testModelEndpoint,
  testRagConfig,
  totpConfirm,
  totpDisable,
  totpSetup,
  updateIntegration,
  wipeData,
  type AppSettings,
  type RagConfig,
  type SqlConfig,
} from '@/api/client';
import { applyDensity, applyTheme, usePrefs, type Density, type Theme, type Visibility } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input, Switch } from './ui/misc';
import { useAuth } from './auth/AuthGate';
import { UsersPanel } from './settings/UsersPanel';

type Panel =
  | 'appearance' | 'shortcuts' | 'account'
  | 'models' | 'ai' | 'integrations' | 'tools' | 'rag' | 'users' | 'system';

/* ── Shared layout (t3code settings design) ── */

/** Scrollable page body: stacks sections with generous spacing. */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-7 p-5 sm:p-6', className)}>{children}</div>;
}

/** A titled card group. Rows go inside as direct children (self-bordered);
 *  free-form content can opt into padding with `padded`. */
export function Section({ title, action, padded, children }: { title: string; action?: React.ReactNode; padded?: boolean; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <header className="flex min-h-5 items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-foreground/50 uppercase">
          <span className="inline-block h-px w-3 bg-border" aria-hidden="true" />
          {title}
        </h2>
        {action && <div className="flex items-center">{action}</div>}
      </header>
      <div className={cn('overflow-hidden rounded-2xl border bg-card text-card-foreground', padded && 'p-4 sm:p-5')}>
        {children}
      </div>
    </section>
  );
}

/** Just the section header (uppercase tracked label), for panels that render
 *  their own cards instead of using a Section wrapper. */
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 px-1 text-[11px] font-semibold tracking-[0.08em] text-foreground/50 uppercase">
      <span className="inline-block h-px w-3 bg-border" aria-hidden="true" />
      {children}
    </h2>
  );
}

/** A single setting row: title + description on the left, control on the right.
 *  Rows separate themselves with a top border so they read as a grouped list. */
export function Row({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">{label}</div>
        {hint && <p className="text-xs text-muted-foreground/80">{hint}</p>}
      </div>
      {children && <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">{children}</div>}
    </div>
  );
}

function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label?: string }>; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn('h-8 rounded-lg border border-input bg-popover px-2 text-sm outline-none focus-visible:border-ring', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label ?? (o.value || '—')}</option>
      ))}
    </select>
  );
}

function SaveBar({ dirty, saving, error, onSave }: { dirty: boolean; saving: boolean; error?: string; onSave: () => void }) {
  if (!dirty && !error) return null;
  return (
    <div className="sticky bottom-0 -mx-5 -mb-5 mt-1 flex items-center justify-end gap-3 border-t bg-popover/95 px-5 py-3 backdrop-blur-sm sm:-mx-6 sm:-mb-6 sm:px-6">
      {error && <span className="min-w-0 flex-1 truncate text-xs text-destructive-foreground">{error}</span>}
      <Button size="sm" disabled={saving || !dirty} onClick={onSave}>
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}

/** Draft editing over the flat /api/auth/settings dict; Save POSTs changed keys. */
function useSettingsDraft() {
  const { data } = useQuery({ queryKey: ['app-settings'], queryFn: fetchAppSettings });
  const [draft, setDraft] = useState<AppSettings>({});
  const queryClient = useQueryClient();
  const value = (key: string) => (key in draft ? draft[key] : data?.[key]);
  const setValue = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }));
  const dirty = Object.keys(draft).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(data?.[k]));
  const save = useMutation({
    mutationFn: () => saveAppSettings(draft),
    onSuccess: () => {
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ['app-settings'] });
    },
  });
  return { ready: !!data, value, setValue, dirty, save };
}
type Draft = ReturnType<typeof useSettingsDraft>;

function BoolRow({ s, k, label, hint }: { s: Draft; k: string; label: string; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={!!s.value(k)} onCheckedChange={(v) => s.setValue(k, v)} />
    </Row>
  );
}

function TextRow({ s, k, label, hint, placeholder, type, width }: { s: Draft; k: string; label: string; hint?: string; placeholder?: string; type?: string; width?: string }) {
  return (
    <Row label={label} hint={hint}>
      <Input
        type={type}
        className={width ?? 'w-56'}
        placeholder={placeholder}
        value={String(s.value(k) ?? '')}
        onChange={(e) => s.setValue(k, type === 'number' ? Number(e.target.value) : e.target.value)}
      />
    </Row>
  );
}

/* ── Endpoint + model pickers (Default/Utility models) ── */

function useEndpoints() {
  const { data } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  return (data ?? []).filter((e) => e.is_enabled && e.model_type !== 'embedding');
}

function EndpointModelRows({ s, epKey, modelKey, label }: { s: Draft; epKey: string; modelKey: string; label: string }) {
  const endpoints = useEndpoints();
  const epId = String(s.value(epKey) ?? '');
  const models = endpoints.find((e) => e.id === epId)?.models ?? endpoints.flatMap((e) => e.models);
  return (
    <>
      <Row label={`${label} endpoint`}>
        <Select
          className="w-56"
          value={epId}
          onChange={(v) => s.setValue(epKey, v)}
          options={[{ value: '', label: '—' }, ...endpoints.map((e) => ({ value: e.id, label: e.name }))]}
        />
      </Row>
      <Row label={`${label} model`}>
        <Select
          className="w-56"
          value={String(s.value(modelKey) ?? '')}
          onChange={(v) => s.setValue(modelKey, v)}
          options={[{ value: '', label: '—' }, ...models.map((m) => ({ value: m }))]}
        />
      </Row>
    </>
  );
}

/** Vision model — legacy offers "Auto-detect" ('' value) plus every model. */
function VisionModelRow({ s }: { s: Draft }) {
  const endpoints = useEndpoints();
  const models = endpoints.flatMap((e) => e.models);
  return (
    <Row label="Vision model">
      <Select
        className="w-56"
        value={String(s.value('vision_model') ?? '')}
        onChange={(v) => s.setValue('vision_model', v)}
        options={[{ value: '', label: 'Auto-detect' }, ...models.map((m) => ({ value: m }))]}
      />
    </Row>
  );
}

interface Fallback { endpoint_id: string; model: string }

function FallbacksEditor({ s, k }: { s: Draft; k: string }) {
  const endpoints = useEndpoints();
  const list: Fallback[] = Array.isArray(s.value(k)) ? (s.value(k) as Fallback[]) : [];
  const allModels = endpoints.flatMap((e) => e.models.map((model) => ({ endpoint_id: e.id, model, name: e.name })));
  return (
    <div className="space-y-1.5 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="text-xs text-muted-foreground">Fallbacks (tried in order when the primary fails)</div>
      {list.map((f, i) => (
        <div key={`${f.endpoint_id}:${f.model}:${i}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-lg border bg-card px-2.5 py-1 text-xs">
            {f.model} <span className="text-muted-foreground">· {endpoints.find((e) => e.id === f.endpoint_id)?.name ?? f.endpoint_id}</span>
          </span>
          <button
            type="button"
            aria-label="Remove fallback"
            onClick={() => s.setValue(k, list.filter((_, j) => j !== i))}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <Select
        className="w-full"
        value=""
        onChange={(v) => {
          const found = allModels.find((m) => `${m.endpoint_id}:${m.model}` === v);
          if (found) s.setValue(k, [...list, { endpoint_id: found.endpoint_id, model: found.model }]);
        }}
        options={[
          { value: '', label: '+ Add fallback…' },
          ...allModels.map((m) => ({ value: `${m.endpoint_id}:${m.model}`, label: `${m.model} · ${m.name}` })),
        ]}
      />
    </div>
  );
}

/* ── Appearance (theme/density + UI visibility, mirrors legacy sections) ── */

function SegmentPicker<T extends string>({ options, current, onPick }: { options: Array<{ value: T; label: string }>; current: T; onPick: (v: T) => void }) {
  return (
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onPick(o.value)}
          className={cn(
            'flex-1 rounded-lg border px-3 py-2 text-sm transition-colors',
            current === o.value ? 'border-ring bg-accent font-medium' : 'hover:bg-accent/60',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const VISIBILITY_SECTIONS: Array<{ title: string; items: Array<{ key: keyof Visibility; label: string; hint?: string }> }> = [
  {
    title: 'Sidebar',
    items: [
      { key: 'sidebarBrain', label: 'Brain' },
      { key: 'sidebarLibrary', label: 'Library' },
      { key: 'sidebarUserBar', label: 'User', hint: 'Avatar & name' },
      { key: 'sidebarSettingsBtn', label: 'Settings Button', hint: 'Cog next to user' },
    ],
  },
  {
    title: 'Chat Area',
    items: [
      { key: 'chatHeader', label: 'Session Header', hint: 'Title, export & files above chat' },
      { key: 'welcomeText', label: 'Welcome Message', hint: 'Logo & greeting on empty chat' },
      { key: 'showThinking', label: 'Thinking Process', hint: 'Collapsible reasoning rows' },
      { key: 'incognitoBtn', label: 'Incognito Mode', hint: 'No memory, no history saved' },
      { key: 'messageMetrics', label: 'Response Metrics', hint: 'tok/s & time under replies' },
    ],
  },
  {
    title: 'Chat Bar',
    items: [
      { key: 'composerAttach', label: 'Attach Files' },
      { key: 'composerPlan', label: 'Plan Toggle' },
      { key: 'composerDocs', label: 'Docs (RAG) Toggle' },
      { key: 'composerDb', label: 'Database Toggle' },
      { key: 'composerModelPicker', label: 'Model Picker' },
      { key: 'contextMeter', label: 'Context Window Meter' },
    ],
  },
];

function AppearancePanel() {
  const prefs = usePrefs();
  return (
    <Page>
      <Section title="Theme" padded>
        <SegmentPicker<Theme>
          options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
          current={prefs.theme}
          onPick={(t) => { prefs.setTheme(t); applyTheme(t); }}
        />
      </Section>
      <Section title="Density" padded>
        <SegmentPicker<Density>
          options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }]}
          current={prefs.density}
          onPick={(d) => { prefs.setDensity(d); applyDensity(d); }}
        />
      </Section>
      {VISIBILITY_SECTIONS.map((sec) => (
        <Section key={sec.title} title={sec.title}>
          {sec.items.map((it) => (
            <Row key={it.key} label={it.label} hint={it.hint}>
              <Switch checked={prefs.visibility[it.key]} onCheckedChange={(v) => prefs.setVisibility(it.key, v)} />
            </Row>
          ))}
        </Section>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={prefs.resetVisibility}>Reset visibility</Button>
      </div>
    </Page>
  );
}

/* ── Shortcuts (editable keybinds from settings.keybinds) ── */

const KEYBIND_LABELS: Record<string, string> = {
  search: 'Search chats & actions',
  toggle_sidebar: 'Toggle sidebar',
  new_session: 'New chat',
  star_session: 'Star current chat',
  delete_session: 'Delete current chat',
  admin_panel: 'Open settings',
  cancel: 'Stop generating / cancel',
};

function ShortcutsPanel() {
  const s = useSettingsDraft();
  const binds = (s.value('keybinds') ?? {}) as Record<string, string>;
  if (!s.ready) return <Page><p className="text-sm text-muted-foreground">Loading…</p></Page>;
  return (
    <Page>
      <Section title="Keyboard Shortcuts">
        {Object.entries(KEYBIND_LABELS).map(([key, label]) => (
          <Row key={key} label={label}>
            <Input
              className="w-44 text-center font-mono text-xs"
              value={binds[key] ?? ''}
              placeholder="unset"
              onKeyDown={(e) => {
                e.preventDefault();
                if (e.key === 'Tab') return;
                const parts = [
                  e.ctrlKey && 'ctrl', e.metaKey && 'meta', e.altKey && 'alt', e.shiftKey && 'shift',
                ].filter(Boolean) as string[];
                const k = e.key.toLowerCase();
                if (!['control', 'meta', 'alt', 'shift'].includes(k)) parts.push(k);
                s.setValue('keybinds', { ...binds, [key]: parts.join('+') });
              }}
              onChange={() => { /* set via onKeyDown capture */ }}
            />
          </Row>
        ))}
      </Section>
      <p className="-mt-3 px-1 text-xs text-muted-foreground">Click a field and press the new key combination.</p>
      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </Page>
  );
}

/* ── Account: password change + 2FA + logout ── */

function AccountPanel() {
  const auth = useAuth();
  const { data: totp, refetch: refetchTotp } = useQuery({ queryKey: ['totp'], queryFn: fetchTotpStatus });
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [setup, setSetup] = useState<{ secret: string; qr_code: string } | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState('');
  const [totpMsg, setTotpMsg] = useState('');

  const savePassword = async () => {
    setPwMsg('');
    if (!pw.next || pw.next !== pw.confirm) { setPwMsg('New passwords do not match'); return; }
    try {
      await changePassword(pw.current, pw.next);
      setPw({ current: '', next: '', confirm: '' });
      setPwMsg('Password changed');
    } catch (e) { setPwMsg((e as Error).message); }
  };

  return (
    <Page>
      <Section title="Account" padded>
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {(auth?.username ?? 'U').slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium">{auth?.username ?? 'User'}</div>
          <div className="text-xs text-muted-foreground">
            {auth?.is_admin ? 'Administrator' : 'Member'}
            {auth?.auth_enabled === false && ' · auth disabled'}
          </div>
        </div>
        {auth?.auth_enabled !== false && (
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            <LogOutIcon /> Log out
          </Button>
        )}
      </div>
      </Section>

      <Section title="Change Password" padded>
      <div className="space-y-2">
        <Input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        <Input type="password" placeholder="New password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        <Input type="password" placeholder="Confirm new password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!pw.current || !pw.next} onClick={() => void savePassword()}>Change password</Button>
          {pwMsg && <span className={cn('text-xs', pwMsg === 'Password changed' ? 'text-success' : 'text-destructive-foreground')}>{pwMsg}</span>}
        </div>
      </div>
      </Section>

      <Section title="Two-Factor Authentication" padded>
      {totp?.enabled ? (
        <div className="space-y-2">
          <p className="text-xs text-success">2FA is enabled.</p>
          <div className="flex items-center gap-2">
            <Input type="password" placeholder="Password to disable" className="w-56" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
            <Button size="sm" variant="destructive" disabled={!disablePw} onClick={() => {
              void totpDisable(disablePw).then(() => { setDisablePw(''); setTotpMsg(''); void refetchTotp(); }).catch((e) => setTotpMsg((e as Error).message));
            }}>Disable</Button>
          </div>
        </div>
      ) : setup ? (
        <div className="space-y-2">
          <img src={setup.qr_code} alt="2FA QR code" className="size-40 rounded-lg border bg-white p-1.5" />
          <p className="text-xs text-muted-foreground">Scan with your authenticator, or enter the secret manually: <code className="font-mono">{setup.secret}</code></p>
          <div className="flex items-center gap-2">
            <Input placeholder="6-digit code" className="w-32" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button size="sm" disabled={code.length < 6} onClick={() => {
              void totpConfirm(code).then((r) => { setBackupCodes(r.backup_codes); setSetup(null); setCode(''); void refetchTotp(); }).catch((e) => setTotpMsg((e as Error).message));
            }}>Confirm</Button>
          </div>
        </div>
      ) : backupCodes ? (
        <div className="space-y-1.5">
          <p className="text-xs text-success">2FA enabled. Save these backup codes:</p>
          <pre className="rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{backupCodes.join('\n')}</pre>
          <Button size="sm" variant="outline" onClick={() => setBackupCodes(null)}>Done</Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => { void totpSetup().then(setSetup).catch((e) => setTotpMsg((e as Error).message)); }}>
          Enable 2FA
        </Button>
      )}
      {totpMsg && <p className="pt-1 text-xs text-destructive-foreground">{totpMsg}</p>}
      </Section>
    </Page>
  );
}

/* ── Add Models (legacy "services") ── */

function AddModelsPanel() {
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState('llm');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState('');
  const queryClient = useQueryClient();
  const { data: endpoints } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['models'] });

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg('');
    try { await fn(); setMsg(ok); refresh(); } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <Page>
      <Section title="Add endpoint" padded>
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <Input placeholder="Base URL, e.g. http://192.168.10.91:8000/v1" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Select value={kind} onChange={setKind} options={[{ value: 'llm', label: 'LLM' }, { value: 'image', label: 'Image' }]} />
          </div>
          <Input placeholder="API key (optional)" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!url.trim()} onClick={() => void run(() => addModelEndpoint({ baseUrl: url, apiKey: apiKey || undefined, modelType: kind }), 'Endpoint added')}>
              <PlusIcon /> Add
            </Button>
            <Button size="sm" variant="outline" disabled={!url.trim()} onClick={() => void run(() => testModelEndpoint(url, apiKey || undefined), 'Connection OK')}>
              Test
            </Button>
            <Button size="sm" variant="outline" onClick={() => void run(() => discoverEndpoints(), 'Discovery finished')}>
              Discover local
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setUrl('http://localhost:11434'); setKind('llm'); }}>
              Ollama preset
            </Button>
          </div>
          {msg && <p className={cn('text-xs', /OK|added|finished/i.test(msg) ? 'text-success' : 'text-destructive-foreground')}>{msg}</p>}
        </div>
      </Section>

      <Section title="Configured endpoints" padded>
        <div className="space-y-1.5">
          {(endpoints ?? []).map((e) => (
            <div key={e.id} className="flex items-center justify-between rounded-lg border bg-background px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm">{e.name}</div>
                <div className="truncate text-xs text-muted-foreground">{e.base_url} · {e.models.length} model{e.models.length === 1 ? '' : 's'}</div>
              </div>
              <span className={cn('text-xs', e.is_enabled ? 'text-success' : 'text-muted-foreground')}>
                {e.is_enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
          ))}
          {(endpoints ?? []).length === 0 && <p className="text-xs text-muted-foreground">No endpoints yet.</p>}
        </div>
      </Section>

      <ModelDisplayNamesSection />
    </Page>
  );
}

/** Admin-set, global custom display names for models. Persisted in app
 *  settings (model_display_names), so it applies for every user. */
function ModelDisplayNamesSection() {
  const s = useSettingsDraft();
  const { data: endpoints } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const names = (s.value('model_display_names') ?? {}) as Record<string, string>;
  const models = Array.from(
    new Set(
      (endpoints ?? [])
        .filter((e) => e.is_enabled && e.model_type !== 'embedding')
        .flatMap((e) => e.models),
    ),
  );
  const setName = (model: string, v: string) => {
    const next = { ...names };
    if (v.trim()) next[model] = v;
    else delete next[model];
    s.setValue('model_display_names', next);
  };

  return (
    <>
      <Section title="Model Display Names">
        {models.length === 0 && <Row label={<span className="font-normal text-muted-foreground">No models available</span>} />}
        {models.map((model) => (
          <Row key={model} label={model}>
            <Input
              className="w-56"
              placeholder={model}
              value={names[model] ?? ''}
              onChange={(e) => setName(model, e.target.value)}
            />
          </Row>
        ))}
      </Section>
      <p className="-mt-3 px-1 text-xs text-muted-foreground">
        Sets the label shown to <span className="font-medium text-foreground/80">every user</span> in the model picker. Leave blank to use the raw model id.
      </p>
      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </>
  );
}

/* ── AI Defaults (full legacy AI tab) ── */

function AiDefaultsPanel() {
  const s = useSettingsDraft();
  if (!s.ready) return <Page><p className="text-sm text-muted-foreground">Loading…</p></Page>;
  return (
    <Page>
      <Section title="Default Chat Model">
        <EndpointModelRows s={s} epKey="default_endpoint_id" modelKey="default_model" label="Default" />
        <FallbacksEditor s={s} k="default_model_fallbacks" />
      </Section>

      <Section title="Utility Model">
        <Row label="Utility model" hint="Small fast model for titles, summaries and background jobs. Recommended: local endpoint." />
        <EndpointModelRows s={s} epKey="utility_endpoint_id" modelKey="utility_model" label="Utility" />
        <FallbacksEditor s={s} k="utility_model_fallbacks" />
      </Section>

      <Section title="Context Management">
        <TextRow s={s} k="compact_threshold" label="Auto-compact at" hint="Fraction of the context window (0.3–0.95)" width="w-24" />
        <BoolRow s={s} k="context_compression" label="Tool output compression" hint="Headroom-style compression of large tool outputs" />
      </Section>

      <Section title="Vision">
        <BoolRow s={s} k="vision_enabled" label="Vision enabled" />
        <VisionModelRow s={s} />
        <FallbacksEditor s={s} k="vision_model_fallbacks" />
      </Section>

      <Section title="Agent">
        <TextRow s={s} k="agent_max_tool_calls" label="Tool call limit" hint="0 = unlimited" type="number" width="w-24" />
        <TextRow s={s} k="agent_max_rounds" label="Max steps per message" type="number" width="w-24" />
      </Section>

      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </Page>
  );
}

/* ── Integrations (web search + integration CRUD) ── */

function IntegrationsPanel() {
  const { data: integrations } = useQuery({ queryKey: ['integrations'], queryFn: fetchIntegrations });
  const { data: presets } = useQuery({ queryKey: ['intg-presets'], queryFn: fetchIntegrationPresets });
  const [preset, setPreset] = useState('');
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '' });
  const [msg, setMsg] = useState('');
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['integrations'] });

  const presetEntries = Object.entries(presets ?? {});

  const add = async () => {
    setMsg('');
    try {
      await createIntegration({ ...(preset ? { preset } : {}), ...form });
      setForm({ name: '', base_url: '', api_key: '' });
      setPreset('');
      refresh();
    } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <Page>
      <Section title="Integrations" padded>
        <p className="pb-2 text-xs text-muted-foreground">All external service connections in one place.</p>
        <div className="space-y-1.5">
          {(integrations ?? []).map((it, i) => {
            const id = String(it.id ?? i);
            return (
              <div key={id} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{String(it.name ?? id)}</div>
                  {typeof it.base_url === 'string' && it.base_url && <div className="truncate text-xs text-muted-foreground">{it.base_url}</div>}
                </div>
                <Switch
                  checked={!!it.enabled}
                  onCheckedChange={(v) => void updateIntegration(id, { enabled: v }).then(refresh).catch((e) => setMsg((e as Error).message))}
                />
                <button
                  type="button"
                  aria-label={`Delete ${String(it.name ?? id)}`}
                  onClick={() => void deleteIntegration(id).then(refresh).catch((e) => setMsg((e as Error).message))}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive-foreground"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            );
          })}
          {(integrations ?? []).length === 0 && <p className="text-xs text-muted-foreground">No integrations configured.</p>}
        </div>

        <div className="space-y-2 border-t border-border/60 pt-3 mt-3">
          <div className="text-sm font-medium">Add integration</div>
          {presetEntries.length > 0 && (
            <Select
              className="w-full"
              value={preset}
              onChange={(v) => {
                setPreset(v);
                const p = (presets ?? {})[v];
                if (p) setForm((f) => ({ ...f, name: String(p.name ?? v), base_url: String(p.base_url ?? '') }));
              }}
              options={[{ value: '', label: 'Custom…' }, ...presetEntries.map(([k, p]) => ({ value: k, label: String(p.name ?? k) }))]}
            />
          )}
          <Input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input placeholder="Base URL" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
          <Input placeholder="API key" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
          <Button size="sm" disabled={!form.name.trim()} onClick={() => void add()}><PlusIcon /> Add</Button>
          {msg && <p className="text-xs text-destructive-foreground">{msg}</p>}
        </div>
      </Section>

      <SqlDatabaseSection />
    </Page>
  );
}

const SQL_DEFAULT_PORTS: Record<string, string> = { mssql: '1433', postgresql: '5432', mysql: '3306', sqlite: '' };

function SqlDatabaseSection() {
  const { data } = useQuery({ queryKey: ['sql-config'], queryFn: fetchSqlConfig });
  const [draft, setDraft] = useState<SqlConfig | null>(null);
  const [msg, setMsg] = useState('');
  const queryClient = useQueryClient();
  useEffect(() => {
    if (data && !draft) setDraft({ ...data, db_type: data.db_type || 'mssql', password: '' });
  }, [data, draft]);
  if (!draft) return <Section title="SQL Database" padded><p className="text-sm text-muted-foreground">Loading…</p></Section>;
  const set = (k: keyof SqlConfig, v: unknown) => setDraft({ ...draft, [k]: v } as SqlConfig);
  const run = (fn: () => Promise<unknown>, ok: string) => {
    setMsg('');
    fn()
      .then(() => { setMsg(ok); void queryClient.invalidateQueries({ queryKey: ['sql-config'] }); })
      .catch((e) => setMsg((e as Error).message));
  };
  return (
    <Section title="SQL Database">
      <div className="px-4 pt-3.5 text-xs text-muted-foreground sm:px-5">
        Read-only SQL database used by the <code className="font-mono">query_sql</code> tool. The password is stored
        server-side and never shown to the model.
      </div>
      <Row label="Enabled"><Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} /></Row>
      <Row label="Type">
        <Select
          className="w-56"
          value={draft.db_type}
          onChange={(v) => set('db_type', v)}
          options={[
            { value: 'mssql', label: 'MSSQL' },
            { value: 'postgresql', label: 'PostgreSQL' },
            { value: 'mysql', label: 'MySQL/MariaDB' },
            { value: 'sqlite', label: 'SQLite' },
          ]}
        />
      </Row>
      <Row label="Host"><Input className="w-56" placeholder="db.example.local" value={draft.host} onChange={(e) => set('host', e.target.value)} /></Row>
      <Row label="Port"><Input className="w-56" placeholder={SQL_DEFAULT_PORTS[draft.db_type] ?? ''} value={draft.port} onChange={(e) => set('port', e.target.value)} /></Row>
      <Row label="Database"><Input className="w-56" placeholder="Database name or SQLite path" value={draft.database} onChange={(e) => set('database', e.target.value)} /></Row>
      <Row label="Read-only user"><Input className="w-56" autoComplete="off" value={draft.username} onChange={(e) => set('username', e.target.value)} /></Row>
      <Row label="Password">
        <Input
          className="w-56" type="password" autoComplete="new-password"
          placeholder={data?.password_set ? 'Saved — leave blank to keep' : ''}
          value={draft.password ?? ''}
          onChange={(e) => set('password', e.target.value)}
        />
      </Row>
      <Row label="ODBC driver"><Input className="w-56" placeholder="ODBC Driver 18 for SQL Server" value={draft.odbc_driver} onChange={(e) => set('odbc_driver', e.target.value)} /></Row>
      <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3.5 sm:px-5">
        <Button size="sm" onClick={() => run(() => saveSqlConfig(draft), 'Saved')}>Save</Button>
        <Button size="sm" variant="outline" onClick={() => run(
          // /api/sql/test reports failures as HTTP 200 + {ok:false, error} —
          // surface them instead of showing "Connection OK" unconditionally.
          () => testSqlConfig().then((r) => { if (!r.ok) throw new Error(r.error || 'Connection failed'); }),
          'Connection OK',
        )}>Test</Button>
        <Button size="sm" variant="destructive-outline" onClick={() => {
          if (window.confirm('Remove the SQL database configuration?')) run(() => deleteSqlConfig().then(() => setDraft(null)), 'Removed');
        }}>Remove</Button>
        {msg && <span className={cn('text-xs', /Saved|OK|Removed/.test(msg) ? 'text-success' : 'text-destructive-foreground')}>{msg}</span>}
      </div>
    </Section>
  );
}

/* ── Agent Tools (built-in tool toggles, grouped by category like legacy) ── */

const TOOL_META: Record<string, { name: string; desc: string; cat: string; ctx: string }> = {
  bash: { name: 'Shell', desc: 'Execute bash commands', cat: 'Code', ctx: '~200' },
  python: { name: 'Python', desc: 'Run Python scripts', cat: 'Code', ctx: '~200' },
  read_file: { name: 'Read File', desc: 'Read files from disk', cat: 'Code', ctx: '~150' },
  write_file: { name: 'Write File', desc: 'Write/create files', cat: 'Code', ctx: '~150' },
  web_search: { name: 'Web Search', desc: 'Search the web via SearXNG', cat: 'Search', ctx: '~300' },
  search_chats: { name: 'Search Chats', desc: 'Search conversation history', cat: 'Search', ctx: '~150' },
  create_document: { name: 'Create Document', desc: 'Create new documents', cat: 'Documents', ctx: '~200' },
  update_document: { name: 'Update Document', desc: 'Modify existing documents', cat: 'Documents', ctx: '~200' },
  edit_document: { name: 'Edit Document', desc: 'Find & replace in documents', cat: 'Documents', ctx: '~200' },
  suggest_document: { name: 'Suggest Changes', desc: 'Propose document edits', cat: 'Documents', ctx: '~200' },
  manage_documents: { name: 'Manage Documents', desc: 'List, delete, organize docs', cat: 'Documents', ctx: '~150' },
  generate_image: { name: 'Generate Image', desc: 'Create images via AI', cat: 'Media', ctx: '~150' },
  manage_memory: { name: 'Memory', desc: 'Save and recall memories', cat: 'Knowledge', ctx: '~200' },
  manage_skills: { name: 'Skills', desc: 'Learn and use procedures', cat: 'Knowledge', ctx: '~200' },
  manage_rag: { name: 'RAG / Docs', desc: 'Query indexed documents', cat: 'Knowledge', ctx: '~150' },
  query_sql: { name: 'SQL Database', desc: 'Read configured SQL database', cat: 'Knowledge', ctx: '~200' },
  chat_with_model: { name: 'Chat with Model', desc: 'Talk to another AI model', cat: 'Multi-Agent', ctx: '~200' },
  second_opinion: { name: 'Second Opinion', desc: "Get another model's take", cat: 'Multi-Agent', ctx: '~150' },
  pipeline: { name: 'Pipeline', desc: 'Multi-step AI workflows', cat: 'Multi-Agent', ctx: '~200' },
  ask_teacher: { name: 'Ask Teacher', desc: 'Query a more capable model', cat: 'Multi-Agent', ctx: '~150' },
  send_to_session: { name: 'Send to Session', desc: 'Send message to another chat', cat: 'Sessions', ctx: '~100' },
  create_session: { name: 'Create Session', desc: 'Start a new chat session', cat: 'Sessions', ctx: '~100' },
  list_sessions: { name: 'List Sessions', desc: 'Browse existing sessions', cat: 'Sessions', ctx: '~100' },
  manage_session: { name: 'Manage Session', desc: 'Rename, archive, configure', cat: 'Sessions', ctx: '~100' },
  list_models: { name: 'List Models', desc: 'Show available models', cat: 'System', ctx: '~100' },
  ui_control: { name: 'UI Control', desc: 'Change theme, layout, settings', cat: 'System', ctx: '~150' },
  manage_tasks: { name: 'Tasks', desc: 'Schedule automated tasks', cat: 'System', ctx: '~150' },
  api_call: { name: 'API Call', desc: 'Make HTTP requests', cat: 'System', ctx: '~200' },
  manage_endpoints: { name: 'Endpoints', desc: 'Add/remove model endpoints', cat: 'System', ctx: '~100' },
  manage_mcp: { name: 'MCP Servers', desc: 'Manage MCP connections', cat: 'System', ctx: '~100' },
  manage_webhooks: { name: 'Webhooks', desc: 'Configure webhook events', cat: 'System', ctx: '~100' },
  manage_tokens: { name: 'API Tokens', desc: 'Manage API access tokens', cat: 'System', ctx: '~100' },
  manage_settings: { name: 'Settings', desc: 'Change app settings', cat: 'System', ctx: '~100' },
};
const TOOL_CAT_ORDER = ['Code', 'Search', 'Documents', 'Media', 'Knowledge', 'Multi-Agent', 'Sessions', 'System', 'Other'];

function ToolsPanel() {
  const { data: tools } = useQuery({ queryKey: ['builtin-tools'], queryFn: fetchBuiltinTools });
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: saveDisabledTools,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['builtin-tools'] }),
  });

  if (!tools) return <Page><p className="text-sm text-muted-foreground">Loading…</p></Page>;
  if (tools.length === 0) return <Page><p className="text-sm text-muted-foreground">No tools found.</p></Page>;

  const setEnabled = (changes: Record<string, boolean>) => {
    const disabled = tools
      .filter((t) => !(changes[t.id] ?? t.enabled))
      .map((t) => t.id);
    save.mutate(disabled);
  };

  const groups = new Map<string, Array<{ id: string; enabled: boolean; name: string; desc: string; ctx: string }>>();
  for (const t of tools) {
    const meta = TOOL_META[t.id] ?? { name: t.id, desc: '', cat: 'Other', ctx: '?' };
    if (!groups.has(meta.cat)) groups.set(meta.cat, []);
    groups.get(meta.cat)!.push({ ...t, ...meta });
  }

  return (
    <Page className="gap-2.5">
      <SectionHeader>Built-in Tools</SectionHeader>
      <p className="-mt-1.5 px-1 text-xs text-muted-foreground">Enable or disable tools available to the AI agent.</p>
      {TOOL_CAT_ORDER.filter((c) => groups.has(c)).map((cat) => {
        const items = groups.get(cat)!;
        const enabledCount = items.filter((i) => i.enabled).length;
        const open = !!openCats[cat];
        return (
          <div key={cat} className="overflow-hidden rounded-xl border bg-card">
            <div className="flex w-full items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setOpenCats((o) => ({ ...o, [cat]: !o[cat] }))}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
              >
                <ChevronRightIcon className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
                {cat}
                <span className="text-[11px] text-muted-foreground">{enabledCount}/{items.length}</span>
              </button>
              <Switch
                checked={enabledCount === items.length}
                onCheckedChange={(v) => setEnabled(Object.fromEntries(items.map((i) => [i.id, v])))}
              />
            </div>
            {open && (
              <div className="border-t">
                {items.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-3 py-2 not-last:border-b">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{t.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{t.desc}</div>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title="Approximate context tokens used">{t.ctx}</span>
                    <Switch checked={t.enabled} onCheckedChange={(v) => setEnabled({ [t.id]: v })} />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Page>
  );
}

/* ── RAG (config + documents) ── */

function RagPanel() {
  const { data } = useQuery({ queryKey: ['rag-config'], queryFn: fetchRagConfig });
  const [draft, setDraft] = useState<RagConfig | null>(null);
  const [searchQ, setSearchQ] = useState('');
  const [searchK, setSearchK] = useState(5);
  const [searchOut, setSearchOut] = useState('');
  const [dir, setDir] = useState('');
  const [docMsg, setDocMsg] = useState('');
  const queryClient = useQueryClient();
  useEffect(() => { if (data && !draft) setDraft(data); }, [data, draft]);
  const save = useMutation({
    mutationFn: (cfg: RagConfig) => saveRagConfig(cfg),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['rag-config'] }),
  });
  const test = useMutation({ mutationFn: testRagConfig });
  if (!draft) return <Page><p className="text-sm text-muted-foreground">Loading…</p></Page>;
  const set = (k: keyof RagConfig, v: unknown) => setDraft({ ...draft, [k]: v } as RagConfig);
  const text = (k: keyof RagConfig, label: string, type = 'text') => (
    <Row label={label}>
      <Input className="w-56" type={type} value={String(draft[k] ?? '')}
        onChange={(e) => set(k, type === 'number' ? Number(e.target.value) : e.target.value)} />
    </Row>
  );
  const doc = (fn: () => Promise<unknown>, ok: string) => {
    setDocMsg('');
    fn().then(() => setDocMsg(ok)).catch((e) => setDocMsg((e as Error).message));
  };
  return (
    <Page>
      <Section title="Pipeline">
        <Row label="RAG enabled"><Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} /></Row>
        {text('embedding_url', 'Embedding URL')}
        {text('embedding_model', 'Embedding model')}
        {text('qdrant_url', 'Qdrant URL')}
        {text('qdrant_api_key', 'Qdrant API key', 'password')}
        {text('rerank_url', 'Rerank URL')}
        {text('rerank_model', 'Rerank model')}
        {text('rerank_api_key', 'Rerank API key', 'password')}
        {text('chat_top_k', 'Chat top-k', 'number')}
        {text('search_top_k', 'Search top-k', 'number')}
        {text('candidate_top_k', 'Candidate top-k', 'number')}
        <div className="flex items-center gap-3 border-t border-border/60 px-4 py-3.5 sm:px-5">
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test connection'}</Button>
          {test.isSuccess && (
            <span className={cn('text-xs', test.data?.ok === false ? 'text-destructive-foreground' : 'text-success')}>
              {test.data?.ok === false ? 'Test failed' : 'OK'}
            </span>
          )}
        </div>
      </Section>

      <Section title="Documents" padded>
      <div className="space-y-2">
        <label className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => document.getElementById('rag-upload-input')?.click()}>Upload files…</Button>
          <input
            id="rag-upload-input" type="file" multiple hidden
            onChange={(e) => { if (e.target.files?.length) doc(() => personalUpload(Array.from(e.target.files!)), 'Uploaded'); e.target.value = ''; }}
          />
          <Button size="sm" variant="outline" onClick={() => doc(personalReload, 'Reindex started')}>Reload index</Button>
        </label>
        <div className="flex gap-2">
          <Input placeholder="Add directory path…" value={dir} onChange={(e) => setDir(e.target.value)} />
          <Button size="sm" variant="outline" disabled={!dir.trim()} onClick={() => doc(() => personalAddDirectory(dir), 'Directory added')}>Add</Button>
        </div>
        {docMsg && <p className={cn('text-xs', /added|Uploaded|started/.test(docMsg) ? 'text-success' : 'text-destructive-foreground')}>{docMsg}</p>}
        <div className="flex gap-2 pt-1">
          <Input placeholder="Test search query…" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} />
          <Input type="number" className="w-16" value={searchK} onChange={(e) => setSearchK(Number(e.target.value) || 5)} />
          <Button size="sm" variant="outline" disabled={!searchQ.trim()} onClick={() => {
            void ragSearch(searchQ, searchK).then((r) => setSearchOut(JSON.stringify(r, null, 2))).catch((e) => setSearchOut((e as Error).message));
          }}>Search</Button>
        </div>
        {searchOut && <pre className="max-h-48 overflow-y-auto rounded-lg border bg-muted px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">{searchOut}</pre>}
      </div>
      </Section>
    </Page>
  );
}

/* ── System (backup + danger zone) ── */

const WIPE_ROWS: Array<{ kind: string; label: string; sub: string }> = [
  { kind: 'chats', label: 'Wipe all chats', sub: 'Every session, message, and chat history. Documents/notes/etc. stay.' },
  { kind: 'memory', label: 'Wipe all memory', sub: 'Clears memory.json, the Memory table, and the vector store. Skills not affected.' },
  { kind: 'skills', label: 'Wipe all skills', sub: 'Drops data/skills/ (all SKILL.md files). Memory not affected.' },
  { kind: 'notes', label: 'Wipe all notes', sub: 'Every note, todo, and checklist.' },
  { kind: 'tasks', label: 'Wipe all tasks', sub: 'All scheduled tasks and their run history.' },
  { kind: 'documents', label: 'Wipe all documents', sub: 'Every library document and artifact.' },
  { kind: 'gallery', label: 'Wipe all gallery images', sub: 'All generated images in the gallery.' },
  { kind: 'calendar', label: 'Wipe all calendar entries', sub: 'Every calendar event and reminder.' },
];

function SystemPanel() {
  const [msg, setMsg] = useState('');
  return (
    <Page>
      <Section title="Data Backup" padded>
        <p className="pb-2 text-xs text-muted-foreground">
          Export or import your user data (memories, presets, settings, skills, preferences) as a JSON file.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { window.location.href = '/api/export'; }}>Export Data</Button>
          <Button variant="outline" size="sm" onClick={() => document.getElementById('sys-import-input')?.click()}>Import Data</Button>
          <input
            id="sys-import-input" type="file" accept=".json" hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void file.text()
                .then((t) => importData(JSON.parse(t)))
                .then((r) => setMsg(r.message ?? 'Import successful'))
                .catch((err) => setMsg((err as Error).message));
            }}
          />
        </div>
      </Section>

      <Section title="Danger Zone">
        <div className="px-4 pt-3.5 text-xs text-muted-foreground sm:px-5">
          Irreversible. Each wipe targets one category — pick exactly what you want gone.
        </div>
        {WIPE_ROWS.map((row) => (
          <Row key={row.kind} label={row.label} hint={row.sub}>
            <Button
              variant="destructive-outline"
              size="sm"
              className="shrink-0"
              onClick={() => {
                if (window.confirm(`${row.label}? This cannot be undone.`)) {
                  void wipeData(row.kind).then(() => setMsg(`Wiped ${row.kind}`)).catch((e) => setMsg((e as Error).message));
                }
              }}
            >
              Wipe
            </Button>
          </Row>
        ))}
      </Section>
      {msg && <p className="px-1 text-xs text-muted-foreground">{msg}</p>}
    </Page>
  );
}

/* ── Dialog shell ── */

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [panel, setPanel] = useState<Panel>('appearance');
  const auth = useAuth();

  const userNav: Array<{ id: Panel; label: string; icon: React.ReactNode }> = [
    { id: 'appearance', label: 'Appearance', icon: <PaletteIcon /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <KeyboardIcon /> },
    { id: 'account', label: 'Account', icon: <UserIcon /> },
  ];
  const adminNav: Array<{ id: Panel; label: string; icon: React.ReactNode }> = [
    { id: 'models', label: 'Add Models', icon: <ServerIcon /> },
    { id: 'ai', label: 'AI Defaults', icon: <BotIcon /> },
    { id: 'integrations', label: 'Integrations', icon: <Link2Icon /> },
    { id: 'tools', label: 'Agent Tools', icon: <WrenchIcon /> },
    { id: 'rag', label: 'RAG', icon: <DatabaseIcon /> },
    { id: 'users', label: 'Users', icon: <UsersIcon /> },
    { id: 'system', label: 'System', icon: <SettingsIcon /> },
  ];

  const NavButton = ({ n }: { n: { id: Panel; label: string; icon: React.ReactNode } }) => (
    <button
      type="button"
      onClick={() => setPanel(n.id)}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors [&_svg]:size-4 [&_svg]:text-muted-foreground',
        panel === n.id ? 'bg-accent font-medium' : 'hover:bg-accent/60',
      )}
    >
      {n.icon}
      {n.label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title="Settings" className="w-[min(800px,94vw)]">
        <div className="flex h-[min(640px,78vh)]">
          <div className="w-44 shrink-0 space-y-0.5 border-r p-2">
            {userNav.map((n) => <NavButton key={n.id} n={n} />)}
            {auth?.is_admin && (
              <>
                <div className="px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Admin</div>
                {adminNav.map((n) => <NavButton key={n.id} n={n} />)}
              </>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto">
            {panel === 'appearance' && <AppearancePanel />}
            {panel === 'shortcuts' && <ShortcutsPanel />}
            {panel === 'account' && <AccountPanel />}
            {panel === 'models' && <AddModelsPanel />}
            {panel === 'ai' && <AiDefaultsPanel />}
            {panel === 'integrations' && <IntegrationsPanel />}
            {panel === 'tools' && <ToolsPanel />}
            {panel === 'rag' && <RagPanel />}
            {panel === 'users' && <UsersPanel currentUser={auth?.username} />}
            {panel === 'system' && <SystemPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
