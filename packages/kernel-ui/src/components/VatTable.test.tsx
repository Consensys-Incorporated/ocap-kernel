import type { SubclusterId, VatId } from '@metamask/ocap-kernel';
import { render, screen, cleanup, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { VatTable } from './VatTable.tsx';
import type { VatRecord } from '../types.ts';

describe('VatTable', () => {
  const mockVats: VatRecord[] = [
    {
      id: 'vat-1' as VatId,
      subclusterId: 'subcluster-1' as SubclusterId,
      source: 'source-1',
      parameters: 'params-1',
      creationOptions: 'options-1',
    },
    {
      id: 'vat-2' as VatId,
      subclusterId: 'subcluster-1' as SubclusterId,
      source: 'source-2',
      parameters: 'params-2',
      creationOptions: 'options-2',
    },
  ];

  const mockActions = {
    onPingVat: vi.fn(),
    onRestartVat: vi.fn(),
    onTerminateVat: vi.fn(),
  };

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('returns null when no vats are provided', () => {
    const { container } = render(<VatTable vats={[]} {...mockActions} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders table with correct headers', () => {
    render(<VatTable vats={mockVats} {...mockActions} />);

    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Parameters')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('renders correct vat data in table rows', () => {
    render(<VatTable vats={mockVats} {...mockActions} />);

    mockVats.forEach((vat) => {
      expect(screen.getByText(vat.id)).toBeInTheDocument();
      expect(screen.getByText(vat.source)).toBeInTheDocument();
      expect(screen.getByText(vat.parameters)).toBeInTheDocument();
    });
  });

  it('renders action buttons for each vat', () => {
    render(<VatTable vats={mockVats} {...mockActions} />);

    const rows = screen.getAllByRole('row');
    // Skip header row, check data rows
    const dataRows = rows.slice(1);

    dataRows.forEach((row) => {
      expect(
        within(row).getByRole('button', { name: 'Ping' }),
      ).toBeInTheDocument();
      expect(
        within(row).getByRole('button', { name: 'Restart' }),
      ).toBeInTheDocument();
      expect(
        within(row).getByRole('button', { name: 'Terminate' }),
      ).toBeInTheDocument();
    });
  });

  it('calls onPingVat when ping button is clicked', async () => {
    const user = userEvent.setup();
    render(<VatTable vats={mockVats} {...mockActions} />);

    const firstVatRow = screen
      .getByTestId('vat-table')
      .querySelector('tr[data-vat-id="vat-1"]');
    const pingButton = within(firstVatRow as HTMLElement).getByRole('button', {
      name: 'Ping',
    });

    await user.click(pingButton);
    expect(mockActions.onPingVat).toHaveBeenCalledWith('vat-1');
  });

  it('calls onRestartVat when restart button is clicked', async () => {
    const user = userEvent.setup();
    render(<VatTable vats={mockVats} {...mockActions} />);

    const firstVatRow = screen
      .getByTestId('vat-table')
      .querySelector('tr[data-vat-id="vat-1"]');
    const restartButton = within(firstVatRow as HTMLElement).getByRole(
      'button',
      { name: 'Restart' },
    );

    await user.click(restartButton);
    expect(mockActions.onRestartVat).toHaveBeenCalledWith('vat-1');
  });

  it('calls onTerminateVat when terminate button is clicked', async () => {
    const user = userEvent.setup();
    render(<VatTable vats={mockVats} {...mockActions} />);

    const firstVatRow = screen
      .getByTestId('vat-table')
      .querySelector('tr[data-vat-id="vat-1"]');
    const terminateButton = within(firstVatRow as HTMLElement).getByRole(
      'button',
      { name: 'Terminate' },
    );

    await user.click(terminateButton);
    expect(mockActions.onTerminateVat).toHaveBeenCalledWith('vat-1');
  });

  it('assigns correct data-vat-id attributes to rows', () => {
    render(<VatTable vats={mockVats} {...mockActions} />);

    mockVats.forEach((vat) => {
      const row = screen
        .getByTestId('vat-table')
        .querySelector(`tr[data-vat-id="${vat.id}"]`);
      expect(row).toBeInTheDocument();
    });
  });

  it('handles single vat correctly', () => {
    const singleVat = [mockVats[0]] as VatRecord[];
    render(<VatTable vats={singleVat} {...mockActions} />);

    expect(screen.getByText('vat-1')).toBeInTheDocument();
    expect(screen.getByText('source-1')).toBeInTheDocument();
    expect(screen.getByText('params-1')).toBeInTheDocument();
  });
});
