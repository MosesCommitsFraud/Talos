import { useQuery } from '@tanstack/react-query';
import { fetchArtifacts } from '@/api/client';
import type { Attachment } from '@/api/types';
import { useChat } from '@/state/chat';
import type { UiMessage } from '@/state/chat';
import { artifactDisplayName, samePath } from './files';

/** One file the agent produced in this chat, normalised from the artifact row. */
export interface SessionFile {
  path: string;
  name: string;
  size?: number;
  mime?: string;
  version?: number;
  mtime?: number;
  source?: string;
}

/** The chat's files, split the way the UI shows them: what the agent produced
 *  (`outputs`, newest first) and what the user uploaded (`inputs`). Uploads the
 *  agent copied into its workspace are dropped from the outputs — they are
 *  inputs, not results. The chat banner, the header's file menu and the panel
 *  all read through here so they agree on what counts as an output. */
export function useSessionFiles(sessionId: string | null) {
  const messages = useChat((s) => s.messages);
  const query = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => fetchArtifacts(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 10_000,
  });

  const inputs: Attachment[] = messages.flatMap((m) => (m.role === 'user' ? (m.attachments ?? []) : []));
  const inputPaths = new Set(
    inputs.flatMap((f) => [f.sandbox_path, f.name].filter((v): v is string => !!v)),
  );
  const outputs: SessionFile[] = (query.data ?? []).flatMap((f) => {
    const path = String(f.path ?? f.name ?? '');
    if (!path || (f.source === 'workspace' && inputPaths.has(path))) return [];
    const mime = typeof f.mime === 'string' && f.mime ? f.mime : undefined;
    return [{
      path,
      name: artifactDisplayName(path, typeof f.name === 'string' ? f.name : undefined),
      size: typeof f.size === 'number' ? f.size : undefined,
      mime,
      version: typeof f.version === 'number' ? f.version : undefined,
      mtime: typeof f.mtime === 'number' ? f.mtime : undefined,
      source: typeof f.source === 'string' ? f.source : undefined,
    }];
  });

  return { outputs, inputs, isLoading: query.isLoading, isError: query.isError };
}

/** Paths the agent named with `present_files` in these messages, in call order. */
export function presentedPaths(messages: UiMessage[]): string[] {
  const paths: string[] = [];
  for (const m of messages) {
    for (const tool of m.tools ?? []) {
      for (const path of tool.presented_files ?? []) {
        if (!paths.includes(path)) paths.push(path);
      }
    }
  }
  return paths;
}

/** The session files those paths refer to. A path that matches nothing yet (the
 *  list refetches on its own) just has no card until it does. */
export function presentedOutputs(messages: UiMessage[], outputs: SessionFile[]): SessionFile[] {
  const found: SessionFile[] = [];
  for (const path of presentedPaths(messages)) {
    const file = outputs.find((f) => samePath(path, f.path, f.name));
    if (file && !found.includes(file)) found.push(file);
  }
  return found;
}
