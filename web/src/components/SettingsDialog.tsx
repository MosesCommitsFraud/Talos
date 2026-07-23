import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FileTextIcon,
  KeyboardIcon,
  Link2Icon,
  LogOutIcon,
  PaletteIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addModelEndpoint,
  fetchAssistants,
  createAssistant,
  updateAssistant,
  deleteAssistant,
  changePassword,
  setDisplayName,
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
  fetchRagDocuments,
  deleteRagDocument,
  fetchSqlKnowledge,
  uploadSqlKnowledge,
  deleteSqlKnowledge,
  saveAppSettings,
  saveDisabledTools,
  saveRagConfig,
  saveSqlConfig,
  testSqlConfig,
  testModelEndpoint,
  testRagConfig,
  testRagEndpoint,
  totpConfirm,
  totpDisable,
  totpSetup,
  updateIntegration,
  wipeData,
  fetchSharedSkills,
  uploadSharedSkill,
  uploadSharedSkillBundle,
  deleteSharedSkill,
  setSharedSkillEnabled,
  type SharedSkill,
  type AppSettings,
  type RagConfig,
  type SqlConfig,
} from '@/api/client';
import type { AssistantEndpoint } from '@/api/types';
import { applyDensity, applyLang, applyTheme, usePrefs, type Density, type Lang, type LlmLang, type Theme, type Visibility } from '@/state/prefs';
import { useRagConsole } from '@/state/ragConsole';
import { LANGUAGES } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input, Switch, Textarea } from './ui/misc';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './ui/menu';
import { KeybindingPill } from './ui/kbd';
import { useAuth } from './auth/AuthGate';
import { UsersPanel } from './settings/UsersPanel';

export type Panel =
  | 'appearance' | 'shortcuts' | 'account' | 'skills'
  | 'models' | 'ai' | 'assistants' | 'integrations' | 'tools' | 'rag' | 'users' | 'system';

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
      <div className={cn('overflow-hidden rounded-md border bg-card text-card-foreground', padded && 'p-4 sm:p-5')}>
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
export function Row({ label, hint, children, stacked }: { label: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode; stacked?: boolean }) {
  return (
    <div className={cn(
      'flex flex-col gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5',
      stacked ? 'xl:flex-row xl:items-center xl:justify-between' : 'sm:flex-row sm:items-center sm:justify-between',
    )}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">{label}</div>
        {hint && <p className="settings-row-hint text-xs text-muted-foreground/80">{hint}</p>}
      </div>
      {children && <div className={cn(
        'flex w-full shrink-0 items-center gap-2',
        stacked ? 'xl:w-auto xl:justify-end' : 'sm:w-auto sm:justify-end',
      )}>{children}</div>}
    </div>
  );
}

/** Custom dropdown matching the composer mode picker — a bordered trigger with
 *  a chevron and a themed popup, instead of the OS-native `<select>` chrome
 *  (which ignores the app's fonts/colors and looks foreign in the dialog). The
 *  popup scrolls for long option lists (e.g. model pickers). */
