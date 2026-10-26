import type { MethodSchema } from '@metamask/kernel-utils';

const harden = globalThis.harden ?? (<T>(value: T): T => value);

export const METHOD_CATALOG = harden({
  transferNative: {
    description: 'Transfer native ETH to a recipient.',
    args: {
      to: { type: 'string', description: 'Recipient address.' },
      amount: {
        type: 'string',
        description: 'Amount in wei (bigint as string).',
      },
    },
    returns: { type: 'string', description: 'Transaction hash.' },
  },
  transferFungible: {
    description: 'Transfer ERC-20 tokens to a recipient.',
    args: {
      token: { type: 'string', description: 'Token contract address.' },
      to: { type: 'string', description: 'Recipient address.' },
      amount: {
        type: 'string',
        description: 'Amount in token units (bigint as string).',
      },
    },
    returns: { type: 'string', description: 'Transaction hash.' },
  },
} satisfies Record<string, MethodSchema>);

export type CatalogMethodName = keyof typeof METHOD_CATALOG;
