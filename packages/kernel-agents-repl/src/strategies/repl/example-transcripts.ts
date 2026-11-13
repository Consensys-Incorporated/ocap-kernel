import { extractCapabilitySchemas } from '@ocap/kernel-agents/capabilities/capability';
import { end } from '@ocap/kernel-agents/capabilities/end';
import { search } from '@ocap/kernel-agents/capabilities/examples';
import type { CapabilityRecord } from '@ocap/kernel-agents/types';

import type { ReplTranscript } from './messages.ts';
import {
  CommentMessage,
  EvaluationMessage,
  ImportMessage,
  InterjectionMessage,
  ResultMessage,
} from './messages.ts';
import { RETURN } from './symbols.ts';

// oxlint-disable-next-line typescript/explicit-function-return-type
const transcribeCapabilities = (capabilities: CapabilityRecord) => [
  ImportMessage.fromNames(Object.keys(capabilities)),
  new ResultMessage(
    { value: extractCapabilitySchemas(capabilities) },
    { compress: false },
  ),
];

const treeSearchTask: ReplTranscript = [
  ...transcribeCapabilities({ end, search }),
  new InterjectionMessage('What is the oldest tree in South America?'),
  new CommentMessage(
    '// This information is too specific for me to know on my own.',
  ),
  new EvaluationMessage(
    `await search({ query: 'oldest tree in South America' });`,
  ),
  new ResultMessage({
    [RETURN]: [
      {
        source:
          'https://unofficialnetworks.com/2022/06/02/worlds-oldest-tree-south-america/',
        published: '2022-06-02',
        snippet:
          'Barichivich turned to statistical modeling to determine the Alerce Milenario’s full age. He used complete cores from other alerce trees and information on how environmental factors and random variation affect tree growth to calibrate a model that simulated a range of possible ages the tree had reached by the beginning of the period covered by the partial core, along with a probability for each age. The method yielded an overall age estimate of 5484 years old, with an 80% chance that the tree has lived for more than 5000 years.',
      },
      {
        source:
          'https://economictimes.indiatimes.com/news/new-updates/worlds-oldest-tree-great-grandfather-tree-in-chile-to-reveal-the-planets-secrets/articleshow/99690454.cms',
        published: '2023-04-22',
        snippet:
          'The 5,000-year-old Great Grandfather tree will replace the current oldest tree, the Methuselah, which is 4,850 years old. While Methuselah is located in California, United States of America, the Great Grandfather tree is in Santiago, Chile, South America.\n\nThe Great Grandfather tree is a form of cypress, also known as the Fitzroya Cupressoides or the Patagonian cypress, while the Methuselah is a pine. The Patagonian cypress tree is the largest one found in South America.',
      },
      {
        source: 'https://forestry.com/guides/top-10-oldest-trees-in-the-world/',
        published: '2025-07-14',
        snippet:
          'Top 10 Oldest Living Trees in the World\n\nRank	Name	Species	Location	Age (Years)\n1	Methuselah	Great Basin bristlecone pine	White Mountains, California, USA	4,856 (Verified)\n2	Alerce Milenario (Gran Abuelo)	Patagonian cypress	Alerce Costero National Park, Chile	3,654 (Verified, up to 5,484 debated)\n3	Sarv-e Abarqu	Cypress	Yazd Province, Iran	Approximately 4,000+ (Estimated)\n4	Llangernyw Yew	Yew	Llangernyw Village, Wales, UK	Approximately 4,000 (Estimated)\n5	Olive Tree of Vouves	Olive	Crete, Greece	Approximately 3,000+ (Estimated)\n6	BLK227	Bald cypress	Black River, North Carolina, USA	2,650 (Verified)\n7	Jōmon Sugi	Cryptomeria	Yakushima, Japan	2,000–3,000+ (Estimated)\n8	Chestnut Tree of One Hundred Horses	Chestnut	Mount Etna, Sicily, Italy	2,000–4,000 (Estimated)\n9	General Sherman	Giant sequoia	Sequoia National Park, California, USA	Approximately 2,500 (Estimated)\n10	Patriarca da Floresta	Cariniana legalis	Brazil	Approximately 2,000+ (Estimated)',
      },
    ],
  }),
  new EvaluationMessage(
    'await end({ final: "According to multiple sources, the oldest tree in South America is Alerce Milenario." });',
  ),
];

const simpleSemanticTask: ReplTranscript = [
  ...transcribeCapabilities({ end }),
  new InterjectionMessage('What color is a banana?'),
  ...[
    'Bananas can be either yellow or green, depending on the variety and ripeness.',
    'Typically, people think of yellow bananas when they think of bananas.',
    'I should give the typical response, but clarify that I am assuming the banana is ripe.',
  ].map((comment) => new CommentMessage(`// ${comment}`)),
  new EvaluationMessage('const response = "A banana is yellow when ripe.";'),
  new ResultMessage({ value: { response: 'A banana is yellow when ripe.' } }),
  new EvaluationMessage('await end({ final: response });'),
];

const multiStepCalculation: ReplTranscript = [
  ...transcribeCapabilities({ end }),
  new InterjectionMessage(
    'What is the size of a matrix with rows indexed by the letters of "piano" and columns by the letters of "guitar"?',
  ),
  new CommentMessage(
    '// The answer will be the product of the length of the word "piano" and the length of the word "guitar".',
  ),
  new EvaluationMessage(
    // oxlint-disable-next-line no-template-curly-in-string
    'const response = `Such a matrix would have ${"piano".length * "guitar".length} elements.`;',
  ),
  new ResultMessage({
    value: { response: 'Such a matrix would have 30 elements.' },
  }),
  new EvaluationMessage('await end({ final: response });'),
];

const functionDefinition: ReplTranscript = [
  ...transcribeCapabilities({ end }),
  new InterjectionMessage(
    'What is the average depth of the following tree? [a, [b, c], d, [e, [f, g]]]',
  ),
  new CommentMessage(
    '// I can solve this problem by recursively finding the depth of each node in the tree.',
  ),
  new CommentMessage(
    '// First, let me define a function to check if a node is a leaf.',
  ),
  new EvaluationMessage('const isLeaf = (node) => node.length === undefined;'),
  new ResultMessage({ value: { isLeaf: '[Function isLeaf]' } }),
  new CommentMessage(
    '// Next, let me define a tree walking function to calculate the total depth and node count.',
  ),
  new CommentMessage(
    '// I should initialize the total depth and node count before walking the tree.',
  ),
  new EvaluationMessage('let [totalDepth, nodeCount] = [0, 0];'),
  new ResultMessage({ value: { totalDepth: 0, nodeCount: 0 } }),
  new EvaluationMessage(
    [
      'function walk(node, depth = 0) {',
      '  if (isLeaf(node)) {',
      '    totalDepth += depth;',
      '    nodeCount += 1;',
      '    return;',
      '  }',
      '  node.forEach(child => { walk(child, depth + 1); });',
      '}',
    ].join('\n'),
  ),
  new ResultMessage({ value: { walk: '[Function walk]' } }),
  new EvaluationMessage('walk(["a", ["b", "c"], "d", ["e", ["f", "g"]]]);'),
  new EvaluationMessage('const averageDepth = totalDepth / nodeCount;'),
  new ResultMessage({ value: { averageDepth: 2 } }),
  new EvaluationMessage('await end({ final: String(averageDepth) });'),
];

export const exampleTranscripts = [
  simpleSemanticTask,
  multiStepCalculation,
  treeSearchTask,
  functionDefinition,
] as const;
