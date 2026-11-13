import type { SubclusterId, VatId } from '@metamask/ocap-kernel';
import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { KernelControls } from './KernelControls.tsx';
import { useKernelActions } from '../hooks/useKernelActions.ts';
import { useVats } from '../hooks/useVats.ts';
import type { VatRecord } from '../types.ts';

// Mock the hooks
vi.mock('../hooks/useKernelActions.ts', () => ({
  useKernelActions: vi.fn(),
}));

vi.mock('../hooks/useVats.ts', () => ({
  useVats: vi.fn(),
}));

const mockUseKernelActions = (overrides = {}): void => {
  vi.mocked(useKernelActions).mockReturnValue({
    terminateAllVats: vi.fn(),
    clearState: vi.fn(),
    collectGarbage: vi.fn(),
    launchSubcluster: vi.fn(),
    ...overrides,
  });
};

const mockUseVats = (vats: VatRecord[] = []): void => {
  vi.mocked(useVats).mockReturnValue({
    subclusters: [],
    pingVat: vi.fn(),
    restartVat: vi.fn(),
    terminateVat: vi.fn(),
    terminateSubcluster: vi.fn(),
    hasVats: vats.length > 0,
  });
};

describe('KernelControls', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the "Collect Garbage" button', () => {
    mockUseKernelActions();
    mockUseVats();
    render(<KernelControls />);
    const garbageButton = screen.getByRole('button', {
      name: 'Collect Garbage',
    });
    expect(garbageButton).toBeInTheDocument();
  });

  it('renders the "Clear All State" button', () => {
    mockUseKernelActions();
    mockUseVats();
    render(<KernelControls />);
    const clearButton = screen.getByRole('button', {
      name: 'Clear All State',
    });
    expect(clearButton).toBeInTheDocument();
  });

  it('does not render "Terminate All Vats" button when no vats exist', () => {
    mockUseKernelActions();
    mockUseVats([]);
    render(<KernelControls />);
    expect(
      screen.queryByRole('button', { name: 'Terminate All Vats' }),
    ).not.toBeInTheDocument();
  });

  it('renders "Terminate All Vats" button when vats exist', () => {
    mockUseKernelActions();
    mockUseVats([
      {
        id: 'v1' as VatId,
        source: 'source',
        parameters: '',
        creationOptions: '',
        subclusterId: 'subcluster1' as SubclusterId,
      },
    ]);
    render(<KernelControls />);
    const terminateButton = screen.getByRole('button', {
      name: 'Terminate All Vats',
    });
    expect(terminateButton).toBeInTheDocument();
  });

  it('calls terminateAllVats when "Terminate All Vats" button is clicked', async () => {
    const terminateAllVats = vi.fn();
    mockUseKernelActions({ terminateAllVats });
    mockUseVats([
      {
        id: 'v1' as VatId,
        source: 'source',
        parameters: '',
        creationOptions: '',
        subclusterId: 'subcluster1' as SubclusterId,
      },
    ]);
    render(<KernelControls />);
    const terminateButton = screen.getByRole('button', {
      name: 'Terminate All Vats',
    });
    await userEvent.click(terminateButton);

    expect(terminateAllVats).toHaveBeenCalledTimes(1);
  });

  it('calls collectGarbage when "Collect Garbage" button is clicked', async () => {
    const collectGarbage = vi.fn();
    mockUseKernelActions({ collectGarbage });
    mockUseVats();
    render(<KernelControls />);
    const garbageButton = screen.getByRole('button', {
      name: 'Collect Garbage',
    });
    await userEvent.click(garbageButton);
    expect(collectGarbage).toHaveBeenCalledTimes(1);
  });

  it('calls clearState when "Clear All State" button is clicked', async () => {
    const clearState = vi.fn();
    mockUseKernelActions({ clearState });
    mockUseVats();
    render(<KernelControls />);
    const clearButton = screen.getByRole('button', {
      name: 'Clear All State',
    });
    await userEvent.click(clearButton);
    expect(clearState).toHaveBeenCalledTimes(1);
  });
});
