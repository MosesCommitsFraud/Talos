import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BotIcon,
  DatabaseIcon,
  KeyboardIcon,
  Link2Icon,
  LogOutIcon,
  PaletteIcon,
  ServerIcon,
  SettingsIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  addModelEndpoint,
  createUser,
  deleteUser,
  fetchAppSettings,
  fetchAuthInfo,
  fetchFeatures,
  fetchIntegrations,
  fetchModels,
  fetchRagConfig,
  fetchRuntime,
  fetchUsers,
  logout,
  saveAppSettings,
  saveFeatures,
  saveRagConfig,
  setUserAdmin,
  testRagConfig,
  type AppSettings,
  type RagConfig,
} from '@/api/client';
import { applyDensity, applyTheme, usePrefs, type Density, type Theme } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogSection } from './ui/dialog';
import { Input, Kbd, Switch } from './ui/misc';

type Panel =
  | 'appearance' | 'shortcuts' | 'account'
  | 'models' | 'ai' | 'tools' | 'integrations' | 'rag' | 'users' | 'system';

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['⌘', 'K'], label: 'Search chats & actions' },
  { keys: ['Enter'], label: 'Send message' },
  { keys: ['Shift', 'Enter'], label: 'New line' },
  { keys: ['⌘', 'Enter'], label: 'Save message edit' },
  { keys: ['Esc'], label: 'Close dialog / cancel edit' },
];

/* ── Shared field rows ── */

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
  return <div className="pt-3 pb-1 text-sm font-semibold first:pt-0">{children}</div>;
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

/** Loads the flat /api/auth/settings dict and exposes draft editing for a
 *  panel's subset of keys; Save POSTs only what changed. */
function useSettingsDraft() {
  const { data } = useQuery({ queryKey: ['app-settings'], queryFn: fetchAppSettings });
  const [draft, setDraft] = useState<AppSettings>({});
  const queryClient = useQueryClient();

  const value = (key: string) => (key in draft ? draft[key] : data?.[key]);
  const setValue = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }));
  const dirty = Object.keys(draft).some((k) => draft[k] !== data?.[k]);

  const save = useMutation({
    mutationFn: () => saveAppSettings(draft),
    onSuccess: () => {
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ['app-settings'] });
    },
  });

  return { ready: !!data, value, setValue, dirty, save };
}

function BoolRow({ s, k, label, hint }: { s: ReturnType<typeof useSettingsDraft>; k: string; label: string; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={!!s.value(k)} onCheckedChange={(v) => s.setValue(k, v)} />
    </Row>
  );
}

function TextRow({ s, k, label, hint, placeholder, type }: { s: ReturnType<typeof useSettingsDraft>; k: string; label: string; hint?: string; placeholder?: string; type?: string }) {
  return (
    <Row label={label} hint={hint}>
      <Input
        type={type}
        className="w-56"
        placeholder={placeholder}
        value={String(s.value(k) ?? '')}
        onChange={(e) => s.setValue(k, type === 'number' ? Number(e.target.value) : e.target.value)}
      />
    </Row>
  );
}

function SelectRow({ s, k, label, options, hint }: { s: ReturnType<typeof useSettingsDraft>; k: string; label: string; options: string[]; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <select
        value={String(s.value(k) ?? '')}
        onChange={(e) => s.setValue(k, e.target.value)}
        className="h-8 w-56 rounded-lg border border-input bg-popover px-2 text-sm outline-none focus-visible:border-ring"
      >
        {options.map((o) => (
          <option key={o} value={o}>{o || '—'}</option>
        ))}
      </select>
    </Row>
  );
}

/* ── Panels ── */

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

function AppearancePanel() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const density = usePrefs((s) => s.density);
  const setDensity = usePrefs((s) => s.setDensity);
  return (
    <DialogSection className="space-y-5">
      <div>
        <div className="mb-2 text-sm font-medium">Theme</div>
        <SegmentPicker<Theme>
          options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
          current={theme}
          onPick={(t) => { setTheme(t); applyTheme(t); }}
        />
      </div>
      <div>
        <div className="mb-2 text-sm font-medium">Density</div>
        <SegmentPicker<Density>
          options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }]}
          current={density}
          onPick={(d) => { setDensity(d); applyDensity(d); }}
        />
      </div>
    </DialogSection>
  );
}

