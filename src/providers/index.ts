import type { ProviderId } from '../types';
import { anthropic } from './anthropic';
import { demo } from './demo';
import { gemini } from './gemini';
import { openai } from './openai';
import type { Provider } from './types';

export const providers: Record<ProviderId, Provider> = { anthropic, openai, gemini, demo };

/** Providers that need a key, in the order the setup screen suggests them. */
export const keyedProviders: Provider[] = [gemini, anthropic, openai];

export type { ModelInfo, Provider } from './types';
