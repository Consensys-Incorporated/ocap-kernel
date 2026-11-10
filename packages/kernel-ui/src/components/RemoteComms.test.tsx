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

  it('should display exported ocap URLs when available', () => {
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
          ocapUrls: [
            {
              vatId: 'v1',
              promiseId: 'kp1',
              ocapUrl: 'ocap://example.com/capability1',
            },
            {
              vatId: 'v2',
              promiseId: 'kp2',
              ocapUrl: 'ocap://example.com/capability2',
            },
          ],
        },
      }),
    );

    render(<RemoteComms />);

    // Check that the exported URLs section is visible
    expect(screen.getByTestId('exported-urls-text')).toBeInTheDocument();

    // Check that both URLs are displayed
    const url1Input = screen.getByTestId('ocap-url-kp1');
    expect(url1Input).toBeInTheDocument();
    expect(url1Input).toHaveValue('ocap://example.com/capability1');
    expect(url1Input).toHaveAttribute('readonly');

    const url2Input = screen.getByTestId('ocap-url-kp2');
    expect(url2Input).toBeInTheDocument();
    expect(url2Input).toHaveValue('ocap://example.com/capability2');
    expect(url2Input).toHaveAttribute('readonly');

    // Check vat IDs are displayed
    expect(screen.getByText('Vat v1')).toBeInTheDocument();
    expect(screen.getByText('Vat v2')).toBeInTheDocument();

    // Check promise IDs are displayed
    expect(screen.getByText('(kp1)')).toBeInTheDocument();
    expect(screen.getByText('(kp2)')).toBeInTheDocument();
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
