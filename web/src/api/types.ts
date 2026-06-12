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
}

export interface ModelEndpoint {
  id: string;
  name: string;
  base_url: string;
  models: string[];
  model_type: string;
  is_enabled: boolean;
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Backend message metadata; `_db_id` keys edit/delete operations. */
  metadata?: { _db_id?: string; attachments?: Attachment[]; tool_events?: ToolCall[]; [key: string]: unknown };
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
  context_percent?: number;
  context_length?: number;
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
