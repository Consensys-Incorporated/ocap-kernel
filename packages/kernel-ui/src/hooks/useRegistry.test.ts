import type { KRef } from '@metamask/ocap-kernel';
import { waitFor, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useRegistry } from './useRegistry.ts';
import { usePanelContext } from '../context/PanelContext.tsx';
import { parseObjectRegistry } from '../services/db-parser.ts';

vi.mock('../context/PanelContext.tsx', () => ({
  usePanelContext: vi.fn(),
}));

vi.mock('@metamask/kernel-utils', () => ({
  stringify: JSON.stringify,
}));

vi.mock('../services/db-parser.ts', () => ({
  parseObjectRegistry: vi.fn(),
}));

vi.mock('./useKernelActions.ts', () => ({
  useKernelActions: vi.fn(),
}));

describe('useRegistry', () => {
  const mockCallKernelMethod = vi.fn();
  const mockLogMessage = vi.fn();
  const mockSetObjectRegistry = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod: mockCallKernelMethod,
      logMessage: mockLogMessage,
      setObjectRegistry: mockSetObjectRegistry,
    } as unknown as ReturnType<typeof usePanelContext>);
  });

  describe('hook interface', () => {
    it('should return the expected methods', () => {
      const { result } = renderHook(() => useRegistry());
      expect(result.current).toStrictEqual({
        fetchObjectRegistry: expect.any(Function),
        revoke: expect.any(Function),
      });
    });
  });

  describe('fetchObjectRegistry', () => {
    it('should query the kv table and parse the result', async () => {
      const { result } = renderHook(() => useRegistry());
      const mockKvData = [
        { key: 'obj1', value: '{"id":"obj1","type":"test"}' },
        { key: 'obj2', value: '{"id":"obj2","type":"test"}' },
      ];
      const mockParsedData = {
        gcActions: '',
        reapQueue: '',
        terminatedVats: '',
        vats: {},
        ocapUrls: [],
      };

      mockCallKernelMethod.mockResolvedValueOnce(mockKvData);
      vi.mocked(parseObjectRegistry).mockReturnValueOnce(mockParsedData);

      result.current.fetchObjectRegistry();

      await waitFor(() => {
        expect(mockCallKernelMethod).toHaveBeenCalledWith({
          method: 'executeDBQuery',
          params: { sql: 'SELECT key, value FROM kv' },
        });
        expect(parseObjectRegistry).toHaveBeenCalledWith(mockKvData);
        expect(mockSetObjectRegistry).toHaveBeenCalledWith(mockParsedData);
      });
    });

    it('should log errors when fetching object registry fails', async () => {
      const { result } = renderHook(() => useRegistry());
      const errorResponse = { error: 'Table not found' };
      mockCallKernelMethod.mockResolvedValueOnce(errorResponse);

      result.current.fetchObjectRegistry();

      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          'Failed to fetch object registry: "Table not found"',
          'error',
        );
      });
    });

    it('should handle promise rejection when fetching object registry', async () => {
      const { result } = renderHook(() => useRegistry());
      const error = new Error('Query failed');
      mockCallKernelMethod.mockRejectedValueOnce(error);

      result.current.fetchObjectRegistry();

      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          'Failed to fetch object registry: Query failed',
          'error',
        );
      });
    });
  });

  describe('revoke', () => {
    it('sends revoke command with correct parameters', async () => {
      const { result } = renderHook(() => useRegistry());
      mockCallKernelMethod.mockResolvedValueOnce({ success: true });
      result.current.revoke('test' as KRef);
      await waitFor(() => {
        expect(mockCallKernelMethod).toHaveBeenCalledWith({
          method: 'revoke',
          params: { kref: 'test' },
        });
      });
    });

    it('should log errors when revoke fails', async () => {
      const { result } = renderHook(() => useRegistry());
      const error = new Error('Revoke failed');
      mockCallKernelMethod.mockRejectedValueOnce(error);

      result.current.revoke('test-kref' as KRef);

      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          'Failed to revoke object test-kref: Revoke failed',
          'error',
        );
      });
    });
  });
});
