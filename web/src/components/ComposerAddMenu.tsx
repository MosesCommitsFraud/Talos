import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckIcon,
  GlobeIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchSharedSkills, setSharedSkillEnabled } from '@/api/client';
import { usePrefs } from '@/state/prefs';
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

/** The composer's "+" menu: attachments, the skill library, the microphone
 *  chooser, and the per-turn web-search switch. */
export function ComposerAddMenu({
  onAttach,
  uploading,
  showMic,
}: {
  onAttach: () => void;
  uploading?: boolean;
  showMic?: boolean;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const useWeb = usePrefs((s) => s.useWeb);
  const toggle = usePrefs((s) => s.toggle);

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('composer.add')}
          className="flex size-6 shrink-0 items-center justify-center rounded-[4.5px] border border-transparent pt-[2px] text-foreground/80 outline-none transition-colors hover:bg-accent hover:text-foreground/90 focus:outline-none focus-visible:outline-none dark:text-foreground/65 sm:size-5 [&_svg]:size-3.5 [&_svg]:-translate-y-px"
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
