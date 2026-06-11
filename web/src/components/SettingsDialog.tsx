import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BotIcon,
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
  createUser,
  deleteIntegration,
  deleteUser,
  discoverEndpoints,
  fetchAppSettings,
  fetchAuthInfo,
  fetchAuthStatus,
  fetchFeatures,
  fetchIntegrationPresets,
  fetchIntegrations,
  fetchModels,
  fetchRagConfig,
  fetchRuntime,
  fetchTotpStatus,
  fetchUsers,
  importData,
  logout,
  personalAddDirectory,
  personalReload,
  personalUpload,
  ragSearch,
  saveAppSettings,
  saveFeatures,
  saveRagConfig,
  setUserAdmin,
  testModelEndpoint,
  testRagConfig,
  toggleSignup,
  totpConfirm,
  totpDisable,
  totpSetup,
  updateIntegration,
  wipeData,
  type AppSettings,
  type RagConfig,
} from '@/api/client';
import { applyDensity, applyTheme, usePrefs, type Density, type Theme, type Visibility } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogSection } from './ui/dialog';
import { Input, Switch } from './ui/misc';

type Panel =
  | 'appearance' | 'shortcuts' | 'account'
  | 'models' | 'ai' | 'integrations' | 'tools' | 'rag' | 'users' | 'system';

/* ── Shared rows ── */

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="pt-4 pb-1 text-sm font-semibold first:pt-0">{children}</div>;
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
    <div className="sticky bottom-0 -mx-5 mt-3 flex items-center justify-end gap-3 border-t bg-popover px-5 py-2.5">
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

function SelectRow({ s, k, label, options, hint }: { s: Draft; k: string; label: string; options: string[]; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <Select className="w-56" value={String(s.value(k) ?? '')} onChange={(v) => s.setValue(k, v)} options={options.map((o) => ({ value: o }))} />
    </Row>
  );
}

/* ── Endpoint + model pickers (Default/Utility/Research models) ── */

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

interface Fallback { endpoint_id: string; model: string }

function FallbacksEditor({ s, k }: { s: Draft; k: string }) {
  const endpoints = useEndpoints();
  const list: Fallback[] = Array.isArray(s.value(k)) ? (s.value(k) as Fallback[]) : [];
  const allModels = endpoints.flatMap((e) => e.models.map((model) => ({ endpoint_id: e.id, model, name: e.name })));
  return (
    <div className="space-y-1.5 py-1">
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

const VISIBILITY_SECTIONS: Array<{ title: string; items: Array<{ key: keyof Visibility; label: string }> }> = [
  { title: 'Sidebar', items: [{ key: 'sidebarBrain', label: 'Brain' }, { key: 'sidebarLibrary', label: 'Library' }] },
  { title: 'Chat Area', items: [{ key: 'messageMetrics', label: 'Response metrics (tok/s, time)' }] },
  {
    title: 'Chat Bar',
    items: [
      { key: 'composerPlan', label: 'Plan toggle' },
      { key: 'composerDocs', label: 'Docs (RAG) toggle' },
      { key: 'composerDb', label: 'Database toggle' },
      { key: 'contextMeter', label: 'Context window meter' },
    ],
  },
];

function AppearancePanel() {
  const prefs = usePrefs();
  return (
    <DialogSection>
      <SectionTitle>Theme</SectionTitle>
      <SegmentPicker<Theme>
        options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
        current={prefs.theme}
        onPick={(t) => { prefs.setTheme(t); applyTheme(t); }}
      />
      <SectionTitle>Density</SectionTitle>
      <SegmentPicker<Density>
        options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }]}
        current={prefs.density}
        onPick={(d) => { prefs.setDensity(d); applyDensity(d); }}
      />
      {VISIBILITY_SECTIONS.map((sec) => (
        <div key={sec.title}>
          <SectionTitle>{sec.title}</SectionTitle>
          {sec.items.map((it) => (
            <Row key={it.key} label={it.label}>
              <Switch checked={prefs.visibility[it.key]} onCheckedChange={(v) => prefs.setVisibility(it.key, v)} />
            </Row>
          ))}
        </div>
      ))}
      <div className="pt-3">
        <Button variant="outline" size="sm" onClick={prefs.resetVisibility}>Reset visibility</Button>
      </div>
    </DialogSection>
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
  if (!s.ready) return <DialogSection className="text-sm text-muted-foreground">Loading…</DialogSection>;
  return (
    <DialogSection>
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
      <p className="pt-2 text-xs text-muted-foreground">Click a field and press the new key combination.</p>
      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </DialogSection>
  );
}

/* ── Account: password change + 2FA + logout ── */

