import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, ChevronRightIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GIT_DEFAULT_DB_TARGET,
  GIT_NONE_TARGET,
  GIT_SKILLS_TARGET,
  fetchGitFolders,
  fetchGitSync,
  startGitSync,
  type GitRepoConfig,
  type GitSyncRepo,
  type RagBase,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Row, Section } from '../SettingsDialog';
import { Input, Switch } from '../ui/misc';
import { Select } from '../ui/select';

const newRepo = (isDefault: boolean): GitRepoConfig => ({
  url: '',
  branch: '',
  token: '',
  default: isDefault,
  exclude: ['readme.*'],
  skills_interval_minutes: 60,
  mappings: [
    { folder: 'knowledge', base: 'default' },
    { folder: 'sql', base: GIT_DEFAULT_DB_TARGET },
  ],
});

/** The repository's last run, and the button that starts the next one. */
function RepoStatus({ repo, live, dirty }: { repo: GitRepoConfig; live?: GitSyncRepo; dirty: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => startGitSync(repo.id ?? ''),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['git-sync'] });
      // The skill library is synced in the app, with no job to watch: look again shortly.
      [3000, 10000].forEach((ms) =>
        setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['git-sync'] }), ms));
    },
  });
  const last = live?.last;
  const running = !!live?.job;
  const saved = !!repo.id && !dirty;

  let hint: string = t('settings.mcp.git.neverRun');
  if (!saved) hint = t('settings.mcp.git.saveFirst');
  else if (sync.isError) hint = (sync.error as Error).message;
  else if (running) hint = t('settings.mcp.git.running');
  else if (last) hint = `${new Date(last.finished_at * 1000).toLocaleString()}: ${last.message}`;

  const failed = saved && !running && (sync.isError || last?.ok === false);
  const skills = saved ? live?.skills : null;
  // In the label rather than the row's hint: the settings dialog hides hints, and this
  // is the only place that says what the last run did.
  return (
    <Row
      stacked
      label={(
        <>
          <div>{t('settings.mcp.git.lastRun')}</div>
          <div className={cn('text-[13px] leading-snug text-muted-foreground', failed && 'text-destructive')}>{hint}</div>
          {skills && (
            <div className={cn('text-[13px] leading-snug text-muted-foreground', !skills.ok && 'text-destructive')}>
              {t('settings.mcp.git.skillsRun', {
                date: new Date(skills.finished_at * 1000).toLocaleString(),
                message: skills.message,
              })}
            </div>
          )}
          {repo.id && (
            <div className="text-[13px] leading-snug text-muted-foreground">
              {t('settings.mcp.git.repoId')} <code className="font-mono">{repo.id}</code>
            </div>
          )}
        </>
      )}
    >
      <Button size="sm" variant="outline" disabled={!saved || running || sync.isPending} onClick={() => sync.mutate()}>
        <RefreshCwIcon className={running ? 'size-3.5 animate-spin' : 'size-3.5'} />
        {t('settings.mcp.git.syncNow')}
      </Button>
    </Row>
  );
}

const sameFolder = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const parentOf = (folder: string) => folder.slice(0, Math.max(0, folder.lastIndexOf('/')));
/** More subfolders than this are folded away until asked for. */
const SUBFOLDERS_SHOWN = 6;
const probeKey = (r: GitRepoConfig) => `${r.url.trim()}\n${r.branch.trim()}\n${r.token}`;

interface FolderProbe {
  state: 'idle' | 'loading' | 'done' | 'failed';
  folders: string[];
  error: string;
  /** Read the folders again, unless these exact values were just read. */
  run: (repo: GitRepoConfig, force?: boolean) => void;
}

/**
 * The folders of each repository, read from the repository itself so nobody has to
 * type them. Read when the page opens and whenever URL, branch or token were edited.
 */
