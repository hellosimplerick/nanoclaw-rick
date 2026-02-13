export interface ProviderUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
}

export type ProviderPrompt = string | AsyncIterable<ProviderUserMessage>;

export interface ProviderQueryOptions {
  cwd?: string;
  resume?: string;
  resumeSessionAt?: string;
  systemPrompt?: unknown;
  [key: string]: unknown;
}

export interface ProviderQueryInput {
  prompt: ProviderPrompt;
  options?: ProviderQueryOptions;
}

export type ProviderEvent =
  | {
      type: 'system';
      subtype?: string;
      session_id?: string;
      [key: string]: unknown;
    }
  | {
      type: 'assistant';
      uuid?: string;
      [key: string]: unknown;
    }
  | {
      type: 'result';
      subtype?: string;
      result?: string;
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export type ProviderQueryResult = AsyncIterable<ProviderEvent>;

export interface LlmProvider {
  query(input: ProviderQueryInput): ProviderQueryResult;
}