function AccountPanel() {
  const { data: auth } = useQuery({ queryKey: ['auth'], queryFn: fetchAuthInfo, staleTime: Infinity });
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
    <DialogSection>
      <SectionTitle>Account</SectionTitle>
      <div className="flex items-center gap-3 py-1">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {(auth?.user ?? 'U').slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium">{auth?.user ?? 'User'}</div>
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

      <SectionTitle>Change Password</SectionTitle>
      <div className="space-y-2">
        <Input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        <Input type="password" placeholder="New password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        <Input type="password" placeholder="Confirm new password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!pw.current || !pw.next} onClick={() => void savePassword()}>Change password</Button>
          {pwMsg && <span className={cn('text-xs', pwMsg === 'Password changed' ? 'text-success' : 'text-destructive-foreground')}>{pwMsg}</span>}
        </div>
      </div>

      <SectionTitle>Two-Factor Authentication</SectionTitle>
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
    </DialogSection>
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
    <DialogSection className="space-y-4">
      <div className="space-y-2.5">
        <div className="text-sm font-medium">Add endpoint</div>
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
      <div className="space-y-1.5">
        <div className="text-sm font-medium">Configured endpoints</div>
        {(endpoints ?? []).map((e) => (
          <div key={e.id} className="flex items-center justify-between rounded-lg border bg-card px-3 py-2">
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
    </DialogSection>
  );
}

/* ── AI Defaults (full legacy AI tab) ── */

function AiDefaultsPanel() {
  const s = useSettingsDraft();
  if (!s.ready) return <DialogSection className="text-sm text-muted-foreground">Loading…</DialogSection>;
  return (
    <DialogSection>
      <SectionTitle>Default Chat Model</SectionTitle>
      <EndpointModelRows s={s} epKey="default_endpoint_id" modelKey="default_model" label="Default" />
      <FallbacksEditor s={s} k="default_model_fallbacks" />

      <SectionTitle>Utility Model</SectionTitle>
      <p className="pb-1 text-xs text-muted-foreground">Small fast model for titles, summaries and background jobs.</p>
      <EndpointModelRows s={s} epKey="utility_endpoint_id" modelKey="utility_model" label="Utility" />
      <FallbacksEditor s={s} k="utility_model_fallbacks" />

      <SectionTitle>Context Management</SectionTitle>
      <TextRow s={s} k="compact_threshold" label="Auto-compact at" hint="Fraction of the context window (0.3–0.95)" width="w-24" />
      <BoolRow s={s} k="context_compression" label="Tool output compression" hint="Headroom-style compression of large tool outputs" />

      <SectionTitle>Vision</SectionTitle>
      <BoolRow s={s} k="vision_enabled" label="Vision enabled" />
      <TextRow s={s} k="vision_model" label="Vision model" />
      <FallbacksEditor s={s} k="vision_model_fallbacks" />

      <SectionTitle>Research Model</SectionTitle>
      <EndpointModelRows s={s} epKey="research_endpoint_id" modelKey="research_model" label="Research" />
      <SelectRow s={s} k="research_search_provider" label="Search" options={['', 'searxng', 'duckduckgo', 'tavily', 'brave', 'google', 'serper']} />
      <TextRow s={s} k="research_max_tokens" label="Max tokens" type="number" width="w-24" />
      <TextRow s={s} k="research_extraction_timeout_seconds" label="Extract timeout (s)" type="number" width="w-24" />
      <TextRow s={s} k="research_extraction_concurrency" label="Extract parallel" type="number" width="w-24" />
      <TextRow s={s} k="research_run_timeout_seconds" label="Max time (s)" type="number" width="w-24" />

      <SectionTitle>Agent</SectionTitle>
      <TextRow s={s} k="agent_max_tool_calls" label="Tool call limit" hint="0 = unlimited" type="number" width="w-24" />
      <TextRow s={s} k="agent_max_rounds" label="Max steps per message" type="number" width="w-24" />

      <SectionTitle>Image Generation</SectionTitle>
      <BoolRow s={s} k="image_gen_enabled" label="Image generation" />
      <TextRow s={s} k="image_model" label="Model" />
      <SelectRow s={s} k="image_quality" label="Quality" options={['low', 'medium', 'high']} />

      <SectionTitle>Text-to-Speech</SectionTitle>
      <BoolRow s={s} k="tts_enabled" label="TTS enabled" />
      <SelectRow s={s} k="tts_provider" label="Provider" options={['disabled', 'browser', 'local']} />
      <TextRow s={s} k="tts_model" label="Model" />
      <TextRow s={s} k="tts_voice" label="Voice" />
      <SelectRow s={s} k="tts_speed" label="Speed" options={['0.5', '0.75', '1', '1.25', '1.5', '2']} />

      <SectionTitle>Speech-to-Text</SectionTitle>
      <BoolRow s={s} k="stt_enabled" label="STT enabled" />
      <SelectRow s={s} k="stt_provider" label="Provider" options={['disabled', 'browser', 'local']} />
      <TextRow s={s} k="stt_model" label="Model" />
      <TextRow s={s} k="stt_language" label="Language" placeholder="auto" width="w-24" />

      <SectionTitle>Teacher</SectionTitle>
      <BoolRow s={s} k="teacher_enabled" label="Teacher escalation" hint="Escalate hard problems to a stronger model" />
      <TextRow s={s} k="teacher_model" label="Teacher model" />

      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </DialogSection>
  );
}

/* ── Integrations (web search + integration CRUD) ── */

function IntegrationsPanel() {
  const s = useSettingsDraft();
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
    <DialogSection>
      <SectionTitle>Web Search</SectionTitle>
      {s.ready && (
        <>
          <SelectRow s={s} k="search_provider" label="Provider" options={['searxng', 'duckduckgo', 'tavily', 'brave', 'google_pse', 'serper']} />
          <TextRow s={s} k="search_url" label="Provider URL" placeholder="http://searxng:8080" />
          <TextRow s={s} k="search_result_count" label="Result count" type="number" width="w-24" />
          <SelectRow s={s} k="search_safesearch" label="SafeSearch" options={['strict', 'moderate', 'off']} />
          <TextRow s={s} k="brave_api_key" label="Brave API key" type="password" />
          <TextRow s={s} k="google_pse_key" label="Google PSE key" type="password" />
          <TextRow s={s} k="google_pse_cx" label="Google PSE cx" />
          <TextRow s={s} k="tavily_api_key" label="Tavily API key" type="password" />
          <TextRow s={s} k="serper_api_key" label="Serper API key" type="password" />
        </>
      )}

      <SectionTitle>Integrations</SectionTitle>
      <div className="space-y-1.5">
        {(integrations ?? []).map((it, i) => {
          const id = String(it.id ?? i);
          return (
            <div key={id} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
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

      <div className="space-y-2 pt-3">
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
      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </DialogSection>
  );
}

/* ── Agent Tools (features + disabled built-in tools) ── */

const FEATURE_LABELS: Record<string, { label: string; hint: string }> = {
  memory: { label: 'Memory (Brain)', hint: 'Long-term memory tools and the Brain UI' },
  document_editor: { label: 'Document editor', hint: 'Library documents and artifacts' },
  rag: { label: 'RAG', hint: 'Document retrieval for chat' },
  sensitive_filter: { label: 'Sensitive filter', hint: 'Censor module for sensitive output' },
  gallery: { label: 'Gallery', hint: 'Generated-image gallery' },
};

function ToolsPanel() {
  const { data } = useQuery({ queryKey: ['features'], queryFn: fetchFeatures });
  const s = useSettingsDraft();
  const queryClient = useQueryClient();
  const toggleFeature = useMutation({
    mutationFn: (next: Record<string, boolean>) => saveFeatures(next),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['features'] }),
  });
  const disabled: string[] = Array.isArray(s.value('disabled_tools')) ? (s.value('disabled_tools') as string[]) : [];
  return (
    <DialogSection>
      <SectionTitle>Built-in Tools</SectionTitle>
      <p className="pb-1 text-xs text-muted-foreground">Toggle features on/off across the interface for all users.</p>
      {data && Object.entries(data).map(([key, enabled]) => (
        <Row key={key} label={FEATURE_LABELS[key]?.label ?? key} hint={FEATURE_LABELS[key]?.hint}>
          <Switch checked={enabled} onCheckedChange={(v) => toggleFeature.mutate({ ...data, [key]: v })} />
        </Row>
      ))}
      <SectionTitle>Disabled agent tools</SectionTitle>
      <p className="pb-1 text-xs text-muted-foreground">Comma-separated tool names the agent must not use (e.g. run_bash, web_search).</p>
      <Input
        value={disabled.join(', ')}
        placeholder="none"
        onChange={(e) => s.setValue('disabled_tools', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
      />
      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </DialogSection>
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
  if (!draft) return <DialogSection className="text-sm text-muted-foreground">Loading…</DialogSection>;
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
    <DialogSection>
      <SectionTitle>Pipeline</SectionTitle>
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
      <div className="flex items-center gap-3 pt-2">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test connection'}</Button>
        {test.isSuccess && (
          <span className={cn('text-xs', test.data?.ok === false ? 'text-destructive-foreground' : 'text-success')}>
            {test.data?.ok === false ? 'Test failed' : 'OK'}
          </span>
        )}
      </div>

      <SectionTitle>Documents</SectionTitle>
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
    </DialogSection>
  );
}

/* ── Users (registration + list + add) ── */

function UsersPanel({ currentUser }: { currentUser?: string }) {
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: fetchUsers });
  const { data: status, refetch: refetchStatus } = useQuery({ queryKey: ['auth-status'], queryFn: fetchAuthStatus });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['users'] });
  const create = useMutation({
    mutationFn: async () => {
      await createUser(username, password);
      if (isAdmin) await setUserAdmin(username, true);
    },
    onSuccess: () => { setUsername(''); setPassword(''); setIsAdmin(false); refresh(); },
  });
  return (
    <DialogSection>
      <SectionTitle>Registration</SectionTitle>
      <Row label="Open signup" hint="Allow new users to register themselves">
        <Switch checked={!!status?.signup_enabled} onCheckedChange={() => void toggleSignup().then(() => refetchStatus())} />
      </Row>

      <SectionTitle>Users</SectionTitle>
      <div className="space-y-1.5">
        {(users ?? []).map((u) => (
          <div key={u.username} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
            <div className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {u.username.slice(0, 1).toUpperCase()}
            </div>
            <span className="min-w-0 flex-1 truncate text-sm">{u.username}</span>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              admin
              <Switch
                checked={u.is_admin}
                disabled={u.username === currentUser}
                onCheckedChange={(v) => void setUserAdmin(u.username, v).then(refresh).catch(console.error)}
              />
            </label>
            <button
              type="button"
              aria-label={`Delete ${u.username}`}
              disabled={u.username === currentUser}
              onClick={() => { if (window.confirm(`Delete user ${u.username}?`)) void deleteUser(u.username).then(refresh).catch(console.error); }}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive-foreground disabled:opacity-30"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      <SectionTitle>Add User</SectionTitle>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={isAdmin} onCheckedChange={setIsAdmin} /> Administrator
        </label>
        <Button size="sm" disabled={!username.trim() || !password || create.isPending} onClick={() => create.mutate()}>
          <PlusIcon /> Create user
        </Button>
        {create.isError && <p className="text-xs text-destructive-foreground">{(create.error as Error).message}</p>}
      </div>
    </DialogSection>
  );
}

/* ── System (backup + danger zone) ── */

const WIPE_KINDS = ['chats', 'memory', 'skills', 'notes', 'tasks', 'documents', 'gallery', 'calendar'];

function SystemPanel() {
  const { data: runtime } = useQuery({ queryKey: ['runtime'], queryFn: fetchRuntime });
  const [msg, setMsg] = useState('');
  return (
    <DialogSection>
      <SectionTitle>Runtime</SectionTitle>
      <div className="space-y-1 rounded-lg border bg-card px-3 py-2">
        {Object.entries(runtime ?? {}).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 text-xs">
            <span className="text-muted-foreground">{k}</span>
            <span className="truncate font-mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
          </div>
        ))}
      </div>

      <SectionTitle>Data Backup</SectionTitle>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => { window.location.href = '/api/export'; }}>Export data</Button>
        <Button variant="outline" size="sm" onClick={() => document.getElementById('sys-import-input')?.click()}>Import data…</Button>
        <input
          id="sys-import-input" type="file" accept="application/json" hidden
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

      <SectionTitle>Danger Zone</SectionTitle>
      <p className="pb-1 text-xs text-muted-foreground">Permanently wipe a data category for all users. This cannot be undone.</p>
      <div className="flex flex-wrap gap-2">
        {WIPE_KINDS.map((kind) => (
          <Button
            key={kind}
            variant="destructive-outline"
            size="sm"
            onClick={() => {
              if (window.confirm(`Wipe ALL ${kind}? This cannot be undone.`)) {
                void wipeData(kind).then(() => setMsg(`Wiped ${kind}`)).catch((e) => setMsg((e as Error).message));
              }
            }}
          >
            <Trash2Icon /> {kind}
          </Button>
        ))}
      </div>
      {msg && <p className="pt-2 text-xs text-muted-foreground">{msg}</p>}
    </DialogSection>
  );
}

/* ── Dialog shell ── */

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [panel, setPanel] = useState<Panel>('appearance');
  const { data: auth } = useQuery({ queryKey: ['auth'], queryFn: fetchAuthInfo, staleTime: Infinity });

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
        <div className="flex min-h-[520px]">
          <div className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r p-2">
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
            {panel === 'users' && <UsersPanel currentUser={auth?.user} />}
            {panel === 'system' && <SystemPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
