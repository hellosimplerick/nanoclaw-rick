import {
  LlmProvider,
  ProviderPrompt,
  ProviderQueryInput,
  ProviderQueryResult,
  ProviderUserMessage,
} from './provider.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAiProvider implements LlmProvider {
  async *query(input: ProviderQueryInput): ProviderQueryResult {
    const sessionId =
      input.options?.resume ||
      `openai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    yield { type: 'system', subtype: 'init', session_id: sessionId };

    const { apiKey, baseUrl } = resolveApiConfig();
    const endpoint = resolveChatCompletionsEndpoint(baseUrl);
    const model = process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
    const promptText = await readPromptText(input.prompt);
    const systemText = readSystemPrompt(input);

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
    messages.push({ role: 'user', content: promptText });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
      }),
    });

    const bodyText = await response.text();
    let parsed: ChatCompletionResponse | null = null;
    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText) as ChatCompletionResponse;
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const errorDetails = parsed?.error?.message || bodyText.slice(0, 400);
      throw new Error(
        `OpenAI-compatible request failed (${response.status} ${response.statusText}): ${errorDetails}`,
      );
    }

    const resultText = parsed?.choices?.[0]?.message?.content?.trim();

    // If the provider returned no content, dump a safe slice of the raw body for diagnosis.
    if (!resultText) {
      const safeSlice = bodyText.slice(0, 1200);
      console.error(
        `[openai-provider] Empty content. status=${response.status} model=${model} endpoint=${endpoint} body=${safeSlice}`,
      );
    }

    yield {
      type: 'result',
      subtype: 'success',
      result: resultText || '[Empty response from OpenAI-compatible provider]',
    };
  }
}

function resolveApiConfig(): { apiKey: string; baseUrl: string } {
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    return {
      apiKey: openRouterKey,
      baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL,
    };
  }

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey) {
    return {
      apiKey: openAiKey,
      baseUrl: process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
    };
  }

  throw new Error(
    'Missing API credentials: set OPENROUTER_API_KEY or OPENAI_API_KEY for LLM_PROVIDER=openai.',
  );
}

function resolveChatCompletionsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.endsWith('/v1')) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

function readSystemPrompt(input: ProviderQueryInput): string | undefined {
  const systemPrompt = input.options?.systemPrompt;
  if (typeof systemPrompt === 'string') return systemPrompt;
  if (
    systemPrompt &&
    typeof systemPrompt === 'object' &&
    'append' in systemPrompt &&
    typeof (systemPrompt as { append?: unknown }).append === 'string'
  ) {
    return (systemPrompt as { append: string }).append;
  }
  return undefined;
}

async function readPromptText(prompt: ProviderPrompt): Promise<string> {
  if (typeof prompt === 'string') return prompt;

  const iterator = prompt[Symbol.asyncIterator]();
  const chunks: string[] = [];

  const first = await iterator.next();
  if (first.done) return '';
  chunks.push(extractContent(first.value));

  // Drain any immediately-following messages without hanging indefinitely.
  while (true) {
    const next = await readNextWithTimeout(iterator, 100);
    if (!next || next.done) break;
    chunks.push(extractContent(next.value));
  }

  return chunks.filter(Boolean).join('\n');
}

function extractContent(msg: ProviderUserMessage): string {
  return msg.message?.content || '';
}

async function readNextWithTimeout(
  iterator: AsyncIterator<ProviderUserMessage>,
  timeoutMs: number,
): Promise<IteratorResult<ProviderUserMessage> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    iterator
      .next()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({ done: true, value: undefined as never });
      });
  });
}
