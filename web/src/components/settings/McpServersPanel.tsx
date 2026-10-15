import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  fetchMcpServerTools,
  reconnectMcpServer,
  setMcpDisabledTools,
  setMcpServerEnabled,
  type McpServerInfo,
  type McpServerInput,
  type McpTransport,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Page, Section, Segmented } from '../SettingsDialog';
import { Input, Switch, Textarea } from '../ui/misc';
import { Select } from '../ui/select';

/* Settings → MCP connections: the external MCP servers Talos connects to as a
   client (routes/mcp_routes.py). Their tools reach the agent as
   mcp__<id>__<tool>. Talos's own outward server lives in the "MCP" panel. */

const SERVERS_KEY = ['mcp-servers'];

/** Map a client config's transport spelling onto the three Talos knows.
 *  Claude Desktop / Cursor write `type`, VS Code `type` too, others `transport`;
 *  a url without one means Streamable HTTP, the current MCP default. */
function normalizeTransport(raw: unknown, hasUrl: boolean): McpTransport {
  const v = String(raw ?? '').toLowerCase().replace(/[-_]/g, '');
  if (v === 'sse') return 'sse';
  if (v === 'stdio') return 'stdio';
  if (v === 'http' || v === 'streamablehttp') return 'http';
  return hasUrl ? 'http' : 'stdio';
}

function toStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]));
}

function entryToInput(name: string, cfg: Record<string, unknown>): McpServerInput | null {
  const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
  const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
  if (!url && !command) return null;
  const transport = normalizeTransport(cfg.type ?? cfg.transport, !!url);
  if (transport === 'stdio') {
    return {
      name,
      transport,
      command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: toStringMap(cfg.env),
    };
  }
  return { name, transport, url, env: toStringMap(cfg.env) };
}

/** Parse the `mcpServers` JSON most MCP READMEs ship. Accepts the full file
 *  (`{"mcpServers": {...}}`, VS Code's `{"servers": {...}}`), a bare
 *  name → config map, a single config object, or a pasted `"name": {...}`
 *  fragment without its outer braces. */
export function parseMcpJson(text: string): McpServerInput[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    data = JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
  const obj = data as Record<string, unknown>;
  const map = (obj.mcpServers ?? obj.servers ?? obj) as Record<string, unknown>;
  if ('command' in map || 'url' in map) {
    const single = entryToInput(String(map.name ?? 'mcp-server'), map);
    return single ? [single] : [];
  }
  return Object.entries(map).flatMap(([name, cfg]) => {
    if (!cfg || typeof cfg !== 'object') return [];
    const input = entryToInput(name, cfg as Record<string, unknown>);
    return input ? [input] : [];
  });
}

function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const eq = l.indexOf('=');
    if (eq <= 0) continue;
    env[l.slice(0, eq).trim()] = l.slice(eq + 1).trim();
  }
  return env;
}

function StatusDot({ srv }: { srv: McpServerInfo }) {
  const { t } = useTranslation();
  const status = !srv.is_enabled ? 'off' : srv.needs_oauth ? 'needs_auth' : srv.status;
  const color = {
    connected: 'bg-emerald-500',
    connecting: 'bg-amber-400 animate-pulse',
    needs_auth: 'bg-amber-400',
    error: 'bg-red-500',
  }[status] ?? 'bg-muted-foreground/40';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={cn('size-2 shrink-0 rounded-full', color)} />
      {t(`settings.mcpServers.status.${status}`, { defaultValue: status })}
    </span>
  );
}

