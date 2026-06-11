export interface Session {
  id: string;
  name: string;
  model: string;
  endpoint_url: string;
  created_at: number;
  updated_at: number;
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
}

export interface Metrics {
  model?: string;
  response_time?: number;
  tokens_per_second?: number;
  output_tokens?: number;
  context_percent?: number;
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
