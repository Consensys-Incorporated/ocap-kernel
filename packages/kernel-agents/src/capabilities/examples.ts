import { S } from '@metamask/kernel-utils';

import { makeInternalCapabilities } from './discover.ts';

type SearchResult = {
  source: string;
  published: string;
  snippet: string;
};

const moonPhases = [
  'new moon',
  'waxing crescent',
  'first quarter',
  'waxing gibbous',
  'full moon',
  'waning gibbous',
  'third quarter',
  'waning crescent',
] as const;
type MoonPhase = (typeof moonPhases)[number];

// A vat has no clock or entropy, so successive calls cycle through the phases.
let moonPhaseIndex = 0;

const capabilities = makeInternalCapabilities(
  'Examples',
  {
    async search(query: string): Promise<SearchResult[]> {
      return [
        {
          source: 'https://www.google.com',
          published: '2025-01-01',
          snippet: `No information found for ${query}`,
        },
      ];
    },
    async getMoonPhase(): Promise<MoonPhase> {
      const phase = moonPhases[moonPhaseIndex % moonPhases.length] as MoonPhase;
      moonPhaseIndex += 1;
      return phase;
    },
  },
  S.interface('Examples', {
    search: S.method(
      'Search the web for information.',
      [S.arg('query', S.string('The query to search for'))],
      S.arrayOf(
        S.object({
          source: S.string('The source of the information.'),
          published: S.string('The date the information was published.'),
          snippet: S.string('The snippet of information.'),
        }),
      ),
    ),
    // TODO: Add enum support to the capability schema so the moon phases can be
    // advertised as the allowed return values.
    getMoonPhase: S.method(
      'Get the current phase of the moon.',
      [],
      S.string('The current phase of the moon.'),
    ),
  }),
);

export const { search, getMoonPhase } = capabilities;
export const exampleCapabilities = capabilities;
