import type { SubclusterId, VatId } from '@metamask/ocap-kernel';
import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SubclustersTable } from './SubclustersTable.tsx';
import { useVats } from '../hooks/useVats.ts';
import type { Subclusters } from '../hooks/useVats.ts';
import type { VatRecord } from '../types.ts';

// Mock the useVats hook
vi.mock('../hooks/useVats.ts', () => ({
  useVats: vi.fn(),
}));

describe('SubclustersTable Component', () => {
  const mockVats: VatRecord[] = [
    {
      id: 'vat-1' as VatId,
      subclusterId: 'subcluster-1' as SubclusterId,
      source: 'source-1',
      parameters: 'params-1',
      creationOptions: '',
    },
    {
      id: 'vat-2' as VatId,
      subclusterId: 'subcluster-1' as SubclusterId,
      source: 'source-2',
      parameters: 'params-2',
      creationOptions: '',
    },
  ];

  const mockVatConfig = {
    'vat-1': {
      bundleSpec: 'source-1',
      parameters: { foo: 'bar' },
    },
    'vat-2': {
      bundleSpec: 'source-2',
      parameters: { baz: 'qux' },
    },
  };

  const mockSubclusters: Subclusters = [
    {
      id: 'subcluster-1' as SubclusterId,
      vats: { 'vat-1': 'vat-1' as VatId, 'vat-2': 'vat-2' as VatId },
      config: {
        bootstrap: 'bootstrap-1',
        vats: mockVatConfig,
      },
      vatRecords: mockVats,
    },
  ];

  const mockActions = {
    pingVat: vi.fn(),
    restartVat: vi.fn(),
    terminateVat: vi.fn(),
    terminateSubcluster: vi.fn(),
  };

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders message when no subclusters are present', () => {
    vi.mocked(useVats).mockReturnValue({
      subclusters: [],
      ...mockActions,
      hasVats: false,
    });
    render(<SubclustersTable />);
    expect(
      screen.getByText('No subclusters are currently active.'),
    ).toBeInTheDocument();
  });

  it('renders subcluster accordion with correct title and vat count', () => {
    vi.mocked(useVats).mockReturnValue({
      subclusters: mockSubclusters,
      ...mockActions,
      hasVats: true,
    });
    render(<SubclustersTable />);
    expect(screen.getByText('Subcluster subcluster-1 -')).toBeInTheDocument();
    expect(screen.getByText('2 Vats')).toBeInTheDocument();
  });

  it('expands and collapses subcluster accordion on click', async () => {
    vi.mocked(useVats).mockReturnValue({
      subclusters: mockSubclusters,
      ...mockActions,
      hasVats: true,
    });
    render(<SubclustersTable />);

    // Initially collapsed
    expect(screen.queryByTestId('vat-table')).not.toBeInTheDocument();

    // Expand
    await userEvent.click(screen.getByText('Subcluster subcluster-1 -'));
    expect(screen.getByTestId('vat-table')).toBeInTheDocument();

    // Collapse
    await userEvent.click(screen.getByText('Subcluster subcluster-1 -'));
    expect(screen.queryByTestId('vat-table')).not.toBeInTheDocument();
  });

  it('renders correct vat data in table rows when expanded', async () => {
    vi.mocked(useVats).mockReturnValue({
      subclusters: mockSubclusters,
      ...mockActions,
      hasVats: true,
    });
    render(<SubclustersTable />);
    await userEvent.click(screen.getByText('Subcluster subcluster-1 -'));

    // The vat data is rendered by the mocked VatTable component
    mockVats.forEach((vat) => {
      expect(screen.getByText(vat.id)).toBeInTheDocument();
    });
  });

  it('renders vat table when subcluster is expanded', async () => {
    vi.mocked(useVats).mockReturnValue({
      subclusters: mockSubclusters,
      ...mockActions,
      hasVats: true,
    });
    render(<SubclustersTable />);
    await userEvent.click(screen.getByText('Subcluster subcluster-1 -'));

    // Verify that the vat table is rendered
    expect(screen.getByTestId('vat-table')).toBeInTheDocument();

    // Verify that the vat buttons are present (from the mocked VatTable)
    expect(screen.getAllByRole('button', { name: 'Ping' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Restart' })).toHaveLength(2);

    // There are 2 vat terminate buttons + 1 subcluster terminate button = 3 total
    expect(screen.getAllByRole('button', { name: 'Terminate' })).toHaveLength(
      3,
    );
  });

  it('opens config modal when View Config button is clicked', async () => {
    vi.mocked(useVats).mockReturnValue({
      subclusters: mockSubclusters,
      ...mockActions,
      hasVats: true,
    });
    render(<SubclustersTable />);
    await userEvent.click(screen.getByText('Subcluster subcluster-1 -'));

    // Initially modal should not be visible
    expect(
      screen.queryByText('Subcluster subcluster-1 Configuration'),
    ).not.toBeInTheDocument();

    // Click View Config button
    await userEvent.click(screen.getByTestId('view-config-button'));

    // Modal should now be visible
    expect(
      screen.getByText('Subcluster subcluster-1 Configuration'),
    ).toBeInTheDocument();

    // Check that the config is displayed in the textarea
    const textarea = screen.getByTestId('config-textarea');
    expect(textarea).toBeInTheDocument();
    expect((textarea as HTMLTextAreaElement).value).toContain('bootstrap');
  });
});
