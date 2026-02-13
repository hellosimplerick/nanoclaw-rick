import { query as anthropicQuery } from '@anthropic-ai/claude-agent-sdk';

import {
  LlmProvider,
  ProviderEvent,
  ProviderQueryInput,
  ProviderQueryResult,
} from './provider.js';

export class AnthropicProvider implements LlmProvider {
  query(input: ProviderQueryInput): ProviderQueryResult {
    return anthropicQuery(input as Parameters<typeof anthropicQuery>[0]) as AsyncIterable<ProviderEvent>;
  }
}
