import { describe, expect, it } from 'vitest';

import type { ServiceDigest } from './ranker.ts';
import { formatRankingPrompt, parseMatches } from './ranker.ts';

const sampleDigests: ServiceDigest[] = [
  {
    id: 'svc:0',
    description: 'Signs messages with a personal key',
    methods: [
      { name: 'signMessage', description: 'Sign a personal message' },
      { name: 'getAccounts' },
    ],
  },
  {
    id: 'svc:1',
    description: 'Generates random numbers',
    methods: [],
  },
];

describe('formatRankingPrompt', () => {
  it('includes every service id, description, and method', () => {
    const prompt = formatRankingPrompt(sampleDigests, 'sign something');
    expect(prompt).toContain('Service svc:0:');
    expect(prompt).toContain('Signs messages with a personal key');
    expect(prompt).toContain('- signMessage: Sign a personal message');
    expect(prompt).toContain('- getAccounts');
    expect(prompt).toContain('Service svc:1:');
    expect(prompt).toContain('(no methods documented)');
  });

  it('includes the query after the registry', () => {
    const prompt = formatRankingPrompt(sampleDigests, 'sign something');
    expect(prompt.indexOf('Query: sign something')).toBeGreaterThan(
      prompt.indexOf('Service svc:1:'),
    );
  });

  it('repeats the JSON-only output rule', () => {
    const prompt = formatRankingPrompt(sampleDigests, 'q');
    expect(prompt).toContain('Reply with JSON ONLY');
  });
});

describe('parseMatches', () => {
  it('parses a plain JSON match list', () => {
    expect(
      parseMatches('[{"id":"svc:0","rationale":"it signs"}]'),
    ).toStrictEqual([{ id: 'svc:0', rationale: 'it signs' }]);
  });

  it('parses an empty list', () => {
    expect(parseMatches('[]')).toStrictEqual([]);
  });

  it('tolerates a markdown code fence', () => {
    expect(
      parseMatches('```json\n[{"id":"svc:1","rationale":"r"}]\n```'),
    ).toStrictEqual([{ id: 'svc:1', rationale: 'r' }]);
  });

  it.each([
    ['non-JSON prose', 'no matches found, sorry!', /not parseable JSON/u],
    ['a JSON object', '{"id":"svc:0"}', /not a JSON array/u],
    ['an array of strings', '["svc:0"]', /non-object/u],
    [
      'entries missing rationale',
      '[{"id":"svc:0"}]',
      /missing string id\/rationale/u,
    ],
  ])('throws on %s', (_case, reply, expected) => {
    expect(() => parseMatches(reply)).toThrow(expected);
  });
});
