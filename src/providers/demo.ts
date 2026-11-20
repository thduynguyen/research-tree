import type { Provider } from './types';

/** No key, no network: lets you try branching before setting up a provider. */
export const demo: Provider = {
  id: 'demo',
  label: 'Demo (no AI)',
  keyUrl: '',
  keyHint: '',

  async listModels() {
    return [{ id: 'demo' }];
  },

  async stream({ turns, signal, onText }) {
    const question = turns[turns.length - 1]?.content ?? '';
    const reply =
      `This is the demo model, so there is no real answer to "${question.slice(-200)}". ` +
      'It exists so you can try the interface without a key.\n\n' +
      'Select any phrase in this reply and choose **Ask in a new branch**. ' +
      'The branch opens in a column to the right, anchored to the words you selected. ' +
      'You can branch again from inside that branch, collapse back, or make any pane the root of a new session.\n\n' +
      'Add a key under **Settings** to get real answers from Claude, Gemini or ChatGPT.';
    for (const word of reply.split(/(?<=\s)/)) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      onText(word);
      await new Promise((r) => setTimeout(r, 12));
    }
  },
};
