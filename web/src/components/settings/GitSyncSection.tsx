import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  GIT_DEFAULT_DB_TARGET,
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
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['git-sync'] }),
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
  // In the label rather than the row's hint: the settings dialog hides hints, and this
  // is the only place that says what the last run did.
  return (
    <Row
      stacked
      label={(
        <>
          <div>{t('settings.mcp.git.lastRun')}</div>
          <div className={cn('text-[13px] leading-snug text-muted-foreground', failed && 'text-destructive')}>{hint}</div>
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
}: {
  repos: GitRepoConfig[];
  bases: RagBase[];
  dirty: boolean;
  onChange: (repos: GitRepoConfig[]) => void;
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

  // A mini RAG whose database was removed takes no new documents.
  const targets = [
    { value: GIT_DEFAULT_DB_TARGET, label: t('settings.mcp.git.defaultDb') },
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
            />
          </Row>
          <Row label={t('settings.mcp.git.branch')} hint={t('settings.mcp.git.branchHint')}>
            <Input
              className="w-56 font-mono text-[13px]"
              value={repo.branch}
              onChange={(e) => patch(index, { branch: e.target.value })}
            />
          </Row>
          <Row label={t('settings.mcp.git.token')} hint={t('settings.mcp.git.tokenHint')}>
            <Input
              type="password"
              autoComplete="new-password"
              className="w-56"
              value={repo.token}
              onChange={(e) => patch(index, { token: e.target.value })}
            />
          </Row>
          <Row label={t('settings.mcp.git.default')} hint={t('settings.mcp.git.defaultHint')}>
            <Switch checked={repo.default} onCheckedChange={(on) => { if (on) makeDefault(index); }} />
          </Row>
          <Row label={t('settings.mcp.git.folders')} hint={t('settings.mcp.git.foldersHint')} stacked>
            <div className="flex w-full flex-col items-end gap-2">
              {repo.mappings.map((mapping, m) => {
                const setMapping = (change: Partial<typeof mapping>) =>
                  patch(index, { mappings: repo.mappings.map((x, j) => (j === m ? { ...x, ...change } : x)) });
                return (
                  <div key={m} className="flex items-center gap-2">
                    <Input
                      aria-label={t('settings.mcp.git.folder')}
                      className="w-36 font-mono text-[13px]"
                      placeholder={t('settings.mcp.git.wholeRepo')}
                      value={mapping.folder}
                      onChange={(e) => setMapping({ folder: e.target.value })}
                    />
                    <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <Select
                      className="w-72"
                      value={mapping.base}
                      onChange={(base) => setMapping({ base })}
                      options={targets}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('settings.mcp.git.removeFolder')}
                      onClick={() => patch(index, { mappings: repo.mappings.filter((_, j) => j !== m) })}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => patch(index, { mappings: [...repo.mappings, { folder: '', base: 'default' }] })}
              >
                <PlusIcon className="size-3.5" />
                {t('settings.mcp.git.addFolder')}
              </Button>
            </div>
          </Row>
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
