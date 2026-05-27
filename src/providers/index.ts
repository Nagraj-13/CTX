import OpenAI from 'openai';
import { LLMProvider, CompletionRequest, CtxConfig, ProviderType } from '../core/types.js';
import { countTokens } from '../utils/helpers.js';

// ─── Provider configs ─────────────────────────────────────────────────────────

interface ProviderConfig {
  baseURL: string;
  defaultModel: string;
  contextWindow: number;
  requiresKey: boolean;
}

const PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    contextWindow: 128000,
    requiresKey: true,
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    contextWindow: 128000,
    requiresKey: true,
  },
  nvidia_nim: {
    baseURL: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.1-70b-instruct',
    contextWindow: 128000,
    requiresKey: true,
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2:latest',
    contextWindow: 32000,
    requiresKey: false,
  },
  custom: {
    baseURL: 'http://localhost:8080/v1',
    defaultModel: 'default',
    contextWindow: 128000,
    requiresKey: false,
  },
};

// ─── OpenAI-compatible provider implementation ────────────────────────────────

class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly contextWindowSize: number;
  private client: OpenAI;

  constructor(type: ProviderType, model: string, apiKey: string, baseUrl?: string) {
    const cfg = PROVIDER_CONFIGS[type];
    this.name = type;
    this.model = model || cfg.defaultModel;
    this.contextWindowSize = cfg.contextWindow;

    this.client = new OpenAI({
      apiKey: apiKey || (cfg.requiresKey ? undefined : 'dummy'),
      baseURL: baseUrl || cfg.baseURL,
    });
  }

  async complete(req: CompletionRequest): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stop: req.stopSequences,
        });

        return response.choices[0]?.message?.content ?? '';
      } catch (err: unknown) {
        lastError = err as Error;
        const errMsg = lastError.message || '';

        // Rate limit — backoff
        if (errMsg.includes('429') || errMsg.includes('rate_limit')) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          await sleep(delay + Math.random() * 500);
          continue;
        }

        // Context length — fail immediately (caller should truncate)
        if (errMsg.includes('context') || errMsg.includes('maximum') || errMsg.includes('tokens')) {
          throw new Error(`Context length error: ${errMsg}`);
        }

        // Other error — retry with backoff
        if (attempt < maxRetries - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
      }
    }

    throw lastError ?? new Error('LLM request failed');
  }

  estimateTokens(text: string): number {
    return countTokens(text);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createProvider(config: CtxConfig): LLMProvider {
  const { type, model, apiKey, baseUrl } = config.provider;

  if (!apiKey && PROVIDER_CONFIGS[type].requiresKey) {
    throw new Error(
      `No API key configured for provider "${type}". ` +
      `Set CTX_API_KEY environment variable or run: ctx init`
    );
  }

  return new OpenAICompatProvider(type, model, apiKey ?? '', baseUrl);
}

// ─── Provider validation ──────────────────────────────────────────────────────

export async function validateProvider(config: CtxConfig): Promise<{ ok: boolean; error?: string; model?: string }> {
  try {
    const provider = createProvider(config);
    const response = await provider.complete({
      system: 'You are a test assistant.',
      user: 'Reply with exactly: "CTX provider check OK"',
      maxTokens: 20,
      temperature: 0,
    });
    return { ok: response.includes('OK') || response.length > 0, model: provider.model };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { PROVIDER_CONFIGS };
