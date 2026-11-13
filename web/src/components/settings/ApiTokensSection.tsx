import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createApiToken, deleteApiToken, fetchApiTokens, type ApiToken } from '@/api/client';
import { copyTextToClipboard } from '@/lib/utils';
import { Button } from '../ui/button';
import { toast } from '../ui/toast';
import { Row, Section } from '../SettingsDialog';
import { Input } from '../ui/misc';
import { Select } from '../ui/select';

// routes/api_token_routes.py TOKEN_PROFILES, as far as an MCP client needs them.
const PROFILES = ['mcp_update', 'mcp', 'mcp_web', 'mcp_sql'] as const;

/**
 * A token just created. This is the only time it can be shown: the server keeps
 * only a hash, so there is nothing to reveal later. Held in this component's state
 * alone, and gone once dismissed.
 */
function NewToken({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');

  const onCopy = async () => {
    setCopy((await copyTextToClipboard(token)) ? 'done' : 'failed');
    setTimeout(() => setCopy('idle'), 2000);
  };

  return (
    <div className="my-2 space-y-2 rounded-lg border border-border bg-muted/40 p-3">
      <div className="text-sm text-foreground">{t('settings.mcp.tokens.created', { name })}</div>
      <p className="text-[13px] leading-snug text-muted-foreground">{t('settings.mcp.tokens.onlyOnce')}</p>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          data-1p-ignore
          aria-label={t('settings.mcp.tokens.value')}
          className="min-w-0 flex-1 font-mono text-[13px]"
          value={token}
          onFocus={(e) => e.target.select()}
        />
        <Button
          size="sm"
          variant="outline"
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
          {t(shown ? 'settings.mcp.tokens.hide' : 'settings.mcp.tokens.reveal')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void onCopy()}>
          {copy === 'done' ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {t(copy === 'done' ? 'settings.mcp.tokens.copied' : 'settings.mcp.tokens.copy')}
        </Button>
      </div>
      {copy === 'failed' && (
        <p className="text-[13px] leading-snug text-destructive">{t('settings.mcp.tokens.copyFailed')}</p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] leading-snug text-muted-foreground">
          {t('settings.mcp.tokens.usage')} <code className="font-mono">Authorization: Bearer ody_…</code>
        </p>
        <Button size="sm" variant="ghost" onClick={onDone}>{t('settings.mcp.tokens.done')}</Button>
      </div>
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiToken; onRevoke: () => void }) {
  const { t } = useTranslation();
  const used = token.last_used_at
    ? t('settings.mcp.tokens.lastUsed', { date: new Date(token.last_used_at).toLocaleString() })
    : t('settings.mcp.tokens.neverUsed');
  return (
    <Row
      label={(
        <>
          <div>{token.name}</div>
          <div className="text-[13px] leading-snug text-muted-foreground">
            <code className="font-mono">{token.token_prefix}…</code> · {token.scopes.join(', ')} · {used}
          </div>
        </>
      )}
    >
      <Button size="icon-sm" variant="ghost" aria-label={t('settings.mcp.tokens.revoke', { name: token.name })} onClick={onRevoke}>
        <Trash2Icon />
      </Button>
    </Row>
  );
}

/** Creates and revokes the API tokens external MCP clients authenticate with. */
export function ApiTokensSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: tokens } = useQuery({ queryKey: ['api-tokens'], queryFn: fetchApiTokens });
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<string>(PROFILES[0]);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
  const create = useMutation({
    mutationFn: () => createApiToken(name.trim(), profile),
    onSuccess: (row) => {
      toast('toasts.tokenCreated', { name: row.name });
      setCreated({ name: row.name, token: row.token });
      setName('');
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: deleteApiToken, onSettled: refresh });

  return (
    <Section title={t('settings.mcp.tokens.title')}>
      <p className="pb-2 text-[13px] leading-snug text-muted-foreground">{t('settings.mcp.tokens.intro')}</p>
      <Row stacked label={t('settings.mcp.tokens.new')}>
        <Input
          className="w-48"
          aria-label={t('settings.mcp.tokens.name')}
          placeholder={t('settings.mcp.tokens.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create.mutate(); }}
        />
        <Select
          className="w-72"
          value={profile}
          onChange={setProfile}
          options={PROFILES.map((p) => ({ value: p, label: t(`settings.mcp.tokens.profile.${p}`) }))}
        />
        <Button size="sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
          <KeyRoundIcon className="size-3.5" />
          {t('settings.mcp.tokens.generate')}
        </Button>
      </Row>
      {create.isError && (
        <p className="pb-2 text-[13px] leading-snug text-destructive">{(create.error as Error).message}</p>
      )}
      {revoke.isError && (
        <p className="pb-2 text-[13px] leading-snug text-destructive">{(revoke.error as Error).message}</p>
      )}
      {created && <NewToken {...created} onDone={() => setCreated(null)} />}
      {(tokens ?? []).map((token) => (
        <TokenRow
          key={token.id}
          token={token}
          onRevoke={() => {
            if (window.confirm(t('settings.mcp.tokens.revokeConfirm', { name: token.name }))) revoke.mutate(token.id);
          }}
        />
      ))}
    </Section>
  );
}
