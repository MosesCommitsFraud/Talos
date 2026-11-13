import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  CheckIcon,
  DatabaseIcon,
  GlobeIcon,
  MicIcon,
  PaperclipIcon,
  PlugIcon,
  SettingsIcon,
  SparklesIcon,
  SquareSlashIcon,
  TelescopeIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchCapabilities,
  fetchMcpServers,
  fetchSharedSkills,
  setMcpServerEnabled,
  setSharedSkillEnabled,
} from '@/api/client';
import { usePrefs, type ChatMode } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { useAuth } from './auth/AuthGate';
import { toast } from './ui/toast';
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuSwitch,
  MenuTrigger,
  roomyMenuClass,
} from './ui/menu';

/** A row's name, and at the right edge its current value when it has one (the
 *  knowledge mode). What a row does is in its tooltip, so the menu stays as
 *  wide as its longest name. */
function RowText({ title, value }: { title: string; value?: string }) {
  return (
    <>
      <span className={cn('truncate', value ? 'shrink-0' : 'min-w-0 flex-1')}>{title}</span>
      {value && <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">{value}</span>}
    </>
  );
}

function Tick({ on }: { on: boolean }) {
  return <CheckIcon aria-hidden className={cn('ms-auto size-3.5 shrink-0 text-primary', on ? 'opacity-100' : 'opacity-0')} />;
}

/** Settings-dialog request from a surface that doesn't own the dialog. App
 *  listens for it and opens the named panel. */
export const OPEN_SETTINGS_EVENT = 'talos-open-settings';

/** `scope` narrows the dialog's navigation to one group; 'all' leaves both in. */
export function requestSettingsPanel(panel: string, scope: 'user' | 'admin' | 'all' = 'admin') {
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { panel, scope: scope === 'all' ? undefined : scope } }),
  );
}

/** Skill library as a submenu. Everyone sees which skills there are; an admin
 *  also switches them here, the same deployment-wide switches as on the
 *  Customize page, without leaving the composer. The last row goes to that
 *  page, where a skill can be opened and read. */
