import type { query as anthropicQuery } from '@anthropic-ai/claude-agent-sdk';

export type ProviderQueryInput = Parameters<typeof anthropicQuery>[0];
export type ProviderQueryResult = ReturnType<typeof anthropicQuery>;

export interface LlmProvider {
  query(input: ProviderQueryInput): ProviderQueryResult;
}
