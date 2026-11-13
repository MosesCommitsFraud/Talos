import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenIcon, DownloadIcon, FileIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteSharedSkill,
  downloadSharedSkill,
  fetchSharedSkill,
  fetchSharedSkills,
  setSharedSkillEnabled,
  uploadSharedSkill,
  uploadSharedSkillBundle,
} from '@/api/client';
import type { SharedSkill } from '@/api/client';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Markdown } from '../Markdown';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { SearchInput } from '../ui/search';
import { Segmented } from '../ui/segmented';
import { Switch } from '../ui/misc';
import { toast } from '../ui/toast';
import { useAuth } from '../auth/AuthGate';
import { McpServersPanel } from '../settings/McpServersPanel';
import { Badge } from '../users/parts';
import { EmptyState, Page } from './parts';

type Tab = 'skills' | 'connectors';

/** The instructions of a SKILL.md without its frontmatter: the name and the
 *  description it carries are already the dialog's heading. */
function skillBody(content: string): string {
  return content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One skill opened to read: what it is for, who added it, the instructions the
 *  model gets when it loads the skill, and the files bundled with it. */
function SkillDialog({
  skill,
  canManage,
  onClose,
  onToggle,
}: {
  skill: SharedSkill | null;
  canManage: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const name = skill?.name ?? '';
  const { data, isError } = useQuery({
    queryKey: ['sharedSkill', name],
    queryFn: () => fetchSharedSkill(name),
    enabled: !!skill,
    staleTime: 30_000,
  });
  const body = data ? skillBody(data.content) : '';
  const meta = skill
    ? [
        skill.uploaded_by ? t('settings.skills.by', { user: skill.uploaded_by }) : null,
        skill.updated_at ? formatRelativeTime(skill.updated_at) : null,
        fileSize(skill.size),
      ].filter(Boolean).join(' · ')
    : '';

  return (
    <Dialog open={!!skill} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        bare
        title={name}
        description={skill?.description}
        className="h-[min(720px,85vh)] w-[min(760px,94vw)]"
      >
        {skill && (
          <>
            <header className="flex items-start gap-3 border-b px-5 pt-4 pb-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <h2 className="min-w-0 truncate text-base font-semibold tracking-tight text-strong">{skill.name}</h2>
                  {skill.bundled && <Badge>{t('settings.skills.bundled')}</Badge>}
                  <Badge tone={skill.enabled ? 'primary' : 'muted'}>
                    {t(skill.enabled ? 'customize.skillOn' : 'customize.skillOff')}
                  </Badge>
                </div>
                {skill.description && (
                  <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{skill.description}</p>
                )}
                {meta && <p className="mt-1 text-[11px] text-muted-foreground/80">{meta}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canManage && <Switch checked={skill.enabled} onCheckedChange={onToggle} aria-label={skill.name} className="mr-1.5" />}
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  title={t('settings.skills.download')}
                  aria-label={t('settings.skills.download')}
                  onClick={() => downloadSharedSkill(skill.name)}
                >
                  <DownloadIcon />
                </Button>
                <DialogClose asChild>
                  <Button size="icon-sm" variant="ghost-muted" aria-label={t('common.close')}>
                    <XIcon />
                  </Button>
                </DialogClose>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {isError && <p className="text-[13px] text-destructive-foreground">{t('customize.skillLoadFailed')}</p>}
              {!data && !isError && <p className="text-[13px] text-muted-foreground">{t('common.loading')}</p>}
              {data && (body ? <Markdown text={body} /> : <p className="text-[13px] text-muted-foreground">{t('customize.skillEmpty')}</p>)}
              {data && data.file_paths.length > 0 && (
                <section className="mt-6 border-t border-border/60 pt-3">
                  <h3 className="text-[13px] font-semibold text-foreground">
                    {t('settings.skills.files', { count: data.file_paths.length })}
                  </h3>
                  <ul className="selectable mt-1.5 space-y-0.5 font-mono text-xs text-muted-foreground">
                    {data.file_paths.map((path) => (
                      <li key={path} className="flex items-center gap-1.5">
                        <FileIcon className="size-3 shrink-0 opacity-70" />
                        <span className="min-w-0 truncate">{path}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A skill in the list: name and what it is for on one line each, when it last
 *  changed, and at the right edge the switch and the actions. The whole row
 *  opens the skill to read; its controls do their own thing. */
function SkillRow({
  skill,
  canManage,
  onOpen,
  onToggle,
  onDelete,
}: {
  skill: SharedSkill;
  canManage: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group relative flex items-center gap-3 border-b border-border/60 py-2 pr-1 pl-2 last:border-b-0 hover:bg-accent/60">
      {/* The row itself is the button; it lies under the controls so they keep
          their own clicks and the row stays one tab stop. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('customize.openSkill', { name: skill.name })}
        className="absolute inset-0 rounded-md"
      />
      <div className="pointer-events-none relative min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-[13px] font-medium', skill.enabled ? 'text-strong' : 'text-muted-foreground')}>{skill.name}</span>
          {skill.bundled && <Badge>{t('settings.skills.bundled')}</Badge>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {skill.uploaded_by && <span className="opacity-80">{t('settings.skills.by', { user: skill.uploaded_by })} · </span>}
          {skill.description}
        </div>
      </div>
      {skill.updated_at && (
        <span className="pointer-events-none relative hidden shrink-0 text-[11px] text-muted-foreground tabular-nums sm:block">
          {formatRelativeTime(skill.updated_at)}
        </span>
      )}
      <div className="relative flex shrink-0 items-center gap-0.5">
        {canManage && <Switch checked={skill.enabled} onCheckedChange={onToggle} aria-label={skill.name} className="mr-1.5" />}
        <Button
          size="icon-sm"
          variant="ghost-muted"
          title={t('settings.skills.download')}
          aria-label={t('settings.skills.download')}
          onClick={() => downloadSharedSkill(skill.name)}
        >
          <DownloadIcon />
        </Button>
        {canManage && (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            title={t('settings.skills.delete')}
            aria-label={t('settings.skills.delete')}
            onClick={onDelete}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The /customize page: what the assistant knows how to do and what it can reach.
 *  Skills is the shared SKILL.md library, a flat list to search and read: every
 *  skill opens to its instructions, and admins switch it on, replace or remove
 *  it. Connectors are the MCP servers: admin-only, because /api/mcp is and a
 *  stdio connector runs a process on the host. */
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
  const [openName, setOpenName] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['sharedSkills'], queryFn: fetchSharedSkills });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['sharedSkills'] });
  // The library is everyone's to read and the admins' to change; the server
  // says which this is (and enforces it on every write).
  const canManage = data?.can_manage ?? (!!auth?.is_admin || auth?.auth_enabled === false);

  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setSharedSkillEnabled(name, enabled),
    onSuccess: (_result, { name, enabled }) => toast(enabled ? 'toasts.skillOn' : 'toasts.skillOff', { name }),
    onSettled: invalidate,
  });

  const upload = async (file: File) => {
    setError('');
    try {
      if (file.name.toLowerCase().endsWith('.zip')) await uploadSharedSkillBundle(file);
      else await uploadSharedSkill(await file.text());
      toast('settings.skills.uploaded');
      void invalidate();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (skill: SharedSkill) => {
    if (!window.confirm(t('customize.deleteConfirm', { name: skill.name }))) return;
    setError('');
    try {
      await deleteSharedSkill(skill.name);
      toast('toasts.skillDeleted', { name: skill.name });
      void invalidate();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const all = data?.skills ?? [];
  const needle = query.trim().toLowerCase();
  const skills = all.filter(
    (s) =>
      !needle ||
      s.name.toLowerCase().includes(needle) ||
      (s.description ?? '').toLowerCase().includes(needle),
  );
  const opened = openName ? (all.find((s) => s.name === openName) ?? null) : null;
  const addButton = canManage && (
    <Button onClick={() => fileRef.current?.click()}>
      <PlusIcon /> {t('customize.addSkill')}
    </Button>
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
            className="h-8"
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
          {addButton}
        </div>
      }
      belowTitle={
        tabs.length > 1 ? (
          <Segmented<Tab>
            label={t('sidebar.customize')}
            value={tab}
            onChange={setTab}
            options={tabs.map((id) => ({ value: id, label: t(`customize.tab.${id}`) }))}
          />
        ) : undefined
      }
    >
      {tab === 'connectors' ? (
        <McpServersPanel className="px-0 pb-0 sm:px-0" />
      ) : (
        <>
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <p className="max-w-[72ch] text-xs text-muted-foreground">{t('settings.skills.intro')}</p>
            {all.length > 0 && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {t('customize.skillCount', { on: all.filter((s) => s.enabled).length, total: all.length })}
              </span>
            )}
          </div>
          {error && <p className="mb-2 text-xs text-destructive-foreground">{error}</p>}
          {isLoading && <p className="py-10 text-sm text-muted-foreground">{t('common.loading')}</p>}
          {!isLoading && skills.length === 0 && (
            <EmptyState
              icon={<BookOpenIcon />}
              title={t(needle ? 'customize.noMatches' : 'customize.emptyTitle')}
              hint={needle ? undefined : t('customize.emptyHint')}
              action={needle ? undefined : addButton || undefined}
            />
          )}
          {skills.length > 0 && (
            <div className="border-y border-border/60">
              {skills.map((s) => (
                <SkillRow
                  key={s.name}
                  skill={s}
                  canManage={canManage}
                  onOpen={() => setOpenName(s.name)}
                  onToggle={(enabled) => toggle.mutate({ name: s.name, enabled })}
                  onDelete={() => void remove(s)}
                />
              ))}
            </div>
          )}
          <SkillDialog
            skill={opened}
            canManage={canManage}
            onClose={() => setOpenName(null)}
            onToggle={(enabled) => opened && toggle.mutate({ name: opened.name, enabled })}
          />
        </>
      )}
    </Page>
  );
}
