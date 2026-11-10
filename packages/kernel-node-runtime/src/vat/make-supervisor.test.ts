import '@ocap/repo-tools/test-utils/mock-endoify';
import type { VatId } from '@metamask/ocap-kernel';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@metamask/logger', () => ({
  makeStreamTransport: vi.fn(() => ({ id: 'transport' })),
  Logger: vi.fn(function () {
    return { debug: vi.fn() };
  }),
}));

vi.mock('@metamask/ocap-kernel', () => ({
  VatSupervisor: vi.fn(function () {
    return { id: 'test-vat-id' };
  }),
}));

vi.mock('./streams.ts', () => ({
  makeStreams: vi.fn(async () => ({
    kernelStream: { id: 'kernel' },
    loggerStream: { id: 'logger' },
  })),
}));

vi.mock('./fetch-blob.ts', () => ({
  fetchBlob: vi.fn(),
}));

describe('makeNodeJsVatSupervisor', () => {
  it('returns an object with logger and supervisor properties', async () => {
    const { makeNodeJsVatSupervisor } = await import('./make-supervisor.ts');
    const result = await makeNodeJsVatSupervisor('v1' as VatId, 'test-log');
    expect(result).toHaveProperty('logger');
    expect(result).toHaveProperty('supervisor');
  });
});
