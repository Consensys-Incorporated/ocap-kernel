import { describe, expect, it } from 'vitest';

import { assertSupportedPlatform } from './platform.ts';

describe('assertSupportedPlatform', () => {
  it('throws on Windows', () => {
    expect(() => assertSupportedPlatform('win32')).toThrow(
      'The ocap kernel does not support Windows.',
    );
  });

  it.each(['darwin', 'linux'] as const)('accepts %s', (platform) => {
    expect(() => assertSupportedPlatform(platform)).not.toThrow();
  });
});
