import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo, Provider } from './types';

// The key belongs to the person using the app and never leaves their browser
// except to api.anthropic.com, which is what this flag acknowledges.
const client = (key: string) => new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });

const DEFAULT_MAX_OUTPUT = 64000;

export const anthropic: Provider = {
  id: 'anthropic',
  label: 'Claude',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  keyHint: 'sk-ant-…',

  async listModels(key) {
    const models: ModelInfo[] = [];
    for await (const m of client(key).models.list()) {
      const cap = (m as { max_tokens?: number }).max_tokens;
      models.push({ id: m.id, maxOutput: typeof cap === 'number' ? cap : undefined });
    }
    return models;
  },

  async stream({ key, model, system, turns, signal, onText }) {
    const stream = client(key).messages.stream(
      {
        model: model.id,
        max_tokens: Math.min(DEFAULT_MAX_OUTPUT, model.maxOutput ?? DEFAULT_MAX_OUTPUT),
        system,
        messages: turns,
      },
      { signal },
    );
    stream.on('text', onText);
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      throw new Error('The model declined this request. Try rephrasing, or pick another model.');
    }
    if (final.stop_reason === 'max_tokens') onText('\n\n_[Stopped at the output limit.]_');
  },
};
