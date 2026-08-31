export interface Session {
  id: string;
  name: string;
  model: string;
  endpoint_url: string;
  created_at: number | string | null;
  updated_at: number | string | null;
  last_message_at?: number | string | null;
  message_count: number;
  archived: boolean;
  /** Starred/pinned — surfaced as "Pinned" in the sidebar. */
  is_important?: boolean;
  /** Flat folder/workspace name, or null/empty when ungrouped. */
  folder?: string | null;
}

export interface ModelEndpoint {
  id: string;
  name: string;
  base_url: string;
  models: string[];
  model_type: string;
  is_enabled: boolean;
}

/** A named, admin-managed AI endpoint exposed on the LAN (OpenAI-compatible). */
export interface AssistantEndpoint {
  id: string;
  name: string;
  slug: string;
  description: string;
  endpoint_id: string;
  endpoint_name?: string | null;
  model: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  use_rag: boolean;
  use_sql: boolean;
  reasoning: boolean;
  disabled_tools: string[];
  require_auth: boolean;
  is_enabled: boolean;
  created_at?: string | null;
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Backend message metadata; `_db_id` keys edit/delete operations. */
  metadata?: { _db_id?: string; attachments?: Attachment[]; tool_events?: ToolCall[]; [key: string]: unknown };
}

/** A knowledge-base chunk the RAG retriever fed into the answer (for citations). */
export interface RagSource {
  filename: string;
  snippet: string;
  similarity: number;
  /** Set for image/video chunks so the citation can show a preview/timestamp. */
  modality?: 'image' | 'video';
  /** Path-confined endpoint that streams the indexed image (image modality). */
  image_url?: string;
  /** VLM/Docling caption for a figure crop (image modality). */
  image_caption?: string;
  /** External video URL, when one was provided at ingest (video modality). */
  video_url?: string;
  /** Deep-link into the source video at the segment start (video modality). */
  deeplink?: string;
  /** Segment start/end in seconds (video modality). */
  start?: number;
  end?: number;
}

export interface Attachment {
  id: string;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  sandbox_path?: string;
  [key: string]: unknown;
}

export interface Artifact {
  path?: string;
  name?: string;
  size?: number;
  mime?: string;
  is_image?: boolean;
  source?: 'workspace' | 'document' | 'generated_image';
  version?: number;
  [key: string]: unknown;
}

export interface ArtifactSelectionTarget {
  type: 'text' | 'element';
  quote?: string;
  page?: number;
  pageEnd?: number;
  sheet?: string;
  cell?: string;
  slide?: number;
  element?: string;
}

export interface ArtifactSelection {
  sessionId: string;
  path: string;
  name: string;
  mime?: string;
  version?: number;
  kind: string;
  target: ArtifactSelectionTarget;
  targets?: ArtifactSelectionTarget[];
  visuals?: Array<{ page?: number; dataUrl: string }>;
}

export interface SessionDetail {
  id: string;
  name: string;
  history: HistoryMessage[];
}

/** A structured UI payload a tool attached to its result — rendered as a real
 *  component (a weather card, a chart) instead of the monospace output block.
 *  See `src/widgets.py` for the emitting side and
 *  `components/widgets/registry.tsx` for the components.
 *
 *  `data` is deliberately `unknown`: it arrives from the backend and from old
 *  persisted turns, so each component narrows its own payload rather than
 *  trusting a type that was true when the turn was written. `version` is how a
 *  component keeps rendering payloads written before its shape changed. */
export interface Widget {
  type: string;
  version: number;
  data: unknown;
}

/** One tool invocation inside an assistant turn. */
export interface ToolCall {
  tool: string;
  command?: string;
  output?: string;
  exitCode?: number;
  status: 'running' | 'done' | 'error';
  /** Unified diff emitted by the file-editing tools (edit_file / write_file),
   *  rendered as a before/after view instead of raw output. */
  diff?: string;
  image_url?: string;
  image_prompt?: string;
  image_model?: string;
  image_size?: string;
  image_quality?: string;
  image_note?: string;
  screenshot?: string;
  created_images?: Array<{
    name?: string;
    caption?: string;
    data_url?: string;
    url?: string;
    [key: string]: unknown;
  }>;
  widget?: Widget;
}

export interface Metrics {
  model?: string;
  response_time?: number;
  tokens_per_second?: number;
  output_tokens?: number;
  input_tokens?: number;
  context_percent?: number;
  context_length?: number;
  /** Actual context-window occupancy (last round's prompt). The meter shows
   *  this so its token number and percentage stay in sync; input_tokens by
   *  contrast sums every agent round. */
  context_tokens?: number;
  /** "real" when the count came from the provider's usage/tokenizer,
   *  "estimated" when it's the chars*0.3 fallback. Drives the meter's badge. */
  usage_source?: 'real' | 'estimated';
  /** Per-category split of context_tokens for the meter's detail panel.
   *  Categories always sum to context_tokens: the total is authoritative
   *  (real when usage_source is "real"); the split between categories is
   *  proportional-to-estimate. */
  context_breakdown?: Partial<Record<ContextCategory, number>>;
}

/** Context-meter breakdown categories, in display order. */
export type ContextCategory =
  | 'system'
  | 'tools'
  | 'mcpTools'
  | 'skills'
  | 'knowledge'
  | 'documents'
  | 'toolResults'
  | 'messages';

/** Server-sent event emitted by POST /api/chat_stream. The stream mixes
 *  text deltas ({delta, thinking?}) with typed control events
 *  (tool_start/tool_output/metrics/…), so this is one loose shape rather
 *  than a discriminated union — the wire format has no single discriminant. */
export interface ChatEvent {
  delta?: string;
  thinking?: boolean;
  type?: string;
  tool?: string;
  command?: string;
  tail?: string;
  output?: string;
  exit_code?: number;
  data?: Metrics;
  [key: string]: unknown;
}

/** One detached job from `src/bg_jobs.py` — a shell command launched with the
 *  chat's `bash` tool in background mode (`kind: 'shell'`), or a whole nested
 *  agent turn spawned by `background_task` (`kind: 'agent'`). Both outlive the
 *  turn that started them, which is why the UI polls for them separately from
 *  the message stream. */
export interface BgTask {
  id: string;
  kind: 'shell' | 'agent';
  /** The command line, or the agent task's label / first line. */
  label: string;
  status: 'running' | 'done' | 'failed';
  /** Unix seconds (the backend's `time.time()`), not JS milliseconds. */
  started_at?: number;
  ended_at?: number | null;
  exit_code?: number | null;
  timed_out?: boolean;
  /** Tail of the captured log — stdout+stderr for a shell job, the written
   *  report for an agent job. */
  output: string;
}