function ToolsList({ srv, onChanged }: { srv: McpServerInfo; onChanged: () => void }) {
  const { t } = useTranslation();
  const { data: tools, isLoading, refetch } = useQuery({
    queryKey: ['mcp-server-tools', srv.id, srv.tool_count],
    queryFn: () => fetchMcpServerTools(srv.id),
  });
  const [saving, setSaving] = useState(false);
  const save = (disabled: string[]) => {
    setSaving(true);
    void setMcpDisabledTools(srv.id, disabled)
      .then(() => { void refetch(); onChanged(); })
      .catch((e) => window.alert((e as Error).message))
      .finally(() => setSaving(false));
  };
  const list = tools ?? [];
  const disabled = list.filter((x) => x.is_disabled).map((x) => x.name);
  const toggle = (name: string) =>
    save(disabled.includes(name) ? disabled.filter((n) => n !== name) : [...disabled, name]);

  if (isLoading) return <p className="py-2 text-xs text-muted-foreground">{t('common.loading')}</p>;
  if (list.length === 0) return <p className="py-2 text-xs text-muted-foreground">{t('settings.mcpServers.noTools')}</p>;
  return (
    <div className="pt-2">
      <div className="flex items-center justify-between pb-1">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('settings.mcpServers.toolsTitle', { enabled: list.length - disabled.length, total: list.length })}
        </span>
        <div className="flex gap-3 text-xs">
          <button type="button" disabled={saving} className="text-muted-foreground hover:text-foreground" onClick={() => save([])}>{t('settings.users.all')}</button>
          <button type="button" disabled={saving} className="text-muted-foreground hover:text-foreground" onClick={() => save(list.map((x) => x.name))}>{t('settings.users.none')}</button>
        </div>
      </div>
      <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border bg-background p-1.5">
        {list.map((tool) => (
          <label key={tool.name} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60">
            <input
              type="checkbox"
              checked={!tool.is_disabled}
              disabled={saving}
              onChange={() => toggle(tool.name)}
              className="mt-0.5 accent-primary"
            />
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-xs">{tool.name}</span>
              {tool.description && (
                <span className="line-clamp-2 block text-[11px] text-muted-foreground">{tool.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ServerRow({ srv, onChanged }: { srv: McpServerInfo; onChanged: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    void p.catch((e) => window.alert((e as Error).message)).finally(() => { setBusy(false); onChanged(); });
  };
  const target = srv.transport === 'stdio' ? [srv.command, ...srv.args].filter(Boolean).join(' ') : srv.url ?? '';
  const envKeys = Object.keys(srv.env ?? {});
  const remove = () => {
    if (window.confirm(t('settings.mcpServers.removeConfirm', { name: srv.name }))) run(deleteMcpServer(srv.id));
  };

  return (
    <div className="rounded-lg border bg-background">
      <div className="flex cursor-pointer items-center gap-3 px-3 py-2" onClick={() => setOpen((v) => !v)}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm">{srv.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">{srv.transport}</span>
            <StatusDot srv={srv} />
            {srv.status === 'connected' && srv.is_enabled && (
              <span className="text-[11px] text-muted-foreground">
                {t('settings.mcpServers.toolCount', { enabled: srv.enabled_tool_count, total: srv.tool_count })}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={target}>{target}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {srv.auth_url && (
            <Button variant="outline" size="sm" onClick={() => window.open(srv.auth_url!, '_blank', 'noopener')}>
              {t('settings.mcpServers.authorize')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy || !srv.is_enabled}
            aria-label={t('settings.mcpServers.reconnect')}
            title={t('settings.mcpServers.reconnect')}
            onClick={() => run(reconnectMcpServer(srv.id))}
          >
            <RefreshCwIcon className={cn('size-3.5', busy && 'animate-spin')} />
          </Button>
          <Switch
            checked={srv.is_enabled}
            disabled={busy}
            aria-label={t('settings.mcpServers.enabled')}
            onCheckedChange={(v) => run(setMcpServerEnabled(srv.id, v))}
          />
          <button
            type="button"
            aria-label={t('settings.mcpServers.remove', { name: srv.name })}
            onClick={remove}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive-foreground"
          >
            <Trash2Icon className="size-3.5" />
          </button>
          <ChevronDownIcon className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </div>
      </div>
      {srv.is_enabled && srv.status === 'error' && srv.error && (
        <pre className="mx-3 mb-2 max-h-40 overflow-auto rounded-md bg-destructive/10 p-2 text-[11px] whitespace-pre-wrap text-destructive-foreground">{srv.error}</pre>
      )}
      {open && (
        <div className="border-t px-3 pt-1 pb-3">
          {envKeys.length > 0 && (
            <div className="pt-2 text-xs text-muted-foreground">
              {t('settings.mcpServers.envVars')}: <span className="font-mono">{envKeys.join(', ')}</span>
            </div>
          )}
          {srv.status === 'connected'
            ? <ToolsList srv={srv} onChanged={onChanged} />
            : <p className="py-2 text-xs text-muted-foreground">{t('settings.mcpServers.toolsWhenConnected')}</p>}
        </div>
      )}
    </div>
  );
}

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents@6.5.0", "mcp"]
    }
  }
}`;

function AddServer({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'json' | 'form'>('json');
  const [jsonText, setJsonText] = useState('');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  let parsed: McpServerInput[] = [];
  let parseError = '';
  if (mode === 'json' && jsonText.trim()) {
    try {
      parsed = parseMcpJson(jsonText);
      if (parsed.length === 0) parseError = t('settings.mcpServers.jsonEmpty');
    } catch {
      parseError = t('settings.mcpServers.jsonInvalid');
    }
  }

  const formInput: McpServerInput = transport === 'stdio'
    ? { name: name.trim(), transport, command: command.trim(), args: argsText.split('\n').map((a) => a.trim()).filter(Boolean), env: parseEnvLines(envText) }
    : { name: name.trim(), transport, url: url.trim(), env: parseEnvLines(envText) };
  const formValid = !!formInput.name && (transport === 'stdio' ? !!formInput.command : !!formInput.url);
  const toAdd = mode === 'json' ? parsed : formValid ? [formInput] : [];

  const submit = async () => {
    setBusy(true);
    setResult(null);
    const lines: string[] = [];
    let ok = true;
    for (const s of toAdd) {
      try {
        const r = await addMcpServer(s);
        if (r.status === 'connected') lines.push(t('settings.mcpServers.addedConnected', { name: s.name, tools: r.tool_count }));
        else {
          lines.push(t('settings.mcpServers.addedNotConnected', { name: s.name, status: r.status }));
          if (r.status === 'error') ok = false;
        }
      } catch (e) {
        ok = false;
        lines.push(`${s.name}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    setResult({ ok, text: lines.join('\n') });
    if (ok) {
      setJsonText(''); setName(''); setCommand(''); setArgsText(''); setEnvText(''); setUrl('');
    }
    onAdded();
  };

  return (
    <div className="space-y-2">
      <Segmented<'json' | 'form'>
        value={mode}
        onChange={setMode}
        label={t('settings.mcpServers.addMode')}
        options={[
          { value: 'json', label: t('settings.mcpServers.modeJson') },
          { value: 'form', label: t('settings.mcpServers.modeForm') },
        ]}
      />
      {mode === 'json' ? (
        <>
          <p className="text-xs text-muted-foreground">{t('settings.mcpServers.jsonHint')}</p>
          <Textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder={JSON_PLACEHOLDER}
            rows={8}
            spellCheck={false}
            className="font-mono text-xs"
          />
          {parseError && <p className="text-xs text-destructive-foreground">{parseError}</p>}
          {parsed.length > 0 && (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {parsed.map((s) => (
                <li key={s.name} className="truncate font-mono">
                  <span className="text-foreground">{s.name}</span> · {s.transport} · {s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url}
                  {Object.keys(s.env ?? {}).length > 0 && ` · env: ${Object.keys(s.env ?? {}).join(', ')}`}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="flex gap-2">
            <Input placeholder={t('settings.mcpServers.name')} value={name} onChange={(e) => setName(e.target.value)} />
            <Select
              value={transport}
              onChange={(v) => setTransport(v as McpTransport)}
              options={[
                { value: 'stdio', label: 'stdio' },
                { value: 'http', label: 'Streamable HTTP' },
                { value: 'sse', label: 'SSE' },
              ]}
              className="w-48 shrink-0"
            />
          </div>
          {transport === 'stdio' ? (
            <>
              <Input placeholder={t('settings.mcpServers.command')} value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono" />
              <Textarea placeholder={t('settings.mcpServers.argsPlaceholder')} value={argsText} onChange={(e) => setArgsText(e.target.value)} rows={3} spellCheck={false} className="font-mono text-xs" />
            </>
          ) : (
            <Input placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" />
          )}
          <Textarea placeholder={t('settings.mcpServers.envPlaceholder')} value={envText} onChange={(e) => setEnvText(e.target.value)} rows={2} spellCheck={false} className="font-mono text-xs" />
        </>
      )}
      <Button size="sm" disabled={busy || toAdd.length === 0} onClick={() => void submit()}>
        <PlusIcon /> {busy ? t('settings.mcpServers.connecting') : toAdd.length > 1 ? t('settings.mcpServers.addMany', { n: toAdd.length }) : t('settings.mcpServers.add')}
      </Button>
      {result && (
        <pre className={cn('rounded-md p-2 text-xs whitespace-pre-wrap', result.ok ? 'bg-emerald-500/10' : 'bg-destructive/10 text-destructive-foreground')}>{result.text}</pre>
      )}
    </div>
  );
}

export function McpServersPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: servers, isLoading, error } = useQuery({
    queryKey: SERVERS_KEY,
    queryFn: fetchMcpServers,
    // HTTP servers connect in the background; poll until they settle.
    refetchInterval: (q) => ((q.state.data ?? []).some((s) => s.is_enabled && s.status === 'connecting') ? 2000 : false),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: SERVERS_KEY });

  return (
    <Page>
      <Section title={t('settings.mcpServers.title')} padded>
        <p className="pb-3 text-[13px] text-muted-foreground">{t('settings.mcpServers.intro')}</p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : error ? (
          <p className="text-sm text-destructive-foreground">{(error as Error).message}</p>
        ) : (servers ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.mcpServers.empty')}</p>
        ) : (
          <div className="space-y-1.5">
            {(servers ?? []).map((srv) => <ServerRow key={srv.id} srv={srv} onChanged={refresh} />)}
          </div>
        )}
      </Section>
      <Section title={t('settings.mcpServers.addTitle')} padded>
        <AddServer onAdded={refresh} />
      </Section>
    </Page>
  );
}
