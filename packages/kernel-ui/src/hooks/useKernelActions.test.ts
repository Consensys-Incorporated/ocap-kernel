import { waitFor, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../context/PanelContext.tsx', () => ({
  usePanelContext: vi.fn(),
}));

const clusterConfig = {
  bootstrap: 'alice',
  forceReset: true,
  services: [],
  vats: {
    alice: { bundleSpec: 'sample-vat.bundle', parameters: { name: 'Alice' } },
  },
};

vi.mock('@metamask/kernel-utils', async (importOriginal) => ({
  ...(await importOriginal()),
  stringify: JSON.stringify,
}));

describe('useKernelActions', () => {
  const mockSendMessage = vi.fn();
  const mockLogMessage = vi.fn();
  const mockMessageContent = '{"id": "v0", "payload": {"method": "test"}}';

  beforeEach(async () => {
    const { usePanelContext } = await import('../context/PanelContext.tsx');
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod: mockSendMessage,
      logMessage: mockLogMessage,
      messageContent: mockMessageContent,
      setMessageContent: vi.fn(),
      status: undefined,
      panelLogs: [],
      clearLogs: vi.fn(),
      isLoading: false,
      objectRegistry: null,
      setObjectRegistry: vi.fn(),
    });
  });

  describe('terminateAllVats', () => {
    it('sends terminate all vats command', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());

      mockSendMessage.mockResolvedValueOnce({ success: true });

      result.current.terminateAllVats();
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith({
          method: 'terminateAllVats',
          params: [],
        });
      });
      expect(mockLogMessage).toHaveBeenCalledWith(
        'All vats terminated',
        'success',
      );
    });

    it('logs error on failure', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());

      mockSendMessage.mockRejectedValueOnce(new Error());

      result.current.terminateAllVats();
      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          'Failed to terminate all vats',
          'error',
        );
      });
    });
  });

  describe('collectGarbage', () => {
    it('sends collect garbage command', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());

      mockSendMessage.mockResolvedValueOnce({ success: true });

      result.current.collectGarbage();
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith({
          method: 'collectGarbage',
          params: [],
        });
      });
      expect(mockLogMessage).toHaveBeenCalledWith(
        'Garbage collected',
        'success',
      );
    });

    it('logs error on failure', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());

      mockSendMessage.mockRejectedValueOnce(new Error());

      result.current.collectGarbage();
      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          'Failed to collect garbage Error',
          'error',
        );
      });
    });
  });

  describe('clearState', () => {
    it('sends clear state command', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());

      mockSendMessage.mockResolvedValueOnce({ success: true });

      result.current.clearState();
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith({
          method: 'clearState',
          params: [],
        });
      });
      expect(mockLogMessage).toHaveBeenCalledWith('State cleared', 'success');
    });

    it('logs error on failure', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());

      mockSendMessage.mockRejectedValueOnce(new Error('test error'));

      result.current.clearState();
      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          'Failed to clear state: test error',
          'error',
        );
      });
    });
  });

  describe('launchSubcluster', () => {
    it('sends launch subcluster command with correct parameters', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());
      mockSendMessage.mockResolvedValueOnce({ success: true });
      result.current.launchSubcluster(clusterConfig);
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith({
          method: 'launchSubcluster',
          params: { config: clusterConfig },
        });
      });
      expect(mockLogMessage).toHaveBeenCalledWith(
        'Subcluster launched',
        'success',
      );
    });

    it('releases a bootstrap result the kernel holds', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());
      mockSendMessage.mockResolvedValueOnce({
        bootstrapResult: { body: '#"$0"', slots: ['ko7'], kpid: 'kp3' },
      });
      mockSendMessage.mockResolvedValueOnce(null);
      result.current.launchSubcluster(clusterConfig);
      await waitFor(() => {
        expect(mockSendMessage.mock.calls).toStrictEqual([
          [{ method: 'launchSubcluster', params: { config: clusterConfig } }],
          [{ method: 'releaseResult', params: ['kp3'] }],
        ]);
      });
    });

    it('logs error on failure', async () => {
      const { useKernelActions } = await import('./useKernelActions.ts');
      const { result } = renderHook(() => useKernelActions());
      const error = new Error('Failed to launch subcluster');
      mockSendMessage.mockRejectedValueOnce(error);
      result.current.launchSubcluster(clusterConfig);
      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          'Failed to launch subcluster: Failed to launch subcluster',
          'error',
        );
      });
    });
  });
});