function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label?: string }>; className?: string }) {
  const current = options.find((o) => o.value === value);
  const label = current?.label ?? (current?.value || value || '—');
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 min-w-[7rem] items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/20',
            className,
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
        </button>
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="max-h-[min(20rem,50vh)] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
      >
        {options.map((o) => (
          <MenuItem key={o.value} onSelect={() => onChange(o.value)} className="justify-between gap-3">
            <span className="truncate">{o.label ?? (o.value || '—')}</span>
            {o.value === value && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function SaveBar({ dirty, saving, error, onSave }: { dirty: boolean; saving: boolean; error?: string; onSave: () => void }) {
  const { t } = useTranslation();
  if (!dirty && !error) return null;
  return (
    <div className="sticky bottom-0 -mx-5 -mb-5 mt-1 flex items-center justify-end gap-3 border-t bg-popover/95 px-5 py-3 backdrop-blur-sm sm:-mx-6 sm:-mb-6 sm:px-6">
      {error && <span className="min-w-0 flex-1 truncate text-xs text-destructive-foreground">{error}</span>}
      <Button size="sm" disabled={saving || !dirty} onClick={onSave}>
        {saving ? t('common.saving') : t('settings.saveChanges')}
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
  const { t } = useTranslation();
  const endpoints = useEndpoints();
  const epId = String(s.value(epKey) ?? '');
  const models = endpoints.find((e) => e.id === epId)?.models ?? endpoints.flatMap((e) => e.models);
  return (
    <>
      <Row label={t('settings.ai.endpoint', { label })}>
        <Select
          className="w-56"
          value={epId}
          onChange={(v) => s.setValue(epKey, v)}
          options={[{ value: '', label: '—' }, ...endpoints.map((e) => ({ value: e.id, label: e.name }))]}
        />
      </Row>
      <Row label={t('settings.ai.model', { label })}>
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
  const { t } = useTranslation();
  const endpoints = useEndpoints();
  const models = endpoints.flatMap((e) => e.models);
  return (
    <Row label={t('settings.ai.visionModel')}>
      <Select
        className="w-56"
        value={String(s.value('vision_model') ?? '')}
        onChange={(v) => s.setValue('vision_model', v)}
        options={[{ value: '', label: t('settings.ai.autoDetect') }, ...models.map((m) => ({ value: m }))]}
      />
    </Row>
  );
}

interface Fallback { endpoint_id: string; model: string }

function FallbacksEditor({ s, k }: { s: Draft; k: string }) {
  const { t } = useTranslation();
  const endpoints = useEndpoints();
  const list: Fallback[] = Array.isArray(s.value(k)) ? (s.value(k) as Fallback[]) : [];
  const allModels = endpoints.flatMap((e) => e.models.map((model) => ({ endpoint_id: e.id, model, name: e.name })));
  return (
    <div className="space-y-1.5 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="text-xs text-muted-foreground">{t('settings.ai.fallbacks')}</div>
      {list.map((f, i) => (
        <div key={`${f.endpoint_id}:${f.model}:${i}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-lg border bg-card px-2.5 py-1 text-xs">
            {f.model} <span className="text-muted-foreground">· {endpoints.find((e) => e.id === f.endpoint_id)?.name ?? f.endpoint_id}</span>
          </span>
          <button
            type="button"
            aria-label={t('settings.ai.removeFallback')}
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
          { value: '', label: t('settings.ai.addFallback') },
          ...allModels.map((m) => ({ value: `${m.endpoint_id}:${m.model}`, label: `${m.model} · ${m.name}` })),
        ]}
      />
    </div>
  );
}

/* ── Appearance (theme/density + UI visibility, mirrors legacy sections) ── */

/** Visibility toggles keyed for i18n: secKey → settings.appearance.sec.*,
 *  item key → settings.appearance.vis.<key> (+ "<key>Hint" when present). */
const VISIBILITY_SECTIONS: Array<{ secKey: string; items: Array<{ key: keyof Visibility; hint?: boolean }> }> = [
  {
    secKey: 'sidebar',
    items: [
      { key: 'sidebarUserBar', hint: true },
      { key: 'sidebarSettingsBtn', hint: true },
    ],
  },
  {
    secKey: 'chatArea',
    items: [
      { key: 'chatHeader', hint: true },
      { key: 'welcomeText', hint: true },
      { key: 'showThinking', hint: true },
      { key: 'incognitoBtn', hint: true },
      { key: 'messageMetrics', hint: true },
    ],
  },
  {
    secKey: 'chatBar',
    items: [
      { key: 'composerAttach' },
      { key: 'composerPlan' },
      { key: 'composerModelPicker' },
      { key: 'contextMeter' },
    ],
  },
];

function AppearancePanel() {
  const { t } = useTranslation();
  const prefs = usePrefs();
  return (
    <Page>
      {/* Theme / language / density as compact dropdown rows (t3code General
          settings style) rather than three stacked cards of giant buttons. */}
      <Section title={t('settings.appearance.title')}>
        <Row label={t('settings.appearance.theme')} hint={t('settings.appearance.themeHint')}>
          <Select
            className="w-44"
            value={prefs.theme}
            onChange={(v) => { prefs.setTheme(v as Theme); applyTheme(v as Theme); }}
            options={[
              { value: 'system', label: t('settings.appearance.system') },
              { value: 'light', label: t('settings.appearance.light') },
              { value: 'dark', label: t('settings.appearance.dark') },
            ]}
          />
        </Row>
        <Row label={t('settings.appearance.language')} hint={t('settings.appearance.languageHint')}>
          <Select
            className="w-44"
            value={prefs.lang}
            onChange={(v) => { prefs.setLang(v as Lang); applyLang(v as Lang); }}
            options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
          />
        </Row>
        <Row label={t('settings.appearance.llmLanguage')} hint={t('settings.appearance.llmLanguageHint')}>
          <Select
            className="w-44"
            value={prefs.llmLang}
            onChange={(v) => prefs.setLlmLang(v as LlmLang)}
            options={[
              { value: 'auto', label: t('settings.appearance.languageAuto') },
              ...LANGUAGES.map((l) => ({ value: l.value, label: l.label })),
            ]}
          />
        </Row>
        <Row label={t('settings.appearance.density')} hint={t('settings.appearance.densityHint')}>
          <Select
            className="w-44"
            value={prefs.density}
            onChange={(v) => { prefs.setDensity(v as Density); applyDensity(v as Density); }}
            options={[
              { value: 'compact', label: t('settings.appearance.compact') },
              { value: 'comfortable', label: t('settings.appearance.comfortable') },
              { value: 'spacious', label: t('settings.appearance.spacious') },
            ]}
          />
        </Row>
      </Section>
      {VISIBILITY_SECTIONS.map((sec) => (
        <Section key={sec.secKey} title={t(`settings.appearance.sec.${sec.secKey}`)}>
          {sec.items.map((it) => (
            <Row
              key={it.key}
              label={t(`settings.appearance.vis.${it.key}`)}
              hint={it.hint ? t(`settings.appearance.vis.${it.key}Hint`) : undefined}
            >
              <Switch checked={prefs.visibility[it.key]} onCheckedChange={(v) => prefs.setVisibility(it.key, v)} />
            </Row>
          ))}
        </Section>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={prefs.resetVisibility}>{t('settings.appearance.resetVisibility')}</Button>
      </div>
    </Page>
  );
}

/* ── Shortcuts (editable keybinds from settings.keybinds) ── */

const KEYBIND_KEYS = [
  'search', 'toggle_sidebar', 'new_session', 'star_session',
  'delete_session', 'admin_panel', 'cancel',
];

/** Build a "ctrl+meta+alt+shift+key" binding string from a keyboard event. */
function bindingFromEvent(e: React.KeyboardEvent): string | null {
  const k = e.key.toLowerCase();
  if (['control', 'meta', 'alt', 'shift'].includes(k)) return null;
  const parts = [
    e.ctrlKey && 'ctrl', e.metaKey && 'meta', e.altKey && 'alt', e.shiftKey && 'shift',
  ].filter(Boolean) as string[];
  parts.push(k === ' ' ? 'space' : k);
  return parts.join('+');
}

/** t3code-style keybind control: shows the binding as keycap pills; click to
 *  re-record, then capture the next combination pressed. */
function KeybindRecorder({ value, onChange }: { value?: string; onChange: (next: string) => void }) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (recording) {
    return (
      <input
        ref={inputRef}
        autoFocus
        readOnly
        value=""
        placeholder={t('settings.shortcuts.recording')}
        aria-label={t('settings.shortcuts.recording')}
        className="h-7 w-44 rounded-md border border-primary/70 bg-primary/5 px-2 text-center font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') return;
          e.preventDefault();
          // Stop the combo from reaching window-level shortcut handlers (e.g. ⌘K).
          e.stopPropagation();
          if (e.key === 'Escape') { setRecording(false); return; }
          const next = bindingFromEvent(e);
          if (!next) return;
          onChange(next);
          setRecording(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setRecording(true)}
      aria-label={t('settings.shortcuts.edit')}
      className="group inline-flex h-7 min-w-44 items-center justify-center gap-2 rounded-md border border-transparent px-2 outline-none transition-colors hover:border-border hover:bg-accent focus-visible:border-ring"
    >
      {value
        ? <KeybindingPill value={value} />
        : <span className="font-mono text-xs text-muted-foreground">{t('settings.shortcuts.unset')}</span>}
      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/70">
        {t('settings.shortcuts.edit')}
      </span>
    </button>
  );
}

function ShortcutsPanel() {
  const { t } = useTranslation();
  const s = useSettingsDraft();
  const binds = (s.value('keybinds') ?? {}) as Record<string, string>;
  if (!s.ready) return <Page><p className="text-sm text-muted-foreground">{t('common.loading')}</p></Page>;
  return (
    <Page>
      <Section title={t('settings.shortcuts.title')}>
        {KEYBIND_KEYS.map((key) => (
          <Row key={key} label={t(`settings.shortcuts.labels.${key}`)}>
            <KeybindRecorder
              value={binds[key]}
              onChange={(next) => s.setValue('keybinds', { ...binds, [key]: next })}
            />
          </Row>
        ))}
      </Section>
      <p className="-mt-3 px-1 text-xs text-muted-foreground">{t('settings.shortcuts.hint')}</p>
      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </Page>
  );
}

/* ── Account: password change + 2FA + logout ── */

function AccountPanel() {
  const { t } = useTranslation();
  const auth = useAuth();
  const qc = useQueryClient();
  const { data: totp, refetch: refetchTotp } = useQuery({ queryKey: ['totp'], queryFn: fetchTotpStatus });
  const [name, setName] = useState(auth?.display_name ?? '');
  const [nameMsg, setNameMsg] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [setup, setSetup] = useState<{ secret: string; qr_code: string } | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState('');
  const [totpMsg, setTotpMsg] = useState('');

  const savePassword = async () => {
    setPwMsg('');
    if (!pw.next || pw.next !== pw.confirm) { setPwMsg(t('settings.account.passwordMismatch')); return; }
    try {
      await changePassword(pw.current, pw.next);
      setPw({ current: '', next: '', confirm: '' });
      setPwMsg(t('settings.account.passwordChanged'));
    } catch (e) { setPwMsg((e as Error).message); }
  };

  const saveName = async () => {
    setNameMsg('');
    try {
      await setDisplayName(name.trim());
      await qc.invalidateQueries({ queryKey: ['auth'] });
      setNameMsg(t('settings.account.nameSaved'));
    } catch (e) { setNameMsg((e as Error).message); }
  };

  return (
    <Page>
      <Section title={t('settings.account.title')} padded>
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {(auth?.display_name || auth?.username || 'U').slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium">{auth?.display_name || (auth?.username ?? t('sidebar.user'))}</div>
          <div className="text-xs text-muted-foreground">
            {auth?.display_name ? `${auth.username} · ` : ''}
            {auth?.is_admin ? t('settings.account.administrator') : t('settings.account.member')}
            {auth?.auth_enabled === false && ` · ${t('settings.account.authDisabled')}`}
          </div>
        </div>
        {auth?.auth_enabled !== false && (
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            <LogOutIcon /> {t('settings.account.logOut')}
          </Button>
        )}
      </div>
      {auth?.auth_enabled !== false && (
        <div className="pt-3">
          <div className="pb-1 text-xs text-muted-foreground">{t('settings.account.displayName')}</div>
          <div className="flex items-center gap-2">
            <Input placeholder={t('settings.account.displayNamePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} className="max-w-64" />
            <Button size="sm" variant="outline" disabled={(name.trim() || '') === (auth?.display_name ?? '')} onClick={() => void saveName()}>
              {t('common.save')}
            </Button>
            {nameMsg && <span className={cn('text-xs', nameMsg === t('settings.account.nameSaved') ? 'text-success' : 'text-destructive-foreground')}>{nameMsg}</span>}
          </div>
        </div>
      )}
      </Section>

      <Section title={t('settings.account.changePassword')} padded>
      <div className="space-y-2">
        <Input type="password" placeholder={t('settings.account.currentPassword')} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        <Input type="password" placeholder={t('settings.account.newPassword')} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        <Input type="password" placeholder={t('settings.account.confirmPassword')} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!pw.current || !pw.next} onClick={() => void savePassword()}>{t('settings.account.changeBtn')}</Button>
          {pwMsg && <span className={cn('text-xs', pwMsg === t('settings.account.passwordChanged') ? 'text-success' : 'text-destructive-foreground')}>{pwMsg}</span>}
        </div>
      </div>
      </Section>

      <Section title={t('settings.account.twoFactor')} padded>
      {totp?.enabled ? (
        <div className="space-y-2">
          <p className="text-xs text-success">{t('settings.account.twoFactorEnabled')}</p>
          <div className="flex items-center gap-2">
            <Input type="password" placeholder={t('settings.account.passwordToDisable')} className="w-56" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
            <Button size="sm" variant="destructive" disabled={!disablePw} onClick={() => {
              void totpDisable(disablePw).then(() => { setDisablePw(''); setTotpMsg(''); void refetchTotp(); }).catch((e) => setTotpMsg((e as Error).message));
            }}>{t('settings.account.disable')}</Button>
          </div>
        </div>
      ) : setup ? (
        <div className="space-y-2">
          <img src={setup.qr_code} alt={t('settings.account.qrAlt')} className="size-40 rounded-lg border bg-white p-1.5" />
          <p className="text-xs text-muted-foreground">{t('settings.account.scanHint')} <code className="font-mono">{setup.secret}</code></p>
          <div className="flex items-center gap-2">
            <Input placeholder={t('settings.account.sixDigit')} className="w-32" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button size="sm" disabled={code.length < 6} onClick={() => {
              void totpConfirm(code).then((r) => { setBackupCodes(r.backup_codes); setSetup(null); setCode(''); void refetchTotp(); }).catch((e) => setTotpMsg((e as Error).message));
            }}>{t('common.confirm')}</Button>
          </div>
        </div>
      ) : backupCodes ? (
        <div className="space-y-1.5">
          <p className="text-xs text-success">{t('settings.account.enableSaveCodes')}</p>
          <pre className="rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{backupCodes.join('\n')}</pre>
          <Button size="sm" variant="outline" onClick={() => setBackupCodes(null)}>{t('common.done')}</Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => { void totpSetup().then(setSetup).catch((e) => setTotpMsg((e as Error).message)); }}>
          {t('settings.account.enable2fa')}
        </Button>
      )}
      {totpMsg && <p className="pt-1 text-xs text-destructive-foreground">{totpMsg}</p>}
      </Section>
    </Page>
  );
}

/* ── Add Models (legacy "services") ── */

function AddModelsPanel() {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState('llm');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const queryClient = useQueryClient();
  const { data: endpoints } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['models'] });

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ text: ok, ok: true }); refresh(); } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
  };

  return (
    <Page>
      <Section title={t('settings.models.addEndpoint')} padded>
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <Input placeholder={t('settings.models.baseUrlPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
            <Select value={kind} onChange={setKind} options={[{ value: 'llm', label: t('settings.models.llm') }, { value: 'image', label: t('settings.models.image') }]} />
          </div>
          <Input placeholder={t('settings.models.apiKeyOptional')} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!url.trim()} onClick={() => void run(() => addModelEndpoint({ baseUrl: url, apiKey: apiKey || undefined, modelType: kind }), t('settings.models.endpointAdded'))}>
              <PlusIcon /> {t('common.add')}
            </Button>
            <Button size="sm" variant="outline" disabled={!url.trim()} onClick={() => void run(() => testModelEndpoint(url, apiKey || undefined), t('settings.models.connectionOk'))}>
              {t('common.test')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void run(() => discoverEndpoints(), t('settings.models.discoveryFinished'))}>
              {t('settings.models.discover')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setUrl('http://localhost:11434'); setKind('llm'); }}>
              {t('settings.models.ollamaPreset')}
            </Button>
          </div>
          {msg && <p className={cn('text-xs', msg.ok ? 'text-success' : 'text-destructive-foreground')}>{msg.text}</p>}
        </div>
      </Section>

      <Section title={t('settings.models.configured')} padded>
        <div className="space-y-1.5">
          {(endpoints ?? []).map((e) => (
            <div key={e.id} className="flex items-center justify-between rounded-lg border bg-background px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm">{e.name}</div>
                <div className="truncate text-xs text-muted-foreground">{e.base_url} · {t('settings.models.models', { count: e.models.length })}</div>
              </div>
              <span className={cn('text-xs', e.is_enabled ? 'text-success' : 'text-muted-foreground')}>
                {e.is_enabled ? t('settings.models.enabled') : t('settings.models.disabled')}
              </span>
            </div>
          ))}
          {(endpoints ?? []).length === 0 && <p className="text-xs text-muted-foreground">{t('settings.models.noEndpoints')}</p>}
        </div>
      </Section>

      <ModelDisplayNamesSection />
    </Page>
  );
}

/** Admin-set, global custom display names for models. Persisted in app
 *  settings (model_display_names), so it applies for every user. */
function ModelDisplayNamesSection() {
  const { t } = useTranslation();
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
      <Section title={t('settings.models.displayNames')}>
        {models.length === 0 && <Row label={<span className="font-normal text-muted-foreground">{t('settings.models.noModels')}</span>} />}
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
        {t('settings.models.displayNamesHintPre')}<span className="font-medium text-foreground/80">{t('settings.models.displayNamesHintEm')}</span>{t('settings.models.displayNamesHintPost')}
      </p>
      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </>
  );
}

/* ── AI Defaults (full legacy AI tab) ── */

function AiDefaultsPanel() {
  const { t } = useTranslation();
  const s = useSettingsDraft();
  if (!s.ready) return <Page><p className="text-sm text-muted-foreground">{t('common.loading')}</p></Page>;
  return (
    <Page>
      <Section title={t('settings.ai.systemPrompt')} padded>
        <p className="mb-2.5 text-xs text-muted-foreground/80">
          {t('settings.ai.systemPromptHint')}
        </p>
        <Textarea
          className="min-h-[140px] font-mono text-[13px]"
          placeholder={t('settings.ai.systemPromptPlaceholder')}
          value={String(s.value('custom_system_prompt') ?? '')}
          onChange={(e) => s.setValue('custom_system_prompt', e.target.value)}
        />
      </Section>

      <Section title={t('settings.ai.defaultModel')}>
        <EndpointModelRows s={s} epKey="default_endpoint_id" modelKey="default_model" label={t('settings.ai.defaultLabel')} />
        <FallbacksEditor s={s} k="default_model_fallbacks" />
      </Section>

      <Section title={t('settings.ai.utilityModel')}>
        <Row label={t('settings.ai.utilityRow')} hint={t('settings.ai.utilityHint')} />
        <EndpointModelRows s={s} epKey="utility_endpoint_id" modelKey="utility_model" label={t('settings.ai.utilityLabel')} />
        <FallbacksEditor s={s} k="utility_model_fallbacks" />
      </Section>

      <Section title={t('settings.ai.contextMgmt')}>
        <TextRow s={s} k="compact_threshold" label={t('settings.ai.autoCompact')} hint={t('settings.ai.autoCompactHint')} width="w-24" />
        <BoolRow s={s} k="context_compression" label={t('settings.ai.toolCompression')} hint={t('settings.ai.toolCompressionHint')} />
      </Section>

      <Section title={t('settings.ai.vision')}>
        <BoolRow s={s} k="vision_enabled" label={t('settings.ai.visionEnabled')} />
        <VisionModelRow s={s} />
        <FallbacksEditor s={s} k="vision_model_fallbacks" />
      </Section>

      <Section title={t('settings.ai.agent')}>
        <TextRow s={s} k="agent_max_tool_calls" label={t('settings.ai.toolCallLimit')} hint={t('settings.ai.toolCallLimitHint')} type="number" width="w-24" />
        <TextRow s={s} k="agent_max_rounds" label={t('settings.ai.maxSteps')} type="number" width="w-24" />
      </Section>

      <SaveBar dirty={s.dirty} saving={s.save.isPending} error={s.save.isError ? (s.save.error as Error).message : undefined} onSave={() => s.save.mutate()} />
    </Page>
  );
}

/* ── Integrations (web search + integration CRUD) ── */

function IntegrationsPanel() {
  const { t } = useTranslation();
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
      <Section title={t('settings.integrations.title')} padded>
        <p className="pb-2 text-xs text-muted-foreground">{t('settings.integrations.hint')}</p>
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
                  aria-label={t('settings.integrations.deleteItem', { name: String(it.name ?? id) })}
                  onClick={() => void deleteIntegration(id).then(refresh).catch((e) => setMsg((e as Error).message))}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive-foreground"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            );
          })}
          {(integrations ?? []).length === 0 && <p className="text-xs text-muted-foreground">{t('settings.integrations.none')}</p>}
        </div>

        <div className="space-y-2 border-t border-border/60 pt-3 mt-3">
          <div className="text-sm font-medium">{t('settings.integrations.addIntegration')}</div>
          {presetEntries.length > 0 && (
            <Select
              className="w-full"
              value={preset}
              onChange={(v) => {
                setPreset(v);
                const p = (presets ?? {})[v];
                if (p) setForm((f) => ({ ...f, name: String(p.name ?? v), base_url: String(p.base_url ?? '') }));
              }}
              options={[{ value: '', label: t('settings.integrations.custom') }, ...presetEntries.map(([k, p]) => ({ value: k, label: String(p.name ?? k) }))]}
            />
          )}
          <Input placeholder={t('settings.integrations.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input placeholder={t('settings.integrations.baseUrl')} value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
          <Input placeholder={t('settings.integrations.apiKey')} type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
          <Button size="sm" disabled={!form.name.trim()} onClick={() => void add()}><PlusIcon /> {t('common.add')}</Button>
          {msg && <p className="text-xs text-destructive-foreground">{msg}</p>}
        </div>
      </Section>

      <SqlDatabaseSection />
      <SqlContextSection />
    </Page>
  );
}

/** Upload schema/navigation files for the SQL databases. They're indexed as a
 *  small scoped RAG (meta.scope="sql"); whenever the SQL source is on in chat,
 *  the chunks most relevant to the question are retrieved and injected so the
 *  model can navigate the database (see agent_loop force_db note). */
function SqlContextSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const { data } = useQuery({ queryKey: ['sql-knowledge'], queryFn: fetchSqlKnowledge });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['sql-knowledge'] });

  const upload = useMutation({
    mutationFn: (files: File[]) => uploadSqlKnowledge(files),
    onSuccess: (r) => {
      const names = Array.isArray((r as { uploaded?: unknown }).uploaded) ? (r as { uploaded: string[] }).uploaded : [];
      setMsg({ text: t('settings.sql.knowledgeQueued', { count: names.length }), ok: true });
      refresh();
    },
    onError: (e) => setMsg({ text: (e as Error).message, ok: false }),
  });
  const remove = useMutation({
    mutationFn: (source: string) => deleteSqlKnowledge(source),
    onSuccess: refresh,
    onError: (e) => setMsg({ text: (e as Error).message, ok: false }),
  });

  const docs = data?.documents ?? [];
  return (
    <Section title={t('settings.sql.contextTitle')} padded>
      <p className="mb-3 text-xs text-muted-foreground/80">{t('settings.sql.contextHint')}</p>

      {data && !data.available ? (
        <p className="text-xs text-destructive-foreground">{data.error || t('settings.sql.knowledgeUnavailable')}</p>
      ) : (
        <>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files?.length) upload.mutate(Array.from(e.target.files)); e.target.value = ''; }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
              <PlusIcon /> {upload.isPending ? t('settings.sql.knowledgeUploading') : t('settings.sql.knowledgeUpload')}
            </Button>
            <Button size="sm" variant="outline" onClick={refresh}>{t('common.refresh')}</Button>
            {msg && <span className={cn('text-xs', msg.ok ? 'text-success' : 'text-destructive-foreground')}>{msg.text}</span>}
          </div>

          <div className="mt-3 space-y-1.5">
            {docs.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.sql.knowledgeEmpty')}</p>}
            {docs.map((d) => (
              <div key={d.source} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2">
                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{d.filename}</div>
                  <div className="truncate text-xs text-muted-foreground">{t('settings.sql.knowledgeChunks', { count: d.chunks })}</div>
                </div>
                <button
                  type="button"
                  aria-label={t('settings.sql.knowledgeDelete', { name: d.filename })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(d.source)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive-foreground"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

const SQL_DEFAULT_PORTS: Record<string, string> = { mssql: '1433', postgresql: '5432', mysql: '3306', sqlite: '' };

let _sqlRowSeq = 0;
const newSqlRow = (): SqlConfig => ({
  id: `new-${++_sqlRowSeq}`,
  name: '',
  enabled: true,
  db_type: 'mssql',
  host: '',
  port: '',
  database: '',
  username: '',
  password: '',
  odbc_driver: '',
});

/** Stacked label-above-control field. Full-width controls below the label
 *  stay readable when translations (e.g. German) run long, unlike a
 *  fixed-width control crammed beside the label. */
function SqlField({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SqlDatabaseSection() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['sql-config'], queryFn: fetchSqlConfig });
  const [draft, setDraft] = useState<SqlConfig[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (data && !draft) setDraft(data.map((c) => ({ ...c, db_type: c.db_type || 'mssql', password: '' })));
  }, [data, draft]);
  if (!draft) return <Section title={t('settings.sql.title')} padded><p className="text-sm text-muted-foreground">{t('common.loading')}</p></Section>;

  const setRow = (i: number, k: keyof SqlConfig, v: unknown) =>
    setDraft(draft.map((row, idx) => (idx === i ? ({ ...row, [k]: v } as SqlConfig) : row)));
  const run = (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    fn()
      .then(() => { setMsg({ text: ok, ok: true }); void queryClient.invalidateQueries({ queryKey: ['sql-config'] }); })
      .catch((e) => setMsg({ text: (e as Error).message, ok: false }));
  };
  const save = () => run(async () => {
    await saveSqlConfig(draft);
    setDraft(null); // re-seed from the refetched server state (resolves ids, password_set)
  }, t('settings.sql.saved'));

  return (
    <Section title={t('settings.sql.title')}>
      <div className="px-4 pt-3.5 text-xs text-muted-foreground sm:px-5">
        {t('settings.sql.intro')}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
        {draft.length === 0 && <p className="text-sm text-muted-foreground">{t('settings.sql.empty')}</p>}
        {draft.map((row, i) => {
          const saved = data?.find((d) => d.id === row.id);
          return (
            <div key={row.id ?? i} className="rounded-lg border border-border/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[10rem] flex-1" placeholder={t('settings.sql.namePlaceholder')}
                  value={row.name} onChange={(e) => setRow(i, 'name', e.target.value)}
                />
                <Switch checked={row.enabled} onCheckedChange={(v) => setRow(i, 'enabled', v)} />
                <Button
                  size="sm" variant="outline"
                  onClick={() => run(
                    // /api/sql/test reports failures as HTTP 200 + {ok:false, error}.
                    () => testSqlConfig(row.id).then((r) => { if (!r.ok) throw new Error(r.error || t('settings.sql.connectionFailed')); }),
                    t('settings.sql.connectionOk'),
                  )}
                >{t('common.test')}</Button>
                <Button
                  size="sm" variant="destructive-outline"
                  onClick={() => setDraft(draft.filter((_, idx) => idx !== i))}
                >{t('common.remove')}</Button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                <SqlField label={t('settings.sql.type')}>
                  <Select
                    className="w-full" value={row.db_type} onChange={(v) => setRow(i, 'db_type', v)}
                    options={[
                      { value: 'mssql', label: 'MSSQL' },
                      { value: 'postgresql', label: 'PostgreSQL' },
                      { value: 'mysql', label: 'MySQL/MariaDB' },
                      { value: 'sqlite', label: 'SQLite' },
                    ]}
                  />
                </SqlField>
                <SqlField label={t('settings.sql.host')}>
                  <Input placeholder="db.example.local" value={row.host} onChange={(e) => setRow(i, 'host', e.target.value)} />
                </SqlField>
                <SqlField label={t('settings.sql.port')}>
                  <Input placeholder={SQL_DEFAULT_PORTS[row.db_type] ?? ''} value={row.port} onChange={(e) => setRow(i, 'port', e.target.value)} />
                </SqlField>
                <SqlField label={t('settings.sql.database')}>
                  <Input placeholder={t('settings.sql.databasePlaceholder')} value={row.database} onChange={(e) => setRow(i, 'database', e.target.value)} />
                </SqlField>
                <SqlField label={t('settings.sql.readonlyUser')}>
                  <Input autoComplete="off" value={row.username} onChange={(e) => setRow(i, 'username', e.target.value)} />
                </SqlField>
                <SqlField label={t('settings.sql.password')}>
                  <Input
                    type="password" autoComplete="new-password"
                    placeholder={saved?.password_set ? t('settings.sql.passwordSaved') : ''}
                    value={row.password ?? ''} onChange={(e) => setRow(i, 'password', e.target.value)}
                  />
                </SqlField>
                <SqlField label={t('settings.sql.odbcDriver')} className="sm:col-span-2">
                  <Input placeholder="ODBC Driver 18 for SQL Server" value={row.odbc_driver} onChange={(e) => setRow(i, 'odbc_driver', e.target.value)} />
                </SqlField>
              </div>
            </div>
          );
        })}
        <div>
          <Button size="sm" variant="outline" onClick={() => setDraft([...draft, newSqlRow()])}><PlusIcon /> {t('settings.sql.addDatabase')}</Button>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3.5 sm:px-5">
        <Button size="sm" onClick={save}>{t('common.save')}</Button>
        {msg && <span className={cn('text-xs', msg.ok ? 'text-success' : 'text-destructive-foreground')}>{msg.text}</span>}
      </div>
    </Section>
  );
}

/* ── Agent Tools (built-in tool toggles, grouped by category like legacy) ── */

/** Category + approximate context cost per tool. Display name & description
 *  come from i18n (settings.toolMeta.<id>.name/desc). */
const TOOL_META: Record<string, { cat: string; ctx: string }> = {
  bash: { cat: 'Code', ctx: '~200' },
  python: { cat: 'Code', ctx: '~200' },
  read_file: { cat: 'Code', ctx: '~150' },
  write_file: { cat: 'Code', ctx: '~150' },
  search_chats: { cat: 'Search', ctx: '~150' },
  create_document: { cat: 'Documents', ctx: '~200' },
  update_document: { cat: 'Documents', ctx: '~200' },
  edit_document: { cat: 'Documents', ctx: '~200' },
  suggest_document: { cat: 'Documents', ctx: '~200' },
  manage_documents: { cat: 'Documents', ctx: '~150' },
  generate_image: { cat: 'Media', ctx: '~150' },
  manage_skills: { cat: 'Knowledge', ctx: '~200' },
  manage_rag: { cat: 'Knowledge', ctx: '~150' },
  query_sql: { cat: 'Knowledge', ctx: '~200' },
  send_to_session: { cat: 'Sessions', ctx: '~100' },
  create_session: { cat: 'Sessions', ctx: '~100' },
  list_sessions: { cat: 'Sessions', ctx: '~100' },
  manage_session: { cat: 'Sessions', ctx: '~100' },
  list_models: { cat: 'System', ctx: '~100' },
  api_call: { cat: 'System', ctx: '~200' },
  manage_endpoints: { cat: 'System', ctx: '~100' },
  manage_mcp: { cat: 'System', ctx: '~100' },
  manage_tokens: { cat: 'System', ctx: '~100' },
  manage_settings: { cat: 'System', ctx: '~100' },
};
const TOOL_CAT_ORDER = ['Code', 'Search', 'Documents', 'Media', 'Knowledge', 'Sessions', 'System', 'Other'];

function ToolsPanel() {
  const { t } = useTranslation();
  const { data: tools } = useQuery({ queryKey: ['builtin-tools'], queryFn: fetchBuiltinTools });
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: saveDisabledTools,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['builtin-tools'] }),
  });

  if (!tools) return <Page><p className="text-sm text-muted-foreground">{t('common.loading')}</p></Page>;
  if (tools.length === 0) return <Page><p className="text-sm text-muted-foreground">{t('settings.tools.noTools')}</p></Page>;

  // Resolve display name/desc from i18n; fall back to the raw id for unknowns.
  const toolName = (id: string) => TOOL_META[id] ? t(`settings.toolMeta.${id}.name`) : id;
  const toolDesc = (id: string) => TOOL_META[id] ? t(`settings.toolMeta.${id}.desc`) : '';

  const setEnabled = (changes: Record<string, boolean>) => {
    const disabled = tools
      .filter((tool) => !(changes[tool.id] ?? tool.enabled))
      .map((tool) => tool.id);
    save.mutate(disabled);
  };

  const groups = new Map<string, Array<{ id: string; enabled: boolean; ctx: string }>>();
  for (const tool of tools) {
    const meta = TOOL_META[tool.id] ?? { cat: 'Other', ctx: '?' };
    if (!groups.has(meta.cat)) groups.set(meta.cat, []);
    groups.get(meta.cat)!.push({ id: tool.id, enabled: tool.enabled, ctx: meta.ctx });
  }

  return (
    <Page className="gap-2.5">
      <SectionHeader>{t('settings.tools.title')}</SectionHeader>
      <p className="-mt-1.5 px-1 text-xs text-muted-foreground">{t('settings.tools.hint')}</p>
      {TOOL_CAT_ORDER.filter((c) => groups.has(c)).map((cat) => {
        const items = groups.get(cat)!;
        const enabledCount = items.filter((i) => i.enabled).length;
        const open = !!openCats[cat];
        return (
          <div key={cat} className="overflow-hidden rounded-md border bg-card">
            <div className="flex w-full items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setOpenCats((o) => ({ ...o, [cat]: !o[cat] }))}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
              >
                <ChevronRightIcon className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
                {t(`settings.tools.cats.${cat}`)}
                <span className="text-[11px] text-muted-foreground">{enabledCount}/{items.length}</span>
              </button>
              <Switch
                checked={enabledCount === items.length}
                onCheckedChange={(v) => setEnabled(Object.fromEntries(items.map((i) => [i.id, v])))}
              />
            </div>
            {open && (
              <div className="border-t">
                {items.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 px-3 py-2 not-last:border-b">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{toolName(item.id)}</div>
                      <div className="truncate text-xs text-muted-foreground">{toolDesc(item.id)}</div>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title={t('settings.tools.ctxTitle')}>{item.ctx}</span>
                    <Switch checked={item.enabled} onCheckedChange={(v) => setEnabled({ [item.id]: v })} />
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

/** Per-URL-field endpoint probe: which backend test to run and which sibling
 *  draft fields (model/key/dataset) to send along. */
interface EndpointTest { kind: string; modelKey?: keyof RagConfig; apiKeyKey?: keyof RagConfig; datasetKey?: keyof RagConfig }

/** Compact disclosure for optional processing lanes. The feature state remains
 *  visible without rendering every explanatory row at once. */
function RagDisclosure({ title, enabled, children }: { title: string; enabled?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  return (
    <div className={cn('overflow-hidden rounded-md border border-border/60 bg-background/40', open && 'sm:col-span-2')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
        {enabled !== undefined && (
          <span className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            enabled ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
          )}>
            {t(enabled ? 'settings.rag.active' : 'settings.rag.inactive')}
          </span>
        )}
      </button>
      {open && <div className="border-t border-border/60">{children}</div>}
    </div>
  );
}

export function RagPanel() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['rag-config'], queryFn: fetchRagConfig });
  const [draft, setDraft] = useState<RagConfig | null>(null);
  const [searchQ, setSearchQ] = useState('');
  const [searchK, setSearchK] = useState(5);
  const [searchOut, setSearchOut] = useState('');
  const [dir, setDir] = useState('');
  const [docMsg, setDocMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // Per-upload PII-redaction override: null = follow the global toggle.
  const [uploadRedact, setUploadRedact] = useState<boolean | null>(null);
  const [testingEp, setTestingEp] = useState<keyof RagConfig | null>(null);
  const pushConsole = useRagConsole((s) => s.push);
  const queryClient = useQueryClient();
  useEffect(() => { if (data && !draft) setDraft(data); }, [data, draft]);
  const save = useMutation({
    mutationFn: (cfg: RagConfig) => saveRagConfig(cfg),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['rag-config'] }),
  });
  const test = useMutation({ mutationFn: testRagConfig });
  // Indexed-documents view polls while open. The live ingest queue + worker
  // status now live in the /rag activity rail (RagActivity), not here.
  const docs = useQuery({ queryKey: ['rag-documents'], queryFn: fetchRagDocuments, refetchInterval: 5000 });
  const refreshIngest = () => {
    void queryClient.invalidateQueries({ queryKey: ['rag-jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['rag-documents'] });
  };
  const removeDoc = (source: string) =>
    deleteRagDocument(source).then(() => queryClient.invalidateQueries({ queryKey: ['rag-documents'] }));
  if (!draft) return <Page><p className="text-sm text-muted-foreground">{t('common.loading')}</p></Page>;
  const set = (k: keyof RagConfig, v: unknown) => setDraft({ ...draft, [k]: v } as RagConfig);
  const str = (k: keyof RagConfig) => String(draft[k] ?? '');
  const testEndpoint = (k: keyof RagConfig, label: string, ep: EndpointTest) => {
    setTestingEp(k);
    testRagEndpoint({
      kind: ep.kind,
      url: str(k),
      model: ep.modelKey ? str(ep.modelKey) : undefined,
      api_key: ep.apiKeyKey ? str(ep.apiKeyKey) : undefined,
      dataset_id: ep.datasetKey ? str(ep.datasetKey) : undefined,
    })
      .then((r) => pushConsole(`${label}: ${t('settings.rag.endpointOk')}${r.detail ? ` (${r.detail})` : ''}`, 'ok'))
      .catch((e) => pushConsole(`${label}: ${(e as Error).message}`, 'error'))
      .finally(() => setTestingEp(null));
  };
  const field = (
    k: keyof RagConfig,
    label: string,
    opts: { type?: string; hint?: string; def?: string | number; test?: EndpointTest } = {},
  ) => {
    const type = opts.type ?? 'text';
    const hint = (opts.hint || opts.def !== undefined) ? (
      <>
        {opts.hint}
        {opts.def !== undefined && (
          <>
            {opts.hint ? ' · ' : ''}
            {t('settings.rag.defaultLabel')}: <code className="rounded bg-muted px-1 font-mono text-[11px]">{String(opts.def) || '—'}</code>
          </>
        )}
      </>
    ) : undefined;
    return (
      <Row label={label} hint={hint} stacked>
        {type === 'textarea' ? (
          <Textarea className="min-h-[64px] w-full xl:w-56" value={String(draft[k] ?? '')} onChange={(e) => set(k, e.target.value)} />
        ) : (
          <div className={cn(
            'flex w-full gap-2 xl:w-auto',
            opts.test ? 'flex-col items-stretch xl:flex-row xl:items-center' : 'items-center',
          )}>
            <Input className="min-w-0 flex-1 xl:w-48 xl:flex-none" type={type} step={type === 'number' ? 'any' : undefined} value={String(draft[k] ?? '')}
              onChange={(e) => set(k, type === 'number' ? Number(e.target.value) : e.target.value)} />
            {opts.test && (
              <Button className="self-end xl:self-auto" size="sm" variant="outline" disabled={!str(k).trim() || testingEp !== null}
                onClick={() => testEndpoint(k, label, opts.test!)}>
                {testingEp === k ? t('settings.rag.testing') : t('settings.rag.test')}
              </Button>
            )}
          </div>
        )}
      </Row>
    );
  };
  const doc = (fn: () => Promise<unknown>, ok: string) => {
    setDocMsg(null);
    fn().then(() => setDocMsg({ text: ok, ok: true })).catch((e) => setDocMsg({ text: (e as Error).message, ok: false }));
  };
  return (
    <Page className="gap-5 p-0 [&_.settings-row-hint]:line-clamp-2 [&_.settings-row-hint:hover]:line-clamp-none">
      <Section title={t('settings.rag.pipeline')}>
        <Row label={t('settings.rag.ragEnabled')} hint={t('settings.rag.hint.enabled')}><Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} /></Row>
        <Row label={t('settings.rag.provider')} hint={t('settings.rag.hint.provider')} stacked>
          <Select
            className="w-full xl:w-48"
            value={(draft.provider || 'internal')}
            onChange={(v) => set('provider', v)}
            options={[
              { value: 'internal', label: t('settings.rag.providerInternal') },
              { value: 'external', label: t('settings.rag.providerExternal') },
            ]}
          />
        </Row>
        {(draft.provider || 'internal') === 'external' ? (
          <>
            {field('external_url', t('settings.rag.externalUrl'), { hint: t('settings.rag.hint.externalUrl'), def: 'http://ragflow/api/v1/retrieval', test: { kind: 'external', apiKeyKey: 'external_api_key', datasetKey: 'external_dataset_id' } })}
            {field('external_api_key', t('settings.rag.externalApiKey'), { type: 'password', hint: t('settings.rag.hint.externalApiKey') })}
            {field('external_dataset_id', t('settings.rag.externalDatasetId'), { hint: t('settings.rag.hint.externalDatasetId') })}
            {field('external_top_k', t('settings.rag.externalTopK'), { type: 'number', hint: t('settings.rag.hint.externalTopK'), def: 5 })}
          </>
        ) : (
          <>
            {field('embedding_url', t('settings.rag.embeddingUrl'), { hint: t('settings.rag.hint.embeddingUrl'), def: 'http://host:8001/v1/embeddings', test: { kind: 'embedding', modelKey: 'embedding_model' } })}
            {field('embedding_model', t('settings.rag.embeddingModel'), { hint: t('settings.rag.hint.embeddingModel'), def: 'qwen3-embed' })}
            {field('qdrant_url', t('settings.rag.qdrantUrl'), { hint: t('settings.rag.hint.qdrantUrl'), def: 'http://qdrant:6333', test: { kind: 'qdrant', apiKeyKey: 'qdrant_api_key' } })}
            {field('qdrant_api_key', t('settings.rag.qdrantApiKey'), { type: 'password', hint: t('settings.rag.hint.qdrantApiKey') })}
            {field('rerank_url', t('settings.rag.rerankUrl'), { hint: t('settings.rag.hint.rerankUrl'), def: 'http://host:8002/v1/rerank', test: { kind: 'rerank', modelKey: 'rerank_model', apiKeyKey: 'rerank_api_key' } })}
            {field('rerank_model', t('settings.rag.rerankModel'), { hint: t('settings.rag.hint.rerankModel'), def: 'qwen3-reranker' })}
            {field('rerank_api_key', t('settings.rag.rerankApiKey'), { type: 'password', hint: t('settings.rag.hint.rerankApiKey') })}
            {field('sparse_model', t('settings.rag.sparseModel'), { hint: t('settings.rag.hint.sparseModel'), def: 'Qdrant/bm25' })}
          </>
        )}
      </Section>

      {(draft.provider || 'internal') !== 'external' && (
        <Section title={t('settings.rag.searchTuning')}>
          {field('chat_top_k', t('settings.rag.chatTopK'), { type: 'number', hint: t('settings.rag.hint.chatTopK'), def: 5 })}
          {field('search_top_k', t('settings.rag.searchTopK'), { type: 'number', hint: t('settings.rag.hint.searchTopK'), def: 5 })}
          {field('candidate_top_k', t('settings.rag.candidateTopK'), { type: 'number', hint: t('settings.rag.hint.candidateTopK'), def: 40 })}
          {field('rerank_min_score', t('settings.rag.rerankMinScore'), { type: 'number', hint: t('settings.rag.hint.rerankMinScore'), def: 0.3 })}
          {field('similarity_threshold', t('settings.rag.similarityThreshold'), { type: 'number', hint: t('settings.rag.hint.similarityThreshold'), def: 0 })}
          {field('max_context_chars', t('settings.rag.maxContextChars'), { type: 'number', hint: t('settings.rag.hint.maxContextChars'), def: 10000 })}
          {field('query_prefix', t('settings.rag.queryPrefix'), { type: 'textarea', hint: t('settings.rag.hint.queryPrefix'), def: '' })}
          {field('context_prompt', t('settings.rag.contextPrompt'), { type: 'textarea', hint: t('settings.rag.hint.contextPrompt'), def: '' })}
        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-4 py-3.5 sm:px-5">
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? t('common.saving') : t('common.save')}</Button>
          <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? t('settings.rag.testing') : t('settings.rag.testConnection')}</Button>
          {test.isSuccess && (
            <span className={cn('text-xs', test.data?.ok === false ? 'text-destructive-foreground' : 'text-success')}>
              {test.data?.ok === false ? t('settings.rag.testFailed') : t('settings.rag.ok')}
            </span>
          )}
        </div>
      </Section>
      )}

      {(draft.provider || 'internal') !== 'external' && (
        <Section title={t('settings.rag.processing')} padded>
          <div className="grid gap-2 sm:grid-cols-2">
            <RagDisclosure title={t('settings.rag.asrTitle')} enabled={!!draft.video_asr_enabled}>
              <Row label={t('settings.rag.asrEnabled')} hint={t('settings.rag.hint.asrEnabled')}><Switch checked={!!draft.video_asr_enabled} onCheckedChange={(v) => set('video_asr_enabled', v)} /></Row>
              {draft.video_asr_enabled && <>
                {field('video_asr_url', t('settings.rag.asrUrl'), { hint: t('settings.rag.hint.asrUrl'), def: 'http://host:8003/v1/audio/transcriptions', test: { kind: 'asr' } })}
                {field('video_asr_language', t('settings.rag.asrLanguage'), { hint: t('settings.rag.hint.asrLanguage'), def: 'auto' })}
                {field('video_asr_prompt', t('settings.rag.asrPrompt'), { type: 'textarea', hint: t('settings.rag.hint.asrPrompt') })}
                <Row label={t('settings.rag.asrCorrect')} hint={t('settings.rag.hint.asrCorrect')}><Switch checked={!!draft.video_asr_correct_enabled} onCheckedChange={(v) => set('video_asr_correct_enabled', v)} /></Row>
                <Row label={t('settings.rag.videoFramesEnabled')} hint={t('settings.rag.hint.videoFramesEnabled')}><Switch checked={!!draft.video_frames_enabled} onCheckedChange={(v) => set('video_frames_enabled', v)} /></Row>
                {draft.video_frames_enabled && <>
                  {field('video_frames_interval_sec', t('settings.rag.videoFramesInterval'), { type: 'number', hint: t('settings.rag.hint.videoFramesInterval'), def: 8 })}
                  {field('video_frames_max', t('settings.rag.videoFramesMax'), { type: 'number', hint: t('settings.rag.hint.videoFramesMax'), def: 300 })}
                </>}
              </>}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.imageTitle')} enabled={!!draft.image_pixel_enabled}>
              <Row label={t('settings.rag.imageEnabled')} hint={t('settings.rag.hint.imageEnabled')}><Switch checked={!!draft.image_pixel_enabled} onCheckedChange={(v) => set('image_pixel_enabled', v)} /></Row>
              {draft.image_pixel_enabled && <>
                {field('image_embed_url', t('settings.rag.imageUrl'), { hint: t('settings.rag.hint.imageUrl'), def: 'http://host:8004/v1/embeddings', test: { kind: 'image_embed', modelKey: 'image_embed_model' } })}
                {field('image_embed_model', t('settings.rag.imageModel'), { hint: t('settings.rag.hint.imageModel'), def: 'qwen3-vl-embed' })}
              </>}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.codeTitle')} enabled={!!draft.code_lane_enabled}>
              <Row label={t('settings.rag.codeEnabled')} hint={t('settings.rag.hint.codeEnabled')}><Switch checked={!!draft.code_lane_enabled} onCheckedChange={(v) => set('code_lane_enabled', v)} /></Row>
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.queryTitle')} enabled={!!draft.query_rewrite_enabled}>
              <Row label={t('settings.rag.queryRewriteEnabled')} hint={t('settings.rag.hint.queryRewriteEnabled')}><Switch checked={!!draft.query_rewrite_enabled} onCheckedChange={(v) => set('query_rewrite_enabled', v)} /></Row>
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.contextualTitle')} enabled={!!draft.contextual_retrieval_enabled || (draft.auto_keywords_n || 0) > 0 || (draft.auto_questions_n || 0) > 0}>
              <Row label={t('settings.rag.contextualEnabled')} hint={t('settings.rag.hint.contextualEnabled')}><Switch checked={!!draft.contextual_retrieval_enabled} onCheckedChange={(v) => set('contextual_retrieval_enabled', v)} /></Row>
              {field('auto_keywords_n', t('settings.rag.autoKeywords'), { type: 'number', hint: t('settings.rag.hint.autoKeywords'), def: 0 })}
              {field('auto_questions_n', t('settings.rag.autoQuestions'), { type: 'number', hint: t('settings.rag.hint.autoQuestions'), def: 0 })}
              {(draft.contextual_retrieval_enabled || (draft.auto_keywords_n || 0) > 0 || (draft.auto_questions_n || 0) > 0) && <>
                {field('llm_url', t('settings.rag.llmUrl'), { hint: t('settings.rag.hint.llmUrl'), def: 'http://host:8000/v1/chat/completions', test: { kind: 'llm', modelKey: 'llm_model' } })}
                {field('llm_model', t('settings.rag.llmModel'), { hint: t('settings.rag.hint.llmModel'), def: 'qwen3-llm' })}
              </>}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.parentTitle')} enabled={!!draft.expand_to_parent_enabled}>
              <Row label={t('settings.rag.expandToParent')} hint={t('settings.rag.hint.expandToParent')}><Switch checked={!!draft.expand_to_parent_enabled} onCheckedChange={(v) => set('expand_to_parent_enabled', v)} /></Row>
              {draft.expand_to_parent_enabled && field('parent_max_chars', t('settings.rag.parentMaxChars'), { type: 'number', hint: t('settings.rag.hint.parentMaxChars'), def: 2000 })}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.pdfVlmTitle')} enabled={!!draft.pdf_vlm_enabled}>
              <Row label={t('settings.rag.pdfVlmEnabled')} hint={t('settings.rag.hint.pdfVlmEnabled')}><Switch checked={!!draft.pdf_vlm_enabled} onCheckedChange={(v) => set('pdf_vlm_enabled', v)} /></Row>
              {draft.pdf_vlm_enabled && <>
                {field('vlm_url', t('settings.rag.vlmUrl'), { hint: t('settings.rag.hint.vlmUrl'), def: 'http://host:8000/v1/chat/completions', test: { kind: 'vlm', modelKey: 'vlm_model' } })}
                {field('vlm_model', t('settings.rag.vlmModel'), { hint: t('settings.rag.hint.vlmModel'), def: 'qwen3-llm' })}
              </>}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.redactTitle')} enabled={!!draft.redact_pii_enabled}>
              <Row label={t('settings.rag.redactEnabled')} hint={t('settings.rag.hint.redactEnabled')}><Switch checked={!!draft.redact_pii_enabled} onCheckedChange={(v) => set('redact_pii_enabled', v)} /></Row>
            </RagDisclosure>
          </div>
        </Section>
      )}

      <Section title={t('settings.rag.documents')} padded>
      <div className="space-y-2">
        <label className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => document.getElementById('rag-upload-input')?.click()}>{t('settings.rag.uploadFiles')}</Button>
          <input
            id="rag-upload-input" type="file" multiple hidden
            onChange={(e) => { if (e.target.files?.length) doc(() => personalUpload(Array.from(e.target.files!), { redactPii: uploadRedact }).then((r) => { refreshIngest(); return r; }), t('settings.rag.uploadQueued')); e.target.value = ''; }}
          />
          <Button size="sm" variant="outline" onClick={() => doc(() => personalReload().then((r) => { refreshIngest(); return r; }), t('settings.rag.reindexStarted'))}>{t('settings.rag.reloadIndex')}</Button>
        </label>
        {/* Per-upload PII-redaction choice; travels with the files being uploaded
            and overrides the global toggle for exactly those documents. */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('settings.rag.uploadRedact')}</span>
          <Select
            className="w-40 text-xs"
            value={uploadRedact === null ? 'default' : uploadRedact ? 'on' : 'off'}
            onChange={(value) => setUploadRedact(value === 'default' ? null : value === 'on')}
            options={[
              { value: 'default', label: t('settings.rag.uploadRedactDefault') },
              { value: 'on', label: t('settings.rag.uploadRedactOn') },
              { value: 'off', label: t('settings.rag.uploadRedactOff') },
            ]}
          />
        </div>
        <div className="flex gap-2">
          <Input placeholder={t('settings.rag.addDirectory')} value={dir} onChange={(e) => setDir(e.target.value)} />
          <Button size="sm" variant="outline" disabled={!dir.trim()} onClick={() => doc(() => personalAddDirectory(dir).then((r) => { refreshIngest(); return r; }), t('settings.rag.directoryAdded'))}>{t('common.add')}</Button>
        </div>
        {docMsg && <p className={cn('text-xs', docMsg.ok ? 'text-success' : 'text-destructive-foreground')}>{docMsg.text}</p>}
        <div className="flex gap-2 pt-1">
          <Input placeholder={t('settings.rag.testSearch')} value={searchQ} onChange={(e) => setSearchQ(e.target.value)} />
          <Input type="number" className="w-16" value={searchK} onChange={(e) => setSearchK(Number(e.target.value) || 5)} />
          <Button size="sm" variant="outline" disabled={!searchQ.trim()} onClick={() => {
            void ragSearch(searchQ, searchK).then((r) => setSearchOut(JSON.stringify(r, null, 2))).catch((e) => setSearchOut((e as Error).message));
          }}>{t('settings.rag.search')}</Button>
        </div>
        {searchOut && <pre className="max-h-48 overflow-y-auto rounded-lg border bg-muted px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">{searchOut}</pre>}
      </div>
      </Section>

      <Section title={t('settings.rag.indexedDocs')} padded>
        {docs.data && docs.data.available === false ? (
          <p className="text-xs text-destructive-foreground">{docs.data.error || t('settings.rag.ragUnavailable')}</p>
        ) : !docs.data?.documents || docs.data.documents.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('settings.rag.noDocs')}</p>
        ) : (
          <div className="space-y-1">
            <p className="pb-1 text-[11px] text-muted-foreground">{t('settings.rag.docCount', { n: docs.data.documents.length })}</p>
            {docs.data.documents.map((d) => (
              <div key={d.source} className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-xs">
                <span className="truncate" title={d.source}>{d.filename}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{t('settings.rag.chunksN', { n: d.chunks })}</span>
                <button className="shrink-0 text-muted-foreground hover:text-destructive-foreground"
                  onClick={() => void removeDoc(d.source)}>{t('common.delete')}</button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}

/* ── System (backup + danger zone) ── */

const WIPE_KINDS = ['chats', 'skills', 'notes', 'documents', 'gallery', 'calendar'];

function SystemPanel() {
  const { t } = useTranslation();
  const [msg, setMsg] = useState('');
  return (
    <Page>
      <Section title={t('settings.system.dataBackup')} padded>
        <p className="pb-2 text-xs text-muted-foreground">
          {t('settings.system.backupHint')}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { window.location.href = '/api/export'; }}>{t('settings.system.exportData')}</Button>
          <Button variant="outline" size="sm" onClick={() => document.getElementById('sys-import-input')?.click()}>{t('settings.system.importData')}</Button>
          <input
            id="sys-import-input" type="file" accept=".json" hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void file.text()
                .then((txt) => importData(JSON.parse(txt)))
                .then((r) => setMsg(r.message ?? t('settings.system.importSuccess')))
                .catch((err) => setMsg((err as Error).message));
            }}
          />
        </div>
      </Section>

      <Section title={t('settings.system.dangerZone')}>
        <div className="px-4 pt-3.5 text-xs text-muted-foreground sm:px-5">
          {t('settings.system.dangerHint')}
        </div>
        {WIPE_KINDS.map((kind) => {
          const label = t(`settings.system.rows.${kind}.label`);
          return (
            <Row key={kind} label={label} hint={t(`settings.system.rows.${kind}.sub`)}>
              <Button
                variant="destructive-outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  if (window.confirm(t('settings.system.wipeConfirm', { label }))) {
                    void wipeData(kind).then(() => setMsg(t('settings.system.wiped', { kind }))).catch((e) => setMsg((e as Error).message));
                  }
                }}
              >
                {t('settings.system.wipe')}
              </Button>
            </Row>
          );
        })}
      </Section>
      {msg && <p className="px-1 text-xs text-muted-foreground">{msg}</p>}
    </Page>
  );
}

/* ── Named AI endpoints (assistant profiles) ── */

const EMPTY_ASSISTANT: Partial<AssistantEndpoint> = {
  name: '', endpoint_id: '', model: '', system_prompt: '',
  temperature: 0.3, max_tokens: 4096,
  use_rag: false, use_sql: false, reasoning: true, require_auth: true, is_enabled: true,
};

/** Create/edit form for a single named endpoint. */
function AssistantEditor({ initial, onDone, onCancel }: { initial: Partial<AssistantEndpoint>; onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const endpoints = useEndpoints();
  const [draft, setDraft] = useState<Partial<AssistantEndpoint>>(initial);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k: keyof AssistantEndpoint, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const models = endpoints.find((e) => e.id === draft.endpoint_id)?.models ?? [];

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      if (initial.id) await updateAssistant(initial.id, draft);
      else await createAssistant(draft);
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <Row label={t('settings.assistants.enabled')}>
        <Switch checked={draft.is_enabled !== false} onCheckedChange={(v) => set('is_enabled', v)} />
      </Row>
      <Row label={t('settings.assistants.name')}>
        <Input className="w-56" value={String(draft.name ?? '')} onChange={(e) => set('name', e.target.value)} placeholder={t('settings.assistants.namePlaceholder')} />
      </Row>
      <Row label={t('settings.assistants.endpoint')}>
        <Select className="w-56" value={String(draft.endpoint_id ?? '')} onChange={(v) => { set('endpoint_id', v); set('model', ''); }}
          options={[{ value: '', label: '—' }, ...endpoints.map((e) => ({ value: e.id, label: e.name }))]} />
      </Row>
      <Row label={t('settings.assistants.model')} hint={t('settings.assistants.modelHint')}>
        <Select className="w-56" value={String(draft.model ?? '')} onChange={(v) => set('model', v)}
          options={[{ value: '', label: t('settings.assistants.autoModel') }, ...models.map((m) => ({ value: m }))]} />
      </Row>
      <Row label={t('settings.assistants.systemPrompt')}>
        <Textarea className="w-full" rows={3} value={String(draft.system_prompt ?? '')} onChange={(e) => set('system_prompt', e.target.value)} placeholder={t('settings.assistants.systemPromptPlaceholder')} />
      </Row>
      <Row label={t('settings.assistants.temperature')}>
        <Input type="number" step="0.1" min="0" max="2" className="w-24" value={String(draft.temperature ?? 0.3)} onChange={(e) => set('temperature', Number(e.target.value))} />
      </Row>
      <Row label={t('settings.assistants.maxTokens')}>
        <Input type="number" min="1" className="w-28" value={String(draft.max_tokens ?? 4096)} onChange={(e) => set('max_tokens', Number(e.target.value))} />
      </Row>
      <Row label={t('settings.assistants.useRag')} hint={t('settings.assistants.useRagHint')}>
        <Switch checked={!!draft.use_rag} onCheckedChange={(v) => set('use_rag', v)} />
      </Row>
      <Row label={t('settings.assistants.useSql')} hint={t('settings.assistants.useSqlHint')}>
        <Switch checked={!!draft.use_sql} onCheckedChange={(v) => set('use_sql', v)} />
      </Row>
      <Row label={t('settings.assistants.reasoning')} hint={t('settings.assistants.reasoningHint')}>
        <Switch checked={!!draft.reasoning} onCheckedChange={(v) => set('reasoning', v)} />
      </Row>
      <Row label={t('settings.assistants.requireAuth')} hint={t('settings.assistants.requireAuthHint')}>
        <Switch checked={draft.require_auth !== false} onCheckedChange={(v) => set('require_auth', v)} />
      </Row>
      {draft.require_auth === false && (
        <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive-foreground">
          {t('settings.assistants.openWarning')}
        </p>
      )}
      {err && <p className="px-1 text-xs text-destructive-foreground">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button size="sm" disabled={saving || !draft.name?.trim() || !draft.endpoint_id} onClick={() => void save()}>
          {saving ? t('common.saving') : t('settings.saveChanges')}
        </Button>
      </div>
    </div>
  );
}

function AssistantsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: assistants } = useQuery({ queryKey: ['assistants'], queryFn: fetchAssistants });
  const [editing, setEditing] = useState<Partial<AssistantEndpoint> | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['assistants'] });
  const done = () => { setEditing(null); refresh(); };
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://<lan-ip>:7000';

  return (
    <Page>
      <Section
        title={t('settings.assistants.title')}
        action={!editing && <Button size="sm" onClick={() => setEditing({ ...EMPTY_ASSISTANT })}><PlusIcon /> {t('settings.assistants.new')}</Button>}
        padded
      >
        <p className="mb-3 text-xs text-muted-foreground">{t('settings.assistants.intro')}</p>
        {editing && <AssistantEditor initial={editing} onDone={done} onCancel={() => setEditing(null)} />}
        {!editing && (
          <div className="space-y-1.5">
            {(assistants ?? []).map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 truncate text-sm">
                    {a.name}
                    <code className="rounded bg-muted px-1 text-[11px] text-muted-foreground">{a.slug}</code>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {a.endpoint_name ?? a.endpoint_id} · {a.model || t('settings.assistants.autoModel')}
                    {a.use_rag && ' · RAG'}{a.use_sql && ' · SQL'}{a.reasoning && ' · ' + t('settings.assistants.reasoning')}{!a.require_auth && ' · ' + t('settings.assistants.openBadge')}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Switch
                    checked={!!a.is_enabled}
                    onCheckedChange={(v) => void updateAssistant(a.id, { is_enabled: v }).then(refresh)}
                    aria-label={a.is_enabled ? t('settings.models.enabled') : t('settings.models.disabled')}
                  />
                  <Button size="icon-sm" variant="ghost" onClick={() => setEditing(a)} aria-label={t('common.edit')}><WrenchIcon /></Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => { if (window.confirm(t('settings.assistants.deleteConfirm', { name: a.name }))) void deleteAssistant(a.id).then(refresh); }} aria-label={t('common.delete')}><Trash2Icon /></Button>
                </div>
              </div>
            ))}
            {(assistants ?? []).length === 0 && <p className="text-xs text-muted-foreground">{t('settings.assistants.empty')}</p>}
          </div>
        )}
      </Section>

      <Section title={t('settings.assistants.usageTitle')} padded>
        <p className="mb-2 text-xs text-muted-foreground">{t('settings.assistants.usageIntro')}</p>
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-[11px] leading-relaxed">{`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ody_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model": "<slug>", "messages": [{"role":"user","content":"hi"}]}'`}</pre>
        <p className="mt-2 text-xs text-muted-foreground">{t('settings.assistants.usageModels', { origin })}</p>
      </Section>
    </Page>
  );
}

/* ── Shared skills (Claude-style SKILL.md library) ── */

function SharedSkillsPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const auth = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');
  const { data } = useQuery({ queryKey: ['sharedSkills'], queryFn: fetchSharedSkills });
  const skills = data?.skills ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['sharedSkills'] });

  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setSharedSkillEnabled(name, enabled),
    onSettled: invalidate,
  });

  const onUpload = async (file: File) => {
    setMsg('');
    try {
      if (file.name.toLowerCase().endsWith('.zip')) {
        await uploadSharedSkillBundle(file);
      } else {
        await uploadSharedSkill(await file.text());
      }
      setMsg(t('settings.skills.uploaded'));
      invalidate();
    } catch (e) { setMsg((e as Error).message); }
  };

  const onDelete = async (s: SharedSkill) => {
    setMsg('');
    try {
      await deleteSharedSkill(s.name);
      invalidate();
    } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <Page>
      <Section
        title={t('settings.skills.title')}
        action={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.zip,text/markdown,application/zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
                e.target.value = '';
              }}
            />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <PlusIcon /> {t('settings.skills.upload')}
            </Button>
          </>
        }
      >
        <div className="px-4 pt-3 text-xs text-muted-foreground sm:px-5">{t('settings.skills.intro')}</div>
        {msg && <div className="px-4 pt-2 text-xs text-muted-foreground sm:px-5">{msg}</div>}
        {skills.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground sm:px-5">
            {t('settings.skills.empty')}
          </div>
        )}
        {skills.map((s) => (
          <Row
            key={s.name}
            label={<span className="font-mono text-[13px]">{s.name}</span>}
            hint={
              <>
                {s.description}
                {s.uploaded_by && (
                  <span className="opacity-70"> · {t('settings.skills.by', { user: s.uploaded_by })}</span>
                )}
                {s.files > 0 && (
                  <span className="opacity-70"> · {t('settings.skills.files', { count: s.files })}</span>
                )}
              </>
            }
          >
            {(s.mine || auth?.is_admin) && (
              <Button
                size="icon-sm"
                variant="ghost"
                title={t('settings.skills.delete')}
                onClick={() => void onDelete(s)}
              >
                <Trash2Icon />
              </Button>
            )}
            <Switch
              checked={s.enabled}
              onCheckedChange={(v: boolean) => toggle.mutate({ name: s.name, enabled: v })}
            />
          </Row>
        ))}
      </Section>
    </Page>
  );
}

/* ── Dialog shell ── */

/** Scope controls which settings groups are shown. 'user' hides every admin
 *  panel (the "Settings" menu entry); 'admin' shows only admin panels (the
 *  "Admin panel" entry); undefined shows both. */
export type SettingsScope = 'user' | 'admin';

export function SettingsDialog({
  open,
  onClose,
  initialPanel,
  scope,
  onOpenRag,
}: {
  open: boolean;
  onClose: () => void;
  initialPanel?: Panel;
  scope?: SettingsScope;
  /** Route the user to the dedicated `/rag` workspace instead of rendering the
   *  RAG panel inline (Advanced settings → `/rag`). */
  onOpenRag?: () => void;
}) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<Panel>(initialPanel ?? 'appearance');
  const auth = useAuth();

  // Each time the dialog opens, jump to the requested panel (or the first one
  // available in the active scope) so menu entries land where they should.
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) {
      setPanel(initialPanel ?? (scope === 'admin' ? 'models' : 'appearance'));
      setQuery('');
    }
  }, [open, initialPanel, scope]);

  const userNav: Array<{ id: Panel; label: string; icon: React.ReactNode }> = [
    { id: 'appearance', label: t('settings.nav.appearance'), icon: <PaletteIcon /> },
    { id: 'shortcuts', label: t('settings.nav.shortcuts'), icon: <KeyboardIcon /> },
    { id: 'account', label: t('settings.nav.account'), icon: <UserIcon /> },
    { id: 'skills', label: t('settings.nav.skills'), icon: <FileTextIcon /> },
  ];
  const adminNav: Array<{ id: Panel; label: string; icon: React.ReactNode }> = [
    { id: 'models', label: t('settings.nav.models'), icon: <ServerIcon /> },
    { id: 'ai', label: t('settings.nav.ai'), icon: <BotIcon /> },
    { id: 'assistants', label: t('settings.nav.assistants'), icon: <PlugIcon /> },
    { id: 'integrations', label: t('settings.nav.integrations'), icon: <Link2Icon /> },
    { id: 'tools', label: t('settings.nav.tools'), icon: <WrenchIcon /> },
    { id: 'users', label: t('settings.nav.users'), icon: <UsersIcon /> },
    { id: 'system', label: t('settings.nav.system'), icon: <SettingsIcon /> },
  ];
  // Advanced — entries that open a dedicated surface rather than an in-dialog
  // panel. RAG routes to the full-screen `/rag` workspace (no in-dialog panel).
  const advancedNav: Array<{ id: Panel; label: string; icon: React.ReactNode }> = [
    { id: 'rag', label: t('settings.nav.rag'), icon: <DatabaseIcon /> },
  ];

  // The RAG entry routes to the dedicated `/rag` workspace instead of swapping
  // an in-dialog panel; everything else selects a panel as before.
  const navClick = (id: Panel) => {
    if (id === 'rag' && onOpenRag) {
      onOpenRag();
      onClose();
    } else {
      setPanel(id);
    }
  };
  const NavButton = ({ n }: { n: { id: Panel; label: string; icon: React.ReactNode } }) => (
    <button
      type="button"
      onClick={() => navClick(n.id)}
      title={n.label}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        panel === n.id ? 'bg-accent font-medium' : 'hover:bg-accent/60',
      )}
    >
      {n.icon}
      <span className="min-w-0 truncate">{n.label}</span>
    </button>
  );
  const GroupLabel = ({ children }: { children: React.ReactNode }) => (
    <div className="px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase first:pt-1">
      {children}
    </div>
  );

  // Filter the nav by the search box; group headers hide when their group is empty.
  const q = query.trim().toLowerCase();
  const matches = (n: { label: string }) => !q || n.label.toLowerCase().includes(q);
  const userItems = scope === 'admin' ? [] : userNav.filter(matches);
  const adminItems = auth?.is_admin && scope !== 'user' ? adminNav.filter(matches) : [];
  const advancedItems = auth?.is_admin && scope !== 'user' ? advancedNav.filter(matches) : [];
  const noResults = userItems.length === 0 && adminItems.length === 0 && advancedItems.length === 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={t('settings.title')} className="w-[min(1080px,95vw)]">
        <div className="flex h-[min(760px,86vh)]">
          <div className="flex w-60 shrink-0 flex-col border-r">
            <div className="p-2.5">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('settings.searchPlaceholder')}
                  aria-label={t('settings.searchPlaceholder')}
                  className="h-9 w-full rounded-lg border border-input bg-transparent pr-2.5 pl-8 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/20"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
              {userItems.length > 0 && (
                <>
                  <GroupLabel>{t('settings.general')}</GroupLabel>
                  {userItems.map((n) => <NavButton key={n.id} n={n} />)}
                </>
              )}
              {adminItems.length > 0 && (
                <>
                  <GroupLabel>{t('settings.admin')}</GroupLabel>
                  {adminItems.map((n) => <NavButton key={n.id} n={n} />)}
                </>
              )}
              {advancedItems.length > 0 && (
                <>
                  <GroupLabel>{t('settings.advanced')}</GroupLabel>
                  {advancedItems.map((n) => <NavButton key={n.id} n={n} />)}
                </>
              )}
              {noResults && (
                <div className="px-2.5 py-8 text-center text-xs text-muted-foreground">{t('settings.noResults')}</div>
              )}
            </div>
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto">
            {panel === 'appearance' && <AppearancePanel />}
            {panel === 'shortcuts' && <ShortcutsPanel />}
            {panel === 'account' && <AccountPanel />}
            {panel === 'skills' && <SharedSkillsPanel />}
            {panel === 'models' && <AddModelsPanel />}
            {panel === 'ai' && <AiDefaultsPanel />}
            {panel === 'assistants' && <AssistantsPanel />}
            {panel === 'integrations' && <IntegrationsPanel />}
            {panel === 'tools' && <ToolsPanel />}
            {panel === 'users' && <UsersPanel currentUser={auth?.username} />}
            {panel === 'system' && <SystemPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
