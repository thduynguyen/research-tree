import type { ProviderId } from '../types';
import { anthropic } from './anthropic';
import { demo } from './demo';
import { gemini } from './gemini';
import { custom, openai } from './openai';
import type { Provider } from './types';

export const providers: Record<ProviderId, Provider> = { anthropic, openai, gemini, custom, demo };

/** Providers that need a key, in the order the setup screen suggests them. */
export const keyedProviders: Provider[] = [gemini, anthropic, openai];

/** Every provider the model list can offer, once set up. */
export const realProviders: Provider[] = [...keyedProviders, custom];

export { cleanUrl, serverExtras } from './openai';

export type { ModelInfo, Provider } from './types';
