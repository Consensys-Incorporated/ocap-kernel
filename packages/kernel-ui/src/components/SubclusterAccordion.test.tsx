import type { SubclusterId, VatId } from '@metamask/ocap-kernel';
import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { SubclusterAccordion } from './SubclusterAccordion.tsx';
import type { VatRecord } from '../types.ts';

// Mock the child components
vi.mock('./shared/Accordion.tsx', () => ({
  Accordion: ({
    title,
    children,
    isExpanded,
    onToggle,
    testId,
  }: {
    title: React.ReactNode;
    children: React.ReactNode;
    isExpanded: boolean;
    onToggle: (expanded: boolean) => void;
    testId: string;
  }) => (
    <div data-testid={testId}>
      <div onClick={() => onToggle(!isExpanded)}>
        {title}
        <span>{isExpanded ? '−' : '+'}</span>
      </div>
      {isExpanded && <div>{children}</div>}
    </div>
  ),
}));

vi.mock('./shared/Modal.tsx', () => ({
  Modal: ({
    isOpen,
    onClose,
    title,
    children,
  }: {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div data-testid="modal">
        <h3>{title}</h3>
        <button onClick={onClose}>Close</button>
        {children}
      </div>
    ) : null,
}));

vi.mock('./VatTable.tsx', () => ({
  VatTable: ({
    vats,
    onPingVat,
    onRestartVat,
    onTerminateVat,
  }: {
    vats: VatRecord[];
    onPingVat: (id: string) => void;
    onRestartVat: (id: string) => void;
    onTerminateVat: (id: string) => void;
  }) => (
    <div data-testid="vat-table">
      {vats.map((vat: VatRecord) => (
        <div key={vat.id}>
          {vat.id}
          <button onClick={() => onPingVat(vat.id)}>Ping</button>
          <button onClick={() => onRestartVat(vat.id)}>Restart</button>
          <button onClick={() => onTerminateVat(vat.id)}>Terminate</button>
        </div>
      ))}
    </div>
  ),
}));

describe('SubclusterAccordion', () => {
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

  const mockConfig = {
    bootstrap: 'alice',
    vats: {
      alice: { bundleSpec: 'test.js', parameters: {} },
      bob: { bundleSpec: 'test2.js', parameters: {} },
    },
  };

  const mockActions = {
    onPingVat: vi.fn(),
    onRestartVat: vi.fn(),
    onTerminateVat: vi.fn(),
    onTerminateSubcluster: vi.fn(),
  };

  const defaultProps = {
    id: 'subcluster-1' as SubclusterId,
    vats: mockVats,
    config: mockConfig,
    ...mockActions,
  };

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders accordion with correct title', () => {
    render(<SubclusterAccordion {...defaultProps} />);

    expect(screen.getByText('Subcluster subcluster-1 -')).toBeInTheDocument();
    expect(screen.getByText('2 Vats')).toBeInTheDocument();
  });

  it('renders singular vat text when only one vat', () => {
    const singleVat = mockVats[0]!;
    render(<SubclusterAccordion {...defaultProps} vats={[singleVat]} />);

    expect(screen.getByText('1 Vat')).toBeInTheDocument();
  });

  it('does not render vat table when collapsed', () => {
    render(<SubclusterAccordion {...defaultProps} />);

    expect(screen.queryByTestId('vat-table')).not.toBeInTheDocument();
  });

  it('renders controls and vat table when expanded', async () => {
    const user = userEvent.setup();
    render(<SubclusterAccordion {...defaultProps} />);

    // Expand the accordion
    await user.click(screen.getByText('Subcluster subcluster-1 -'));

    expect(screen.getByTestId('view-config-button')).toBeInTheDocument();
    expect(
      screen.getByTestId('terminate-subcluster-button'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('vat-table')).toBeInTheDocument();
  });

  it('calls onTerminateSubcluster when terminate button is clicked', async () => {
    const user = userEvent.setup();
    render(<SubclusterAccordion {...defaultProps} />);

    // Expand the accordion
    await user.click(screen.getByText('Subcluster subcluster-1 -'));

    // Click terminate button
    await user.click(screen.getByTestId('terminate-subcluster-button'));

    expect(mockActions.onTerminateSubcluster).toHaveBeenCalledWith(
      'subcluster-1',
    );
  });

  it('opens config modal when View Config button is clicked', async () => {
    const user = userEvent.setup();
    render(<SubclusterAccordion {...defaultProps} />);

    // Expand the accordion
    await user.click(screen.getByText('Subcluster subcluster-1 -'));

    // Initially modal should not be visible
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();

    // Click View Config button
    await user.click(screen.getByTestId('view-config-button'));

    // Modal should now be visible
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    expect(
      screen.getByText('Subcluster subcluster-1 Configuration'),
    ).toBeInTheDocument();
  });

  it('closes config modal when close button is clicked', async () => {
    const user = userEvent.setup();
    render(<SubclusterAccordion {...defaultProps} />);

    // Expand the accordion and open modal
    await user.click(screen.getByText('Subcluster subcluster-1 -'));
    await user.click(screen.getByTestId('view-config-button'));

    // Modal should be visible
    expect(screen.getByTestId('modal')).toBeInTheDocument();

    // Close modal
    await user.click(screen.getByRole('button', { name: 'Close' }));

    // Modal should be hidden
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
  });

  it('displays formatted config in textarea', async () => {
    const user = userEvent.setup();
    render(<SubclusterAccordion {...defaultProps} />);

    // Expand and open modal
    await user.click(screen.getByText('Subcluster subcluster-1 -'));
    await user.click(screen.getByTestId('view-config-button'));

    const textarea = screen.getByTestId('config-textarea');
    expect(textarea).toBeInTheDocument();
    expect((textarea as HTMLTextAreaElement).value).toContain('bootstrap');
    expect((textarea as HTMLTextAreaElement).value).toContain('alice');
  });

  it('renders VatTable with correct vats when expanded', async () => {
    const user = userEvent.setup();
    render(<SubclusterAccordion {...defaultProps} />);

    // Expand the accordion
    await user.click(screen.getByText('Subcluster subcluster-1 -'));

    // Verify VatTable is rendered
    const vatTable = screen.getByTestId('vat-table');
    expect(vatTable).toBeInTheDocument();

    // Verify both vats are displayed
    expect(screen.getByText('vat-1')).toBeInTheDocument();
    expect(screen.getByText('vat-2')).toBeInTheDocument();
  });

  it('renders with correct test ID', () => {
    render(<SubclusterAccordion {...defaultProps} />);

    expect(
      screen.getByTestId('subcluster-accordion-subcluster-1'),
    ).toBeInTheDocument();
  });
});