function SkillsSubmenu({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const setView = useUi((s) => s.setView);
  const { data } = useQuery({ queryKey: ['sharedSkills'], queryFn: fetchSharedSkills, staleTime: 60_000 });
  const skills = (data?.skills ?? []).filter((s) => canManage || s.enabled);
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => setSharedSkillEnabled(name, enabled),
    onSuccess: (_result, { name, enabled }) => toast(enabled ? 'toasts.skillOn' : 'toasts.skillOff', { name }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sharedSkills'] }),
  });

  return (
    <MenuSub>
      <MenuSubTrigger title={t('composer.skillsDesc')}>
        <SparklesIcon />
        <RowText title={t('settings.nav.skills')} />
      </MenuSubTrigger>
      <MenuSubPopup className={cn(roomyMenuClass, 'max-h-80 w-56 overflow-y-auto')}>
        {skills.length === 0 && <MenuLabel>{t('composer.skills.none')}</MenuLabel>}
        {skills.map((s) => (
          <MenuItem
            key={s.name}
            title={s.description}
            // Toggling several skills in a row shouldn't cost a menu reopen.
            onSelect={(e) => {
              if (!canManage) return;
              e.preventDefault();
              toggle.mutate({ name: s.name, enabled: !s.enabled });
            }}
          >
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {canManage && <MenuSwitch on={s.enabled} />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => setView('customize')}>
          <SettingsIcon />
          <RowText title={t(canManage ? 'composer.skills.manage' : 'composer.skills.browse')} />
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Connectors (MCP servers) as a submenu: each with its switch, and the way to
 *  the page that adds and configures them. Admin-only, as /api/mcp is. */
function ConnectorsSubmenu() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: servers } = useQuery({ queryKey: ['mcp-servers'], queryFn: fetchMcpServers, staleTime: 30_000 });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; name: string; enabled: boolean }) => setMcpServerEnabled(id, enabled),
    onSuccess: (_result, { name, enabled }) => toast(enabled ? 'toasts.connectorOn' : 'toasts.connectorOff', { name }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['mcp-servers'] }),
  });

  return (
    <MenuSub>
      <MenuSubTrigger title={t('composer.connectorsDesc')}>
        <PlugIcon />
        <RowText title={t('customize.tab.connectors')} />
      </MenuSubTrigger>
      <MenuSubPopup className={cn(roomyMenuClass, 'max-h-80 w-56 overflow-y-auto')}>
        {(servers ?? []).length === 0 && <MenuLabel>{t('composer.connectors.none')}</MenuLabel>}
        {(servers ?? []).map((s) => (
          <MenuItem
            key={s.id}
            title={s.error || undefined}
            onSelect={(e) => {
              e.preventDefault();
              toggle.mutate({ id: s.id, name: s.name, enabled: !s.is_enabled });
            }}
          >
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {s.is_enabled && s.tool_count > 0 && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{s.enabled_tool_count}</span>
            )}
            <MenuSwitch on={s.is_enabled} />
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => requestSettingsPanel('mcpServers')}>
          <SettingsIcon />
          <RowText title={t('composer.connectors.manage')} />
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Microphone chooser, moved off the composer row and into the add menu now
 *  that the mic button itself lives inside the input box. Enumerates audio
 *  inputs when opened (labels appear once permission has been granted);
 *  "System default" clears the choice. Takes effect on the next recording. */
function MicSubmenu() {
  const { t } = useTranslation();
  const micDeviceId = usePrefs((s) => s.micDeviceId);
  const setMicDeviceId = usePrefs((s) => s.setMicDeviceId);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const loadDevices = () => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => setDevices(list.filter((d) => d.kind === 'audioinput' && d.deviceId)))
      .catch(() => setDevices([]));
  };
  return (
    <MenuSub onOpenChange={(open) => { if (open) loadDevices(); }}>
      <MenuSubTrigger title={t('composer.micDesc')}>
        <MicIcon />
        <RowText title={t('composer.micSelect')} />
      </MenuSubTrigger>
      <MenuSubPopup className={cn(roomyMenuClass, 'w-56')}>
        <MenuItem onSelect={() => setMicDeviceId(null)}>
          <span className="min-w-0 flex-1 truncate">{t('composer.micDefault')}</span>
          <Tick on={micDeviceId === null} />
        </MenuItem>
        {devices.map((d, i) => (
          <MenuItem key={d.deviceId} onSelect={() => setMicDeviceId(d.deviceId)}>
            <span className="min-w-0 flex-1 truncate">{d.label || t('composer.micUnnamed', { n: i + 1 })}</span>
            <Tick on={micDeviceId === d.deviceId} />
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Knowledge sources, as a submenu: the 4-way mode when both RAG and SQL are
 *  configured, a single on/off row when only one is, nothing when neither.
 *  Also clamps the persisted flags so a stale toggle can't enable a source the
 *  deployment doesn't have. */
function KnowledgeItems() {
  const { t } = useTranslation();
  const { data: caps } = useQuery({ queryKey: ['capabilities'], queryFn: fetchCapabilities, staleTime: 60_000 });
  const useRag = usePrefs((s) => s.useRag);
  const useDb = usePrefs((s) => s.useDb);
  const setKnowledge = usePrefs((s) => s.setKnowledge);

  useEffect(() => {
    if (!caps) return;
    const r = caps.rag && useRag;
    const d = caps.sql && useDb;
    if (r !== useRag || d !== useDb) setKnowledge(r, d);
  }, [caps, useRag, useDb, setKnowledge]);

  if (!caps || (!caps.rag && !caps.sql)) return null;

  // Only one source configured: a plain switch beats a one-choice submenu.
  if (!caps.rag || !caps.sql) {
    const on = caps.rag ? useRag : useDb;
    return (
      <MenuItem
        role="menuitemcheckbox"
        aria-checked={on}
        title={caps.rag ? t('composer.ragDesc') : t('composer.sqlTooltip')}
        onSelect={(e) => {
          e.preventDefault();
          setKnowledge(caps.rag ? !useRag : false, caps.sql ? !useDb : false);
        }}
      >
        {caps.rag ? <BookOpenIcon /> : <DatabaseIcon />}
        <RowText title={caps.rag ? t('composer.mention.knowledge') : t('composer.mention.database')} />
        <MenuSwitch on={on} />
      </MenuItem>
    );
  }

  const mode: ChatMode = useRag ? (useDb ? 'full' : 'knowledge') : useDb ? 'sql' : 'chat';
  const modes: Array<{ key: ChatMode; rag: boolean; db: boolean; label: string }> = [
    { key: 'chat', rag: false, db: false, label: t('composer.mode.chat') },
    { key: 'knowledge', rag: true, db: false, label: t('composer.mode.knowledge') },
    { key: 'sql', rag: false, db: true, label: t('composer.mode.sql') },
    { key: 'full', rag: true, db: true, label: t('composer.mode.full') },
  ];
  const active = modes.find((m) => m.key === mode) ?? modes[0];

  return (
    <MenuSub>
      <MenuSubTrigger>
        <BookOpenIcon />
        <RowText title={t('composer.mode.label')} value={active.label} />
      </MenuSubTrigger>
      <MenuSubPopup className={cn(roomyMenuClass, 'min-w-44')}>
        {modes.map((m) => (
          <MenuItem key={m.key} onSelect={() => setKnowledge(m.rag, m.db)}>
            <span className="min-w-0 flex-1 truncate">{m.label}</span>
            <Tick on={m.key === mode} />
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The composer's "+" menu, in two bands. Above the line, what can be put into
 *  or behind a message: files, a slash command, the skill library, connectors,
 *  the microphone. Below it, the switches for the turns that follow: knowledge
 *  sources, web search, deep research. */
export function ComposerAddMenu({
  onAttach,
  onSlash,
  uploading,
  showMic,
  className,
}: {
  onAttach: () => void;
  /** Start a slash command in the input (the composer opens its command list). */
  onSlash?: () => void;
  uploading?: boolean;
  showMic?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const isAdmin = !!auth?.is_admin || auth?.auth_enabled === false;
  const useWeb = usePrefs((s) => s.useWeb);
  const deepResearch = usePrefs((s) => s.deepResearch);
  const toggle = usePrefs((s) => s.toggle);

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('composer.add')}
          className={cn(
            'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-neutral-700 outline-none transition-colors hover:bg-accent focus:outline-none focus-visible:outline-none active:scale-95 data-[state=open]:bg-accent dark:text-white',
            className,
          )}
        >
          {/* Drawn rather than lucide's: full-length arms with rounded ends. */}
          <svg viewBox="0 0 14 14" aria-hidden="true" className={cn('size-[14px]', uploading && 'animate-pulse')}>
            <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </MenuTrigger>
      <MenuPopup align="start" className={cn(roomyMenuClass, 'w-60 max-w-[calc(100vw-1.5rem)]')}>
        <MenuItem title={t('composer.attachFilesDesc')} onSelect={onAttach}>
          <PaperclipIcon />
          <RowText title={t('composer.attachFiles')} />
        </MenuItem>
        {onSlash && (
          <MenuItem title={t('composer.slashDesc')} onSelect={onSlash}>
            <SquareSlashIcon />
            <RowText title={t('composer.slashCommands')} />
            <MenuShortcut className="tracking-normal">/</MenuShortcut>
          </MenuItem>
        )}
        <SkillsSubmenu canManage={isAdmin} />
        {isAdmin && <ConnectorsSubmenu />}
        {showMic && <MicSubmenu />}
        <MenuSeparator />
        <KnowledgeItems />
        {/* Per-turn, not a deployment setting: with it off the backend withholds
            web_search / web_fetch for the messages that follow. */}
        <MenuItem
          role="menuitemcheckbox"
          aria-checked={useWeb}
          title={t('composer.webSearchDesc')}
          onSelect={(e) => {
            e.preventDefault();
            toggle('useWeb');
          }}
        >
          <GlobeIcon />
          <RowText title={t('composer.webSearch')} />
          <MenuSwitch on={useWeb} />
        </MenuItem>
        {/* A mode, not a source: the next messages run as a research project
            (plan, parallel subagents, gap check, cited report). */}
        <MenuItem
          role="menuitemcheckbox"
          aria-checked={deepResearch}
          title={t('composer.deepResearchHint')}
          onSelect={(e) => {
            e.preventDefault();
            toggle('deepResearch');
          }}
        >
          <TelescopeIcon />
          <RowText title={t('composer.deepResearch')} />
          <MenuSwitch on={deepResearch} />
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Shown next to the "+" while deep research is on, so the mode is visible
 *  before sending (it makes a turn take minutes). Clicking it turns it off. */
export function DeepResearchChip({ className }: { className?: string }) {
  const { t } = useTranslation();
  const on = usePrefs((s) => s.deepResearch);
  const toggle = usePrefs((s) => s.toggle);
  if (!on) return null;
  return (
    <button
      type="button"
      title={t('composer.deepResearchOff')}
      aria-label={t('composer.deepResearchOff')}
      onClick={() => toggle('deepResearch')}
      className={cn(
        'group/dr flex h-[1.625rem] min-w-[1.625rem] shrink-0 items-center justify-center gap-1 rounded-full bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 [&_svg]:size-3.5',
        className,
      )}
    >
      <TelescopeIcon className="group-hover/dr:hidden" />
      <XIcon className="hidden group-hover/dr:block" />
      {/* A narrow composer (preview panel open) keeps only the icon, so the
          chip never runs into the controls on the right. */}
      <span className="hidden @md/composer:inline">{t('composer.deepResearch')}</span>
    </button>
  );
}
