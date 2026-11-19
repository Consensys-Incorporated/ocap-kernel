import type { KRef } from '@metamask/ocap-kernel';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RemoteComms } from './RemoteComms.tsx';
import { usePanelContext } from '../context/PanelContext.tsx';
import { useRegistry } from '../hooks/useRegistry.ts';

// Mock the PanelContext
vi.mock('../context/PanelContext.tsx', () => ({
  usePanelContext: vi.fn(),
}));

// Mock the useRegistry hook
vi.mock('../hooks/useRegistry.ts', () => ({
  useRegistry: vi.fn(),
}));

const mockUsePanelContext = vi.mocked(usePanelContext);
const mockUseRegistry = vi.mocked(useRegistry);

describe('RemoteComms', () => {
  const mockFetchObjectRegistry = vi.fn();

  // Helper function to create mock panel context
  const createMockPanelContext = (overrides = {}) => ({
    status: undefined,
    callKernelMethod: vi.fn(),
    logMessage: vi.fn(),
    messageContent: '',
    setMessageContent: vi.fn(),
    panelLogs: [],
    clearLogs: vi.fn(),
    isLoading: false,
    objectRegistry: null,
    setObjectRegistry: vi.fn(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock for useRegistry
    mockUseRegistry.mockReturnValue({
      fetchObjectRegistry: mockFetchObjectRegistry,
      revoke(_kref: KRef): void {
        throw new Error('Function not implemented.');
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('should show loading state when status is not available', () => {
    mockUsePanelContext.mockReturnValue(createMockPanelContext());

    render(<RemoteComms />);

    expect(
      screen.getByText('Loading remote communications status...'),
    ).toBeInTheDocument();
  });

  it('should show warning when remoteComms is not available in status', () => {
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          // remoteComms not included
        },
      }),
    );

    render(<RemoteComms />);

    expect(screen.getByTestId('status-text')).toBeInTheDocument();
    expect(screen.getByTestId('warning-message')).toBeInTheDocument();
  });

  it('should show initialized status with peer ID when remote comms is connected', () => {
    const mockPeerId = '12D3KooWTest123456789';

    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'connected',
            peerId: mockPeerId,
          },
        },
      }),
    );

    render(<RemoteComms />);

    // Check status section
    expect(screen.getByTestId('status-text')).toBeInTheDocument();
    expect(screen.getByTestId('initialization-status')).toHaveTextContent(
      'Initialized',
    );

    // Check peer ID section
    expect(screen.getByTestId('peer-id-text')).toBeInTheDocument();
    const peerIdInput = screen.getByTestId('peer-id-display');
    expect(peerIdInput).toBeInTheDocument();
    expect(peerIdInput).toHaveValue(mockPeerId);
    expect(peerIdInput).toHaveAttribute('readonly');
  });

  it('should show not initialized status when remote comms is disconnected', () => {
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'disconnected',
          },
        },
      }),
    );

    render(<RemoteComms />);

    // Check status section
    expect(screen.getByTestId('status-text')).toBeInTheDocument();
    expect(screen.getByTestId('initialization-status')).toHaveTextContent(
      'Not Initialized',
    );

    // Peer ID section should not be visible when disconnected
    expect(screen.queryByText('Peer Identity')).not.toBeInTheDocument();
    expect(screen.queryByTestId('peer-id-display')).not.toBeInTheDocument();
  });

  it('should show identity-only status with peer ID but not initialized', () => {
    const mockPeerId = '12D3KooWTest123456789';

    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'identity-only',
            peerId: mockPeerId,
          },
        },
      }),
    );

    render(<RemoteComms />);

    // Status should show not initialized
    expect(screen.getByTestId('status-text')).toBeInTheDocument();
    expect(screen.getByTestId('initialization-status')).toHaveTextContent(
      'Not Initialized',
    );

    // But peer ID section should be visible
    expect(screen.getByTestId('peer-id-text')).toBeInTheDocument();
    const peerIdInput = screen.getByTestId('peer-id-display');
    expect(peerIdInput).toBeInTheDocument();
    expect(peerIdInput).toHaveValue(mockPeerId);
  });

  it('should apply correct CSS classes to the container', () => {
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'connected',
            peerId: 'test-peer-id',
          },
        },
      }),
    );

    render(<RemoteComms />);

    // Check that the main container has the expected classes
    const container = screen.getByTestId('status-text').closest('.bg-section');
    expect(container).toHaveClass('bg-section', 'p-4', 'rounded', 'mb-4');
  });

  it('should render BadgeStatus component with correct status', () => {
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'connected',
            peerId: 'test-peer-id',
          },
        },
      }),
    );

    render(<RemoteComms />);

    // The BadgeStatus component should be rendered
    // We can't easily test the internal state, but we can verify the status text
    expect(screen.getByTestId('initialization-status')).toHaveTextContent(
      'Initialized',
    );
  });

  it('should handle empty peer ID gracefully', () => {
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'connected',
            peerId: '',
          },
        },
      }),
    );

    render(<RemoteComms />);

    // Status should be shown
    expect(screen.getByTestId('initialization-status')).toHaveTextContent(
      'Initialized',
    );

    // But peer ID section should not be visible for empty string
    expect(screen.queryByTestId('peer-id-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('peer-id-display')).not.toBeInTheDocument();
  });

  it('asks the kernel for a URL for each object that has one issued', async () => {
    const callKernelMethod = vi.fn(
      async ({ params }: { params: { kref: string } }) =>
        `ocap:${params.kref}@peer`,
    );
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        callKernelMethod,
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'connected',
            peerId: 'test-peer-id',
          },
        },
        objectRegistry: {
          gcActions: '[]',
          reapQueue: '[]',
          terminatedVats: '[]',
          vats: {},
          ocapUrls: [
            { kref: 'ko1', owner: 'v1' },
            { kref: 'ko2', owner: null },
          ],
        },
      }),
    );

    render(<RemoteComms />);

    expect(screen.getByTestId('exported-urls-text')).toBeInTheDocument();
    const url1Input = await screen.findByTestId('ocap-url-ko1');
    expect(url1Input).toHaveValue('ocap:ko1@peer');
    expect(url1Input).toHaveAttribute('readonly');
    expect(await screen.findByTestId('ocap-url-ko2')).toHaveValue(
      'ocap:ko2@peer',
    );
    expect(callKernelMethod.mock.calls).toStrictEqual([
      [{ method: 'getIssuedOcapURL', params: { kref: 'ko1' } }],
      [{ method: 'getIssuedOcapURL', params: { kref: 'ko2' } }],
    ]);
    expect(screen.getByText('Owner v1')).toBeInTheDocument();
    expect(screen.getByText('Owner none')).toBeInTheDocument();
    expect(screen.getByText('(ko1)')).toBeInTheDocument();
    expect(screen.getByText('(ko2)')).toBeInTheDocument();
  });

  it('shows no URL field for an object the kernel gives no URL for', async () => {
    const logMessage = vi.fn();
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        callKernelMethod: vi.fn().mockRejectedValue(new Error('no identity')),
        logMessage,
        status: {
          vats: [],
          subclusters: [],
          remoteComms: { state: 'disconnected' },
        },
        objectRegistry: {
          gcActions: '[]',
          reapQueue: '[]',
          terminatedVats: '[]',
          vats: {},
          ocapUrls: [{ kref: 'ko1', owner: 'v1' }],
        },
      }),
    );

    render(<RemoteComms />);

    await vi.waitFor(() =>
      expect(logMessage.mock.calls).toStrictEqual([
        ['Failed to get an ocap URL for ko1: no identity', 'error'],
      ]),
    );
    expect(screen.queryByTestId('ocap-url-ko1')).not.toBeInTheDocument();
  });

  it('should not display exported ocap URLs section when empty', () => {
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'connected',
            peerId: 'test-peer-id',
          },
        },
        objectRegistry: {
          gcActions: '[]',
          reapQueue: '[]',
          terminatedVats: '[]',
          vats: {},
          ocapUrls: [],
        },
      }),
    );

    render(<RemoteComms />);

    // Check that the exported URLs section is NOT visible
    expect(screen.queryByTestId('exported-urls-text')).not.toBeInTheDocument();
  });

  it('should fetch object registry on mount when not available', () => {
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'connected',
            peerId: 'test-peer-id',
          },
        },
      }),
    );

    render(<RemoteComms />);

    // Check that fetchObjectRegistry was called
    expect(mockFetchObjectRegistry).toHaveBeenCalledTimes(1);
  });

  it('should not fetch object registry on mount when already available', () => {
    mockUsePanelContext.mockReturnValue(
      createMockPanelContext({
        status: {
          vats: [],
          subclusters: [],
          remoteComms: {
            state: 'connected',
            peerId: 'test-peer-id',
          },
        },
        objectRegistry: {
          gcActions: '[]',
          reapQueue: '[]',
          terminatedVats: '[]',
          vats: {},
          ocapUrls: [],
        },
      }),
    );

    render(<RemoteComms />);

    // Check that fetchObjectRegistry was NOT called
    expect(mockFetchObjectRegistry).not.toHaveBeenCalled();
  });
});
