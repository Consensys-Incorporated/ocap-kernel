import type { SubclusterId, VatConfig, VatId } from '@metamask/ocap-kernel';
import { setupOcapKernelMock } from '@ocap/repo-tools/test-utils';
import { waitFor, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PanelContextType } from '../context/PanelContext.tsx';

vi.mock('../context/PanelContext.tsx', () => ({
  usePanelContext: vi.fn(),
}));

setupOcapKernelMock();

vi.mock('@metamask/kernel-utils', async (importOriginal) => ({
  ...(await importOriginal()),
  stringify: JSON.stringify,
}));

describe('useVats', () => {
  const mockSendMessage = vi.fn();
  const mockLogMessage = vi.fn();
  const mockSetSelectedVatId = vi.fn();
  const mockVatId = 'vat1' as VatId;
  const mockSubclusterId = 'subcluster1' as SubclusterId;

  const mockStatus = {
    vats: [
      {
        id: mockVatId,
        subclusterId: mockSubclusterId,
        config: {
          bundleSpec: 'test-bundle',
          parameters: { foo: 'bar' },
          creationOptions: { test: true },
        },
      },
    ],
    subclusters: [
      {
        id: mockSubclusterId,
        name: 'Test Subcluster',
        config: {
          bundleSpec: 'test-bundle',
          parameters: { foo: 'bar' },
        },
      },
    ],
  };

  beforeEach(async () => {
    const { usePanelContext } = await import('../context/PanelContext.tsx');
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod: mockSendMessage,
      status: mockStatus,
      selectedVatId: mockVatId,
      setSelectedVatId: mockSetSelectedVatId,
      logMessage: mockLogMessage,
    } as unknown as PanelContextType);
  });

  it('should return empty array when status is not available', async () => {
    const { usePanelContext } = await import('../context/PanelContext.tsx');
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod: mockSendMessage,
      status: null,
      selectedVatId: mockVatId,
      setSelectedVatId: mockSetSelectedVatId,
      logMessage: mockLogMessage,
    } as unknown as PanelContextType);

    const { useVats } = await import('./useVats.ts');
    const { result } = renderHook(() => useVats());

    expect(result.current.subclusters).toStrictEqual([]);
    expect(result.current.hasVats).toBe(false);
  });

  it('should return vats data from status', async () => {
    const { useVats } = await import('./useVats.ts');
    const { result } = renderHook(() => useVats());

    expect(result.current.subclusters).toStrictEqual([
      {
        id: mockSubclusterId,
        name: 'Test Subcluster',
        config: {
          bundleSpec: 'test-bundle',
          parameters: { foo: 'bar' },
        },
        vatRecords: [
          {
            id: mockVatId,
            source: 'test-bundle',
            parameters: '{"foo":"bar"}',
            creationOptions: '{"test":true}',
            subclusterId: mockSubclusterId,
          },
        ],
      },
    ]);
  });

  it('should handle subclusters without associated vats', async () => {
    const { usePanelContext } = await import('../context/PanelContext.tsx');
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod: mockSendMessage,
      status: {
        vats: [
          {
            id: mockVatId,
            subclusterId: 'different-subcluster',
            config: {
              bundleSpec: 'test-bundle',
              parameters: { foo: 'bar' },
              creationOptions: { test: true },
            },
          },
        ],
        subclusters: [
          {
            id: mockSubclusterId,
            name: 'Test Subcluster',
            config: {
              bundleSpec: 'test-bundle',
              parameters: { foo: 'bar' },
            },
          },
        ],
      },
      selectedVatId: mockVatId,
      setSelectedVatId: mockSetSelectedVatId,
      logMessage: mockLogMessage,
    } as unknown as PanelContextType);

    const { useVats } = await import('./useVats.ts');
    const { result } = renderHook(() => useVats());

    expect(result.current.subclusters).toStrictEqual([
      {
        id: mockSubclusterId,
        name: 'Test Subcluster',
        config: {
          bundleSpec: 'test-bundle',
          parameters: { foo: 'bar' },
        },
        vatRecords: [],
      },
    ]);
  });

  it('should handle missing vat config gracefully', async () => {
    const { usePanelContext } = await import('../context/PanelContext.tsx');
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod: mockSendMessage,
      status: {
        vats: [{ id: mockVatId, config: {} as VatConfig }],
        subclusters: [],
      },
      selectedVatId: mockVatId,
      setSelectedVatId: mockSetSelectedVatId,
      logMessage: mockLogMessage,
    } as unknown as PanelContextType);

    const { useVats } = await import('./useVats.ts');
    const { result } = renderHook(() => useVats());

    expect(result.current.subclusters).toStrictEqual([]);
  });

  it('should use sourceSpec when bundleSpec is not available', async () => {
    const { usePanelContext } = await import('../context/PanelContext.tsx');
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod: mockSendMessage,
      status: {
        vats: [
          {
            id: mockVatId,
            config: {
              sourceSpec: 'test-source',
              parameters: { foo: 'bar' },
            },
          },
        ],
        subclusters: [],
      },
      selectedVatId: mockVatId,
      setSelectedVatId: mockSetSelectedVatId,
      logMessage: mockLogMessage,
    } as unknown as PanelContextType);

    const { useVats } = await import('./useVats.ts');
    const { result } = renderHook(() => useVats());

    expect(result.current.subclusters).toStrictEqual([]);
  });

  it('should use bundleName when bundleSpec and sourceSpec are not available', async () => {
    const { usePanelContext } = await import('../context/PanelContext.tsx');
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod: mockSendMessage,
      status: {
        vats: [
          {
            id: mockVatId,
            config: {
              bundleName: 'test-bundle',
              parameters: { foo: 'bar' },
            },
          },
        ],
        subclusters: [],
      },
      selectedVatId: mockVatId,
      setSelectedVatId: mockSetSelectedVatId,
      logMessage: mockLogMessage,
    } as unknown as PanelContextType);

    const { useVats } = await import('./useVats.ts');
    const { result } = renderHook(() => useVats());

    expect(result.current.subclusters).toStrictEqual([]);
  });

  describe('pingVat', () => {
    it('should send ping message and log success', async () => {
      const { useVats } = await import('./useVats.ts');
      const { result } = renderHook(() => useVats());

      mockSendMessage.mockResolvedValueOnce({ success: true });

      result.current.pingVat(mockVatId);
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith({
          method: 'pingVat',
          params: { id: mockVatId },
        });
      });
      expect(mockLogMessage).toHaveBeenCalledWith(
        '{"success":true}',
        'success',
      );
    });

    it('should handle ping error', async () => {
      const { useVats } = await import('./useVats.ts');
      const { result } = renderHook(() => useVats());

      const error = new Error('Ping failed');
      mockSendMessage.mockRejectedValueOnce(error);

      result.current.pingVat(mockVatId);
      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith('Ping failed', 'error');
      });
    });
  });

  describe('restartVat', () => {
    it('should send restart message and log success', async () => {
      const { useVats } = await import('./useVats.ts');
      const { result } = renderHook(() => useVats());

      mockSendMessage.mockResolvedValueOnce({ success: true });

      result.current.restartVat(mockVatId);
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith({
          method: 'restartVat',
          params: { id: mockVatId },
        });
      });
      expect(mockLogMessage).toHaveBeenCalledWith(
        `Restarted vat "${mockVatId}"`,
        'success',
      );
    });

    it('should handle restart error', async () => {
      const { useVats } = await import('./useVats.ts');
      const { result } = renderHook(() => useVats());

      mockSendMessage.mockRejectedValueOnce(new Error());

      result.current.restartVat(mockVatId);
      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          `Failed to restart vat "${mockVatId}"`,
          'error',
        );
      });
    });
  });

  describe('terminateVat', () => {
    it('should send terminate message and log success', async () => {
      const { useVats } = await import('./useVats.ts');
      const { result } = renderHook(() => useVats());

      mockSendMessage.mockResolvedValueOnce({ success: true });

      result.current.terminateVat(mockVatId);
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith({
          method: 'terminateVat',
          params: { id: mockVatId },
        });
      });
      expect(mockLogMessage).toHaveBeenCalledWith(
        `Terminated vat "${mockVatId}"`,
        'success',
      );
    });

    it('should handle terminate error', async () => {
      const { useVats } = await import('./useVats.ts');
      const { result } = renderHook(() => useVats());

      mockSendMessage.mockRejectedValueOnce(new Error());

      result.current.terminateVat(mockVatId);
      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          `Failed to terminate vat "${mockVatId}"`,
          'error',
        );
      });
    });
  });

  describe('terminateSubcluster', () => {
    it('should send terminate subcluster message and log success', async () => {
      const { useVats } = await import('./useVats.ts');
      const { result } = renderHook(() => useVats());

      mockSendMessage.mockResolvedValueOnce({ success: true });

      result.current.terminateSubcluster(mockSubclusterId);
      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith({
          method: 'terminateSubcluster',
          params: { id: mockSubclusterId },
        });
      });
      expect(mockLogMessage).toHaveBeenCalledWith(
        `Terminated subcluster "${mockSubclusterId}"`,
        'success',
      );
    });

    it('should handle terminate subcluster error', async () => {
      const { useVats } = await import('./useVats.ts');
      const { result } = renderHook(() => useVats());

      mockSendMessage.mockRejectedValueOnce(new Error());

      result.current.terminateSubcluster(mockSubclusterId);
      await waitFor(() => {
        expect(mockLogMessage).toHaveBeenCalledWith(
          `Failed to terminate subcluster "${mockSubclusterId}"`,
          'error',
        );
      });
    });
  });
});