function AiDefaultsPanel() {
  const s = useSettingsDraft();
  const { data: endpoints } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const models = (endpoints ?? [])
    .filter((e) => e.is_enabled && e.model_type !== 'embedding')
    .flatMap((e) => e.models);
  if (!s.ready) return <DialogSection className="text-sm text-muted-foreground">Loading…</DialogSection>;
  return (
    <DialogSection>
      <SectionTitle>Defaults</SectionTitle>
      <SelectRow s={s} k="default_model" label="Default chat model" options={['', ...models]} hint="Used when creating a new chat" />
      <SectionTitle>Agent</SectionTitle>
      <TextRow s={s} k="agent_max_rounds" label="Max agent rounds" type="number" />
      <TextRow s={s} k="agent_max_tool_calls" label="Max tool calls" hint="0 = unlimited" type="number" />
      <SectionTitle>Context</SectionTitle>
      <BoolRow s={s} k="context_compression" label="Context compression" hint="Headroom-style compression of large tool outputs" />
      <TextRow s={s} k="compact_threshold" label="Auto-compact threshold" hint="Fraction of the context window (0.3–0.95)" />
      <SectionTitle>Vision & images</SectionTitle>
      <BoolRow s={s} k="vision_enabled" label="Vision" />
      <TextRow s={s} k="vision_model" label="Vision model" />
      <BoolRow s={s} k="image_gen_enabled" label="Image generation" />
      <TextRow s={s} k="image_model" label="Image model" />
      <SelectRow s={s} k="image_quality" label="Image quality" options={['low', 'medium', 'high']} />
      <SectionTitle>Web search</SectionTitle>
      <SelectRow s={s} k="search_provider" label="Provider" options={['searxng', 'duckduckgo', 'brave', 'tavily', 'google_pse', 'serper']} />
      <TextRow s={s} k="search_url" label="Provider URL" placeholder="http://searxng:8080" />
      <TextRow s={s} k="search_result_count" label="Result count" type="number" />
      <SectionTitle>Speech</SectionTitle>
      <BoolRow s={s} k="tts_enabled" label="Text-to-speech" />
      <TextRow s={s} k="tts_model" label="TTS model" />
      <TextRow s={s} k="tts_voice" label="TTS voice" />
      <BoolRow s={s} k="stt_enabled" label="Speech-to-text" />
      <TextRow s={s} k="stt_model" label="STT model" />
      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </DialogSection>
  );
}

function AddModelsPanel() {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const queryClient = useQueryClient();
  const { data: endpoints } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const add = useMutation({
    mutationFn: () => addModelEndpoint({ name, baseUrl, apiKey: apiKey || undefined }),
    onSuccess: () => {
      setName(''); setBaseUrl(''); setApiKey('');
      void queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });
  return (
    <DialogSection className="space-y-5">
      <div className="space-y-2.5">
        <div className="text-sm font-medium">Add endpoint</div>
        <Input placeholder="Name (optional — derived from URL)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Base URL, e.g. http://192.168.10.91:8000/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <Input placeholder="API key (optional)" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <div className="flex items-center gap-3">
          <Button disabled={!baseUrl.trim() || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? 'Probing…' : 'Add endpoint'}
          </Button>
          {add.isError && <span className="text-xs text-destructive-foreground">{(add.error as Error).message}</span>}
          {add.isSuccess && <span className="text-xs text-success">Added</span>}
        </div>
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

const FEATURE_LABELS: Record<string, { label: string; hint: string }> = {
  memory: { label: 'Memory (Brain)', hint: 'Long-term memory tools and the Brain UI' },
  document_editor: { label: 'Document editor', hint: 'Library documents and artifacts' },
  rag: { label: 'RAG', hint: 'Document retrieval for chat' },
  sensitive_filter: { label: 'Sensitive filter', hint: 'Censor module for sensitive output' },
  gallery: { label: 'Gallery', hint: 'Generated-image gallery' },
};

function ToolsPanel() {
  const { data } = useQuery({ queryKey: ['features'], queryFn: fetchFeatures });
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: Record<string, boolean>) => saveFeatures(next),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['features'] }),
  });
  if (!data) return <DialogSection className="text-sm text-muted-foreground">Loading…</DialogSection>;
  return (
    <DialogSection>
      <p className="pb-2 text-xs text-muted-foreground">Toggle features on/off across the interface for all users.</p>
      {Object.entries(data).map(([key, enabled]) => (
        <Row key={key} label={FEATURE_LABELS[key]?.label ?? key} hint={FEATURE_LABELS[key]?.hint}>
          <Switch checked={enabled} onCheckedChange={(v) => toggle.mutate({ ...data, [key]: v })} />
        </Row>
      ))}
    </DialogSection>
  );
}

function IntegrationsPanel() {
  const { data } = useQuery({ queryKey: ['integrations'], queryFn: fetchIntegrations });
  return (
    <DialogSection className="space-y-1.5">
      {(data ?? []).map((it, i) => (
        <div key={String(it.id ?? i)} className="flex items-center justify-between rounded-lg border bg-card px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm">{String(it.name ?? it.id ?? 'Integration')}</div>
            {typeof it.base_url === 'string' && <div className="truncate text-xs text-muted-foreground">{it.base_url}</div>}
          </div>
          <span className={cn('text-xs', it.enabled ? 'text-success' : 'text-muted-foreground')}>
            {it.enabled ? 'enabled' : 'disabled'}
          </span>
        </div>
      ))}
      {(data ?? []).length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No integrations configured.</p>}
      <p className="pt-2 text-xs text-muted-foreground">
        Adding and editing integrations (API keys, presets, MCP servers) is still done in the{' '}
        <a className="underline hover:text-foreground" href="/legacy">legacy settings</a>.
      </p>
    </DialogSection>
  );
}

