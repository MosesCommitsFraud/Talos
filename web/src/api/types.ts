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
  [key: string]: unknown;
}

export interface SessionDetail {
  id: string;
  name: string;
  history: HistoryMessage[];
}

/** One tool invocation inside an assistant turn. */
export interface ToolCall {
  tool: string;
  command?: string;
  output?: string;
  exitCode?: number;
  status: 'running' | 'done' | 'error';
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
}

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
