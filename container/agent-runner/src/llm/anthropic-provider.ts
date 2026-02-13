import { query as anthropicQuery } from '@anthropic-ai/claude-agent-sdk';

import {
  LlmProvider,
  ProviderQueryInput,
  ProviderQueryResult,
} from './provider.js';

export class AnthropicProvider implements LlmProvider {
  query(input: ProviderQueryInput): ProviderQueryResult {
    return anthropicQuery(input);
  }
}
