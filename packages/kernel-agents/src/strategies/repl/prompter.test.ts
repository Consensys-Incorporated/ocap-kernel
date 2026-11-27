import '@ocap/repo-tools/test-utils/mock-endoify';

import { describe, it, expect } from 'vitest';

import { makePrompter } from './prompter.ts';

describe('makePrompter', () => {
  it('makes the expected prompt', () => {
    const prompter = makePrompter({});
    const { prompt, readerArgs } = prompter([]);
    expect(typeof readerArgs.stop).toBe('string');
    expect(prompt).toContain(
      '> import { end, search } from "@ocap/abilities";',
    );
    expect(prompt).toContain(
      `end: {\n  "description": "Return a final response to the user.",`,
    );
    expect(prompt).toContain(
      `search: {\n  "description": "Search the web for information.",`,
    );
    expect(prompt).toContain('! What is the oldest tree in South America?');
    expect(prompt).toContain(
      '> // This information is too specific for me to know on my own.',
    );
    expect(prompt).toContain(
      "> await search({ query: 'oldest tree in South America' });",
    );
  });
});
