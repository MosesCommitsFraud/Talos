import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteSharedSkill,
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
import { EmptyState, Page } from './parts';

/** Tabs the page will grow into. Only Skills is wired today; the others are
 *  listed so the page's shape doesn't change when they land. */
const TABS = ['skills'] as const;
type Tab = (typeof TABS)[number];

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
      <Button size="icon-sm" variant="ghost-muted" title={t('settings.skills.delete')} onClick={onDelete}>
        <Trash2Icon />
      </Button>
    </div>
  );
}

/** The /customize page: what the assistant knows how to do. Skills for now —
 *  the same shared SKILL.md library the settings dialog manages, given room to
 *  breathe (search, descriptions, per-skill enable). */
export function CustomizeWorkspace() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>('skills');
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
        <>
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
        </>
      }
      belowTitle={
        <div className="flex items-center gap-1">
          {TABS.map((id) => (
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
    </Page>
  );
}