function RagPanel() {
  const { data } = useQuery({ queryKey: ['rag-config'], queryFn: fetchRagConfig });
  const [draft, setDraft] = useState<RagConfig | null>(null);
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
  return (
    <DialogSection>
      <Row label="RAG enabled"><Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} /></Row>
      <SectionTitle>Embeddings</SectionTitle>
      {text('embedding_url', 'Embedding URL')}
      {text('embedding_model', 'Embedding model')}
      <SectionTitle>Vector store</SectionTitle>
      {text('qdrant_url', 'Qdrant URL')}
      {text('qdrant_api_key', 'Qdrant API key', 'password')}
      <SectionTitle>Reranking</SectionTitle>
      {text('rerank_url', 'Rerank URL')}
      {text('rerank_model', 'Rerank model')}
      {text('rerank_api_key', 'Rerank API key', 'password')}
      <SectionTitle>Retrieval</SectionTitle>
      {text('chat_top_k', 'Chat top-k', 'number')}
      {text('search_top_k', 'Search top-k', 'number')}
      {text('candidate_top_k', 'Candidate top-k', 'number')}
      <div className="flex items-center gap-3 pt-3">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        {test.isSuccess && (
          <span className={cn('text-xs', test.data?.ok === false ? 'text-destructive-foreground' : 'text-success')}>
            {test.data?.ok === false ? 'Test failed' : 'OK'}
          </span>
        )}
        {save.isError && <span className="text-xs text-destructive-foreground">{(save.error as Error).message}</span>}
      </div>
    </DialogSection>
  );
}

function UsersPanel({ currentUser }: { currentUser?: string }) {
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: fetchUsers });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['users'] });
  const create = useMutation({
    mutationFn: () => createUser(username, password),
    onSuccess: () => { setUsername(''); setPassword(''); refresh(); },
  });
  return (
    <DialogSection className="space-y-4">
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
              onClick={() => void deleteUser(u.username).then(refresh).catch(console.error)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive-foreground disabled:opacity-30"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Create user</div>
        <div className="flex gap-2">
          <Input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button disabled={!username.trim() || !password || create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </div>
        {create.isError && <p className="text-xs text-destructive-foreground">{(create.error as Error).message}</p>}
      </div>
    </DialogSection>
  );
}

function SystemPanel() {
  const { data: runtime } = useQuery({ queryKey: ['runtime'], queryFn: fetchRuntime });
  return (
    <DialogSection className="space-y-4">
      <div>
        <div className="mb-1.5 text-sm font-medium">Runtime</div>
        <div className="space-y-1 rounded-lg border bg-card px-3 py-2">
          {Object.entries(runtime ?? {}).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 text-xs">
              <span className="text-muted-foreground">{k}</span>
              <span className="truncate font-mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => { window.location.href = '/api/export'; }}>
          Export data
        </Button>
        <a href="/legacy" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Import & wipe live in legacy
        </a>
      </div>
    </DialogSection>
  );
}

function AccountPanel() {
  const { data: auth } = useQuery({ queryKey: ['auth'], queryFn: fetchAuthInfo, staleTime: Infinity });
  return (
    <DialogSection className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {(auth?.user ?? 'U').slice(0, 1).toUpperCase()}
        </div>
        <div>
          <div className="text-sm font-medium">{auth?.user ?? 'User'}</div>
          <div className="text-xs text-muted-foreground">
            {auth?.is_admin ? 'Administrator' : 'Member'}
            {auth?.auth_enabled === false && ' · auth disabled'}
          </div>
        </div>
      </div>
      {auth?.auth_enabled !== false && (
        <Button variant="outline" onClick={() => void logout()}>
          <LogOutIcon /> Log out
        </Button>
      )}
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
      <DialogContent title="Settings" className="w-[min(760px,94vw)]">
        <div className="flex min-h-[480px]">
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
            {panel === 'shortcuts' && (
              <DialogSection className="space-y-1">
                {SHORTCUTS.map((s) => (
                  <div key={s.label} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm">
                    <span>{s.label}</span>
                    <span className="flex gap-1">{s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                  </div>
                ))}
              </DialogSection>
            )}
            {panel === 'account' && <AccountPanel />}
            {panel === 'models' && <AddModelsPanel />}
            {panel === 'ai' && <AiDefaultsPanel />}
            {panel === 'tools' && <ToolsPanel />}
            {panel === 'integrations' && <IntegrationsPanel />}
            {panel === 'rag' && <RagPanel />}
            {panel === 'users' && <UsersPanel currentUser={auth?.user} />}
            {panel === 'system' && <SystemPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
