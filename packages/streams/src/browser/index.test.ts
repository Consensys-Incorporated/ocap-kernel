import { describe, it, expect } from 'vitest';

import * as indexModule from './index.ts';

describe('index', () => {
  it('has the expected exports', () => {
    expect(Object.keys(indexModule).sort()).toStrictEqual([
      'ChromeRuntimeDuplexStream',
      'MessagePortDuplexStream',
      'PostMessageDuplexStream',
      'initializeMessageChannel',
      'receiveMessagePort',
      'split',
    ]);
  });
});
