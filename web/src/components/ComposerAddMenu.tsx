import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  CheckIcon,
  DatabaseIcon,
  GlobeIcon,
  MicIcon,
  PaperclipIcon,
  SettingsIcon,
  SparklesIcon,
  TelescopeIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchCapabilities, fetchSharedSkills, setSharedSkillEnabled } from '@/api/client';
import { usePrefs, type ChatMode } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { useAuth } from './auth/AuthGate';
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from './ui/menu';

/** A row of the add menu: what it is, and a few muted words on what it does. */
function RowText({ title, desc }: { title: string; desc?: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="shrink-0 font-medium text-strong">{title}</span>
      {desc && <span className="min-w-0 truncate text-[13px] text-muted-foreground">{desc}</span>}
    </span>
  );
}

/** "Active", at the end of a switch row that is on. Always laid out, so a row
 *  does not change width when it is flipped. */
function ActiveMark({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={cn('shrink-0 ps-3 text-xs font-medium text-emerald-600 dark:text-emerald-400', !on && 'invisible')}>
      {t('composer.active')}
    </span>
  );
}

/** Settings-dialog request from a surface that doesn't own the dialog. App
 *  listens for it and opens the named panel. */
export const OPEN_SETTINGS_EVENT = 'talos-open-settings';

export function requestSettingsPanel(panel: string, scope: 'user' | 'admin' = 'admin') {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { panel, scope } }));
}

/** Skill library as a submenu: the same deployment-wide switches as
 *  Settings → Skills, reachable without leaving the composer. Admin-only,
 *  because the switches apply to everyone. */
function SkillsSubmenu() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['sharedSkills'], queryFn: fetchSharedSkills, staleTime: 60_000 });
  const skills = data?.skills ?? [];
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => setSharedSkillEnabled(name, enabled),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sharedSkills'] }),
  });

  return (
    <MenuSub>
      <MenuSubTrigger>
        <SparklesIcon />
        <RowText title={t('settings.nav.skills')} desc={t('composer.skillsDesc')} />
      </MenuSubTrigger>
      <MenuSubPopup className="max-h-80 min-w-52 overflow-y-auto">
        {skills.length === 0 && (
          <MenuLabel>{t('composer.skills.none')}</MenuLabel>
        )}
        {skills.map((s) => (
          <MenuItem
            key={s.name}
            // Toggling several skills in a row shouldn't cost a menu reopen.
            onSelect={(e) => {
              e.preventDefault();
              toggle.mutate({ name: s.name, enabled: !s.enabled });
            }}
          >
            <span className="min-w-0 max-w-56 flex-1 truncate">{s.name}</span>
            <CheckIcon className={cn('size-3.5 shrink-0 text-primary', s.enabled ? 'opacity-100' : 'opacity-0')} />
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => requestSettingsPanel('skills')}>
          <SettingsIcon />
          <span className="min-w-0 flex-1 truncate">{t('composer.skills.manage')}</span>
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
      <MenuSubTrigger>
        <MicIcon />
        <RowText title={t('composer.micSelect')} desc={t('composer.micDesc')} />
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuItem onSelect={() => setMicDeviceId(null)}>
          <span className="min-w-0 flex-1 truncate">{t('composer.micDefault')}</span>
          <CheckIcon className={cn('size-3.5 shrink-0 text-primary', micDeviceId === null ? 'opacity-100' : 'opacity-0')} />
        </MenuItem>
        {devices.map((d, i) => (
          <MenuItem key={d.deviceId} onSelect={() => setMicDeviceId(d.deviceId)}>
            <span className="min-w-0 max-w-56 flex-1 truncate">{d.label || t('composer.micUnnamed', { n: i + 1 })}</span>
            <CheckIcon className={cn('size-3.5 shrink-0 text-primary', micDeviceId === d.deviceId ? 'opacity-100' : 'opacity-0')} />
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
        onSelect={(e) => {
          e.preventDefault();
          setKnowledge(caps.rag ? !useRag : false, caps.sql ? !useDb : false);
        }}
      >
        {caps.rag ? <BookOpenIcon /> : <DatabaseIcon />}
        <RowText
          title={caps.rag ? t('composer.mention.knowledge') : t('composer.mention.database')}
          desc={caps.rag ? t('composer.ragDesc') : t('composer.sqlTooltip')}
        />
        <ActiveMark on={on} />
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
        <RowText title={t('composer.mode.label')} desc={active.label} />
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-40">
        {modes.map((m) => (
          <MenuItem key={m.key} onSelect={() => setKnowledge(m.rag, m.db)}>
            <span className="min-w-0 flex-1 truncate">{m.label}</span>
            <CheckIcon className={cn('size-3.5 shrink-0 text-primary', m.key === mode ? 'opacity-100' : 'opacity-0')} />
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The composer's "+" menu: attachments, the skill library, the microphone
 *  chooser, and the per-turn switches (knowledge sources, web). */
export function ComposerAddMenu({
  onAttach,
  uploading,
  showMic,
  className,
}: {
  onAttach: () => void;
  uploading?: boolean;
  showMic?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
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
            'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-neutral-700 outline-none transition-colors hover:bg-accent focus:outline-none focus-visible:outline-none active:scale-95 dark:text-white',
            className,
          )}
        >
          {/* Drawn rather than lucide's: full-length arms with rounded ends. */}
          <svg viewBox="0 0 14 14" aria-hidden="true" className={cn('size-[14px]', uploading && 'animate-pulse')}>
            <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </MenuTrigger>
      {/* Roomier than a plain menu: every row says what it is and what it does. */}
      <MenuPopup align="start" className="w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-xl p-1.5 [&>[role^=menuitem]]:min-h-9 [&>[role^=menuitem]]:gap-2.5 [&>[role^=menuitem]]:rounded-lg">
        <MenuItem onSelect={onAttach}>
          <PaperclipIcon />
          <RowText title={t('composer.attachFiles')} desc={t('composer.attachFilesDesc')} />
        </MenuItem>
        {auth?.is_admin && <SkillsSubmenu />}
        {showMic && <MicSubmenu />}
        <MenuSeparator />
        <KnowledgeItems />
        {/* Per-turn, not a deployment setting: with it off the backend withholds
            web_search / web_fetch for the messages that follow. */}
        <MenuItem
          onSelect={(e) => {
            e.preventDefault();
            toggle('useWeb');
          }}
        >
          <GlobeIcon />
          <RowText title={t('composer.webSearch')} desc={t('composer.webSearchDesc')} />
          <ActiveMark on={useWeb} />
        </MenuItem>
        {/* A mode, not a source: the next messages run as a research project
            (plan, parallel subagents, gap check, cited report). */}
        <MenuItem
          title={t('composer.deepResearchHint')}
          onSelect={() => toggle('deepResearch')}
        >
          <TelescopeIcon />
          <RowText title={t('composer.deepResearch')} desc={t('composer.deepResearchDesc')} />
          <ActiveMark on={deepResearch} />
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
        'group/dr flex h-[1.625rem] min-w-[1.625rem] shrink-0 items-center justify-center gap-1 rounded-lg bg-primary/10 px-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 [&_svg]:size-3.5',
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
