import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenIcon, DownloadIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteSharedSkill,
  downloadSharedSkill,
  fetchSharedSkills,
  setSharedSkillEnabled,
  uploadSharedSkill,
  uploadSharedSkillBundle,
} from '@/api/client';
import type { SharedSkill } from '@/api/client';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { SearchInput } from '../ui/search';
import { Switch } from '../ui/misc';
import { useAuth } from '../auth/AuthGate';
import { McpServersPanel } from '../settings/McpServersPanel';
import { EmptyState, Page } from './parts';

type Tab = 'skills' | 'connectors';

function SkillRow({
  skill,
  onToggle,
  onDelete,
}: {
  skill: SharedSkill;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-sidebar-accent">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
        <BookOpenIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-strong">{skill.name}</span>
          {skill.bundled && (
            <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
              {t('settings.skills.bundled')}
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {skill.uploaded_by && (
            <span className="opacity-80">{t('settings.skills.by', { user: skill.uploaded_by })} · </span>
          )}
          {skill.description}
        </div>
      </div>
      {skill.updated_at && (
        <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
          {formatRelativeTime(skill.updated_at)}
        </span>
      )}
      <Switch checked={skill.enabled} onCheckedChange={onToggle} />
      <Button
        size="icon-sm"
        variant="ghost-muted"
        title={t('settings.skills.download')}
        onClick={() => downloadSharedSkill(skill.name)}
      >
        <DownloadIcon />
      </Button>
      <Button size="icon-sm" variant="ghost-muted" title={t('settings.skills.delete')} onClick={onDelete}>
        <Trash2Icon />
      </Button>
    </div>
  );
}

/** The /customize page: what the assistant knows how to do and what it can reach.
 *  Skills is the shared SKILL.md library the settings dialog manages, given room
 *  to breathe (search, descriptions, per-skill enable). Connectors are the MCP
 *  servers: admin-only, because /api/mcp is and a stdio connector runs a process
 *  on the host. */
export function CustomizeWorkspace() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const auth = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const tabs: Tab[] = auth?.is_admin ? ['skills', 'connectors'] : ['skills'];
  const [selectedTab, setTab] = useState<Tab>('skills');
  const tab: Tab = tabs.includes(selectedTab) ? selectedTab : 'skills';
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['sharedSkills'], queryFn: fetchSharedSkills });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['sharedSkills'] });

  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setSharedSkillEnabled(name, enabled),
    onSettled: invalidate,
  });

  const upload = async (file: File) => {
    setError('');
    try {
      if (file.name.toLowerCase().endsWith('.zip')) await uploadSharedSkillBundle(file);
      else await uploadSharedSkill(await file.text());
      invalidate();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (skill: SharedSkill) => {
    setError('');
    try {
      await deleteSharedSkill(skill.name);
      invalidate();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const needle = query.trim().toLowerCase();
  const skills = (data?.skills ?? []).filter(
    (s) =>
      !needle ||
      s.name.toLowerCase().includes(needle) ||
      (s.description ?? '').toLowerCase().includes(needle),
  );

  return (
    <Page
      title={t('sidebar.customize')}
      actions={
        // Hidden rather than removed on the other tab: the title row keeps its
        // height, also where the actions wrap, so switching tabs moves nothing.
        <div className={cn('flex items-center gap-2', tab !== 'skills' && 'invisible')}>
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('customize.searchPlaceholder')}
            wrapperClassName="w-56"
          />
          <input
            ref={fileRef}
            type="file"
            accept=".md,.zip,text/markdown,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
          <Button onClick={() => fileRef.current?.click()}>
            <PlusIcon /> {t('customize.addSkill')}
          </Button>
        </div>
      }
      belowTitle={
        <div className="flex items-center gap-1">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'rounded-lg px-3 py-1 text-[13px] transition-colors',
                tab === id
                  ? 'bg-sidebar-active text-strong'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
              )}
            >
              {t(`customize.tab.${id}`)}
            </button>
          ))}
        </div>
      }
    >
      {tab === 'connectors' ? (
        <McpServersPanel className="px-0 pb-0 sm:px-0" />
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">{t('settings.skills.intro')}</p>
          {error && <p className="mb-3 text-xs text-destructive-foreground">{error}</p>}
          {isLoading && <p className="py-16 text-center text-sm text-muted-foreground">{t('common.loading')}</p>}
          {!isLoading && skills.length === 0 && (
            <EmptyState
              icon={<BookOpenIcon />}
              title={t(needle ? 'customize.noMatches' : 'customize.emptyTitle')}
              hint={needle ? undefined : t('customize.emptyHint')}
              action={
                needle ? undefined : (
                  <Button onClick={() => fileRef.current?.click()}>
                    <PlusIcon /> {t('customize.addSkill')}
                  </Button>
                )
              }
            />
          )}
          {skills.length > 0 && (
            <div className="overflow-hidden rounded-xl border bg-card">
              {skills.map((s) => (
                <SkillRow
                  key={s.name}
                  skill={s}
                  onToggle={(enabled) => toggle.mutate({ name: s.name, enabled })}
                  onDelete={() => void remove(s)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
