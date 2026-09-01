import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  CheckIcon,
  DatabaseIcon,
  GlobeIcon,
  MicIcon,
  PaperclipIcon,
  PencilRulerIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
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
        <span className="min-w-0 flex-1 truncate">{t('settings.nav.skills')}</span>
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
        <span className="min-w-0 flex-1 truncate">{t('composer.micSelect')}</span>
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
        <span className="min-w-0 flex-1 truncate">{caps.rag ? t('composer.rag') : t('composer.sql')}</span>
        <CheckIcon className={cn('size-3.5 shrink-0 text-primary', on ? 'opacity-100' : 'opacity-0')} />
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
        <span className="min-w-0 flex-1 truncate">{t('composer.mode.label')}</span>
        <span className="shrink-0 text-muted-foreground">{active.label}</span>
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
 *  chooser, and the per-turn switches (knowledge sources, plan mode, web). */
export function ComposerAddMenu({
  onAttach,
  uploading,
  showMic,
  showPlan,
  className,
}: {
  onAttach: () => void;
  uploading?: boolean;
  showMic?: boolean;
  showPlan?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const useWeb = usePrefs((s) => s.useWeb);
  const planMode = usePrefs((s) => s.planMode);
  const toggle = usePrefs((s) => s.toggle);

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('composer.add')}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg border border-transparent text-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none dark:text-foreground/60 [&_svg]:size-4',
            className,
          )}
        >
          <PlusIcon className={uploading ? 'animate-pulse' : undefined} />
        </button>
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-48">
        <MenuItem onSelect={onAttach}>
          <PaperclipIcon />
          <span className="min-w-0 flex-1 truncate">{t('composer.attachFiles')}</span>
        </MenuItem>
        {auth?.is_admin && <SkillsSubmenu />}
        {showMic && <MicSubmenu />}
        <MenuSeparator />
        <KnowledgeItems />
        {showPlan && (
          // Plan mode is a per-turn switch like the others, so it reads as a
          // checked row rather than the old Plan/Work face swap.
          <MenuItem
            onSelect={(e) => {
              e.preventDefault();
              toggle('planMode');
            }}
          >
            <PencilRulerIcon />
            <span className="min-w-0 flex-1 truncate">{t('composer.plan')}</span>
            <CheckIcon className={cn('size-3.5 shrink-0 text-primary', planMode ? 'opacity-100' : 'opacity-0')} />
          </MenuItem>
        )}
        {/* Per-turn, not a deployment setting: with it off the backend withholds
            web_search / web_fetch for the messages that follow. */}
        <MenuItem
          onSelect={(e) => {
            e.preventDefault();
            toggle('useWeb');
          }}
        >
          <GlobeIcon />
          <span className="min-w-0 flex-1 truncate">{t('composer.webSearch')}</span>
          <CheckIcon className={cn('size-3.5 shrink-0 text-primary', useWeb ? 'opacity-100' : 'opacity-0')} />
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