function useFolderProbes(repos: GitRepoConfig[]): FolderProbe[] {
  const [results, setResults] = useState<Record<string, Omit<FolderProbe, 'run'>>>({});
  const asked = useRef(new Set<string>());

  const run = (repo: GitRepoConfig, force = false) => {
    const key = probeKey(repo);
    if (!/^https?:\/\/\S+$/.test(repo.url.trim()) || (!force && asked.current.has(key))) return;
    asked.current.add(key);
    setResults((r) => ({ ...r, [key]: { state: 'loading', folders: r[key]?.folders ?? [], error: '' } }));
    fetchGitFolders(repo).then(
      ({ folders }) => setResults((r) => ({ ...r, [key]: { state: 'done', folders, error: '' } })),
      (e: Error) => setResults((r) => ({ ...r, [key]: { state: 'failed', folders: [], error: e.message } })),
    );
  };

  // Once the saved repositories are there; edits are picked up when a field loses focus.
  const loaded = repos.length > 0;
  useEffect(() => {
    repos.forEach((repo) => run(repo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  return repos.map((repo) => ({
    ...(results[probeKey(repo)] ?? { state: 'idle' as const, folders: [], error: '' }),
    run,
  }));
}

/** Which folder goes where: the repository's folders, each with a target to pick. */
function FolderMappings({
  repo,
  targets,
  probe,
  onChange,
}: {
  repo: GitRepoConfig;
  targets: { value: string; label: string }[];
  probe: FolderProbe;
  onChange: (mappings: GitRepoConfig['mappings']) => void;
}) {
  const { t } = useTranslation();
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const known = probe.state === 'done';
  const inRepo = (folder: string) => probe.folders.find((f) => sameFolder(f, folder));
  const isMapped = (folder: string) => repo.mappings.some((m) => sameFolder(m.folder, folder));
  const wholeRepo = isMapped('');
  // Folders nothing points at yet. At the top they are not synced until given a target;
  // inside a synced folder they go where that one goes until told otherwise.
  const unmapped = known && !wholeRepo
    ? probe.folders.filter((f) => !f.includes('/') && !isMapped(f))
    : [];
  const subfolders = (m: number) => {
    const { folder, base } = repo.mappings[m];
    const first = repo.mappings.findIndex((x) => sameFolder(x.folder, folder)) === m;
    if (!known || !first || base === GIT_NONE_TARGET || base === GIT_SKILLS_TARGET) return [];
    return probe.folders.filter((f) => sameFolder(parentOf(f), folder) && !isMapped(f));
  };
  const withNone = [...targets, { value: GIT_NONE_TARGET, label: t('settings.mcp.git.notSynced') }];

  const folderOptions = (current: string) => [
    { value: '', label: t('settings.mcp.git.wholeRepo') },
    ...probe.folders.map((f) => ({ value: f, label: f })),
    ...(current && !inRepo(current)
      ? [{ value: current, label: t('settings.mcp.git.missingFolder', { folder: current }) }]
      : []),
  ];

  let status = t('settings.mcp.git.detectNeedsUrl');
  if (probe.state === 'loading') status = t('settings.mcp.git.detecting');
  else if (probe.state === 'failed') status = t('settings.mcp.git.detectFailed', { error: probe.error });
  else if (known) status = t('settings.mcp.git.detected', { count: probe.folders.length });

  return (
    <Row
      stacked
      label={(
        <>
          <div>{t('settings.mcp.git.folders')}</div>
          <div className={cn('text-[13px] leading-snug text-muted-foreground', probe.state === 'failed' && 'text-destructive')}>
            {status}
          </div>
        </>
      )}
    >
      <div className="flex w-full flex-col items-end gap-2">
        {repo.mappings.map((mapping, m) => {
          const setMapping = (change: Partial<typeof mapping>) =>
            onChange(repo.mappings.map((x, j) => (j === m ? { ...x, ...change } : x)));
          const below = subfolders(m);
          const folded = below.length > SUBFOLDERS_SHOWN && !unfolded[mapping.folder.toLowerCase()];
          return (
            <Fragment key={m}>
            <div className="flex items-center gap-2">
              {known ? (
                <Select
                  className="w-44"
                  value={inRepo(mapping.folder) ?? mapping.folder}
                  onChange={(folder) => setMapping({ folder })}
                  options={folderOptions(mapping.folder)}
                />
              ) : (
                <Input
                  aria-label={t('settings.mcp.git.folder')}
                  className="w-44 font-mono text-[13px]"
                  placeholder={t('settings.mcp.git.wholeRepo')}
                  value={mapping.folder}
                  onChange={(e) => setMapping({ folder: e.target.value })}
                />
              )}
              <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Select className="w-72" value={mapping.base} onChange={(base) => setMapping({ base })} options={withNone} />
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('settings.mcp.git.removeFolder')}
                onClick={() => onChange(repo.mappings.filter((_, j) => j !== m))}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
            {folded && (
              <Button
                size="sm"
                variant="ghost"
                className="mr-9 text-muted-foreground"
                onClick={() => setUnfolded((u) => ({ ...u, [mapping.folder.toLowerCase()]: true }))}
              >
                <ChevronRightIcon className="size-3.5" />
                {t('settings.mcp.git.showSubfolders', { count: below.length })}
              </Button>
            )}
            {!folded && below.map((folder) => (
              <div key={folder} className="flex items-center gap-2">
                <div className="w-44 truncate pl-7 pr-3 text-sm text-muted-foreground" title={folder}>
                  {folder.slice(folder.lastIndexOf('/') + 1)}
                </div>
                <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <Select
                  className="w-72"
                  value=""
                  onChange={(base) => {
                    // Right below its parent, where it was picked.
                    if (base) onChange([...repo.mappings.slice(0, m + 1), { folder, base }, ...repo.mappings.slice(m + 1)]);
                  }}
                  options={[
                    {
                      value: '',
                      label: t('settings.mcp.git.sameAsParent', {
                        folder: mapping.folder ? inRepo(mapping.folder) ?? mapping.folder : t('settings.mcp.git.wholeRepo'),
                      }),
                    },
                    // Leaving it out is what one comes here for, so right at the top.
                    { value: GIT_NONE_TARGET, label: t('settings.mcp.git.notSynced') },
                    ...targets,
                  ]}
                />
                <div className="w-9 shrink-0" />
              </div>
            ))}
            </Fragment>
          );
        })}
        {unmapped.map((folder) => (
          <div key={folder} className="flex items-center gap-2">
            <div className="w-44 truncate px-3 text-sm text-muted-foreground">{folder}</div>
            <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <Select
              className="w-72"
              value=""
              onChange={(base) => { if (base) onChange([...repo.mappings, { folder, base }]); }}
              options={[{ value: '', label: t('settings.mcp.git.notSynced') }, ...targets]}
            />
            {/* Keeps the selects of both kinds of row in one column. */}
            <div className="w-9 shrink-0" />
          </div>
        ))}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={probe.state === 'loading'} onClick={() => probe.run(repo, true)}>
            <RefreshCwIcon className={probe.state === 'loading' ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {t('settings.mcp.git.detect')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange([...repo.mappings, { folder: '', base: 'default' }])}>
            <PlusIcon className="size-3.5" />
            {t('settings.mcp.git.addFolder')}
          </Button>
        </div>
      </div>
    </Row>
  );
}

/**
 * The repositories `update_rag` syncs from (src/rag_git_sync.py), edited as one
 * `rag_git_repos` setting. A repository gets its id from the server when it is saved,
 * so syncing is offered from then on.
 */
export function GitSyncSection({
  repos,
  bases,
  dirty,
  onChange,
  children,
}: {
  repos: GitRepoConfig[];
  bases: RagBase[];
  dirty: boolean;
  onChange: (repos: GitRepoConfig[]) => void;
  /** Further rows for the section's head, from the page that owns the draft. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['git-sync'],
    queryFn: fetchGitSync,
    refetchInterval: (query) => (query.state.data?.repos.some((r) => r.job) ? 3000 : false),
  });

  const patch = (index: number, change: Partial<GitRepoConfig>) =>
    onChange(repos.map((r, i) => (i === index ? { ...r, ...change } : r)));
  const makeDefault = (index: number) =>
    onChange(repos.map((r, i) => ({ ...r, default: i === index })));
  const remove = (index: number) => {
    const rest = repos.filter((_, i) => i !== index);
    onChange(rest.some((r) => r.default) ? rest : rest.map((r, i) => ({ ...r, default: i === 0 })));
  };

  const probes = useFolderProbes(repos);

  // A mini RAG whose database was removed takes no new documents.
  const targets = [
    { value: GIT_DEFAULT_DB_TARGET, label: t('settings.mcp.git.defaultDb') },
    { value: GIT_SKILLS_TARGET, label: t('settings.mcp.git.skillLibrary') },
    ...bases
      .filter((b) => b.kind !== 'mini' || b.connection)
      .map((b) => ({
        value: b.id,
        label: b.kind === 'mini'
          ? t('settings.mcp.git.miniRag', { name: b.name || b.id })
          : b.name || b.id,
      })),
  ];

  return (
    <>
      <Section
        title={t('settings.mcp.git.title')}
        action={(
          <Button size="sm" variant="ghost" onClick={() => onChange([...repos, newRepo(repos.length === 0)])}>
            <PlusIcon className="size-3.5" />
            {t('settings.mcp.git.add')}
          </Button>
        )}
      >
        <p className="pb-2 text-[13px] leading-snug text-muted-foreground">{t('settings.mcp.git.hint')}</p>
        {children}
        {repos.length === 0 && <Row label={t('settings.mcp.git.empty')} />}
      </Section>

      {repos.map((repo, index) => (
        <Section
          key={repo.id ?? `new-${index}`}
          title={repo.url.replace(/\/+$/, '').split('/').pop() || t('settings.mcp.git.newRepo')}
          action={(
            <Button size="sm" variant="ghost" aria-label={t('settings.mcp.git.remove')} title={t('settings.mcp.git.removeHint')} onClick={() => remove(index)}>
              <Trash2Icon className="size-3.5" />
            </Button>
          )}
        >
          <Row label={t('settings.mcp.git.url')} hint={t('settings.mcp.git.urlHint')}>
            <Input
              className="w-96 max-w-full font-mono text-[13px]"
              placeholder="https://devops.example.com/Team/_git/repo"
              value={repo.url}
              onChange={(e) => patch(index, { url: e.target.value })}
              onBlur={() => probes[index]?.run(repo)}
            />
          </Row>
          <Row label={t('settings.mcp.git.branch')} hint={t('settings.mcp.git.branchHint')}>
            <Input
              className="w-56 font-mono text-[13px]"
              value={repo.branch}
              onChange={(e) => patch(index, { branch: e.target.value })}
              onBlur={() => probes[index]?.run(repo)}
            />
          </Row>
          <Row label={t('settings.mcp.git.token')} hint={t('settings.mcp.git.tokenHint')}>
            <Input
              type="password"
              autoComplete="new-password"
              className="w-56"
              value={repo.token}
              onChange={(e) => patch(index, { token: e.target.value })}
              onBlur={() => probes[index]?.run(repo)}
            />
          </Row>
          <Row label={t('settings.mcp.git.default')} hint={t('settings.mcp.git.defaultHint')}>
            <Switch checked={repo.default} onCheckedChange={(on) => { if (on) makeDefault(index); }} />
          </Row>
          <FolderMappings
            repo={repo}
            targets={targets}
            probe={probes[index]}
            onChange={(mappings) => patch(index, { mappings })}
          />
          {repo.mappings.some((m) => m.base === GIT_SKILLS_TARGET) && (
            <Row label={t('settings.mcp.git.skillsInterval')} hint={t('settings.mcp.git.skillsIntervalHint')}>
              <Input
                type="number"
                min={0}
                className="w-24"
                aria-label={t('settings.mcp.git.skillsInterval')}
                value={String(repo.skills_interval_minutes ?? 60)}
                onChange={(e) => patch(index, { skills_interval_minutes: Math.max(0, Number(e.target.value) || 0) })}
              />
            </Row>
          )}
          <Row label={t('settings.mcp.git.exclude')} hint={t('settings.mcp.git.excludeHint')}>
            {/* Not trimmed while typing, or a comma would vanish as soon as it is typed. */}
            <Input
              className="w-56 font-mono text-[13px]"
              value={repo.exclude.join(',')}
              onChange={(e) => patch(index, { exclude: e.target.value.split(',') })}
            />
          </Row>
          <RepoStatus repo={repo} live={data?.repos.find((r) => r.id === repo.id)} dirty={dirty} />
        </Section>
      ))}
    </>
  );
}
