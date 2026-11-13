import type { KRef } from '@metamask/ocap-kernel';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ObjectRegistry } from './ObjectRegistry.tsx';
import type { PanelContextType } from '../context/PanelContext.tsx';
import { usePanelContext } from '../context/PanelContext.tsx';
import { useRegistry } from '../hooks/useRegistry.ts';
import type { ObjectRegistry as ObjectRegistryType } from '../types.ts';

// Mock the hooks
vi.mock('../context/PanelContext.tsx', () => ({
  usePanelContext: vi.fn(),
}));

vi.mock('../hooks/useRegistry.ts', () => ({
  useRegistry: vi.fn(),
}));

vi.mock('./SendMessageForm.tsx', () => ({
  SendMessageForm: () => (
    <div data-testid="send-message-form">SendMessageForm</div>
  ),
}));

describe('ObjectRegistry Component', () => {
  const fetchObjectRegistry = vi.fn();
  const revoke = vi.fn();

  const mockRegistry: ObjectRegistryType = {
    gcActions: 'test gc actions',
    reapQueue: 'test reap queue',
    terminatedVats: 'test terminated vats',
    ocapUrls: [],
    vats: {
      vat1: {
        overview: { name: 'TestVat1', bundleSpec: '' },
        ownedObjects: [
          {
            kref: 'kref1' as KRef,
            eref: 'eref1',
            refCount: '1',
            revoked: 'false',
            toVats: ['vat2'],
          },
          {
            kref: 'kref2' as KRef,
            eref: 'eref2',
            refCount: '2',
            revoked: 'false',
            toVats: [],
          },
        ],
        importedObjects: [
          {
            kref: 'kref3' as KRef,
            eref: 'eref3',
            refCount: '1',
            fromVat: 'vat2',
          },
        ],
        importedPromises: [
          {
            kref: 'promise1' as KRef,
            eref: 'eref-promise1',
            state: 'pending',
            value: {
              body: '',
              slots: [
                { kref: 'slot1' as KRef, eref: 'eref-slot1', vat: 'vat2' },
                { kref: 'slot2' as KRef, eref: '', vat: 'vat2' },
                { kref: 'slot3' as KRef, eref: null, vat: 'vat2' },
              ],
            },
            fromVat: 'vat2',
          },
        ],
        exportedPromises: [
          {
            kref: 'promise2' as KRef,
            eref: 'eref-promise2',
            state: 'fulfilled',
            value: {
              body: 'value',
              slots: [
                {
                  kref: 'exported-slot1' as KRef,
                  eref: 'exported-eref1',
                  vat: null,
                },
                { kref: 'exported-slot2' as KRef, eref: null, vat: null },
              ],
            },
            toVats: ['vat2'],
          },
        ],
      },
      vat2: {
        overview: { name: 'TestVat2', bundleSpec: '' },
        ownedObjects: [],
        importedObjects: [],
        importedPromises: [],
        exportedPromises: [],
      },
    },
  };

  let mockCallKernelMethod: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    const revoked = new Set();
    mockCallKernelMethod = vi.fn(async ({ method, params: { kref } }) => {
      switch (method) {
        case 'isRevoked':
          return Promise.resolve().then(() => revoked.has(kref));
        case 'revoke':
          revoked.add(kref);
          return Promise.resolve();
        default:
          throw new Error(`unknown kernel method: ${method}`);
      }
    });
    vi.mocked(useRegistry).mockReturnValue({
      fetchObjectRegistry,
      revoke,
    });
    vi.mocked(usePanelContext).mockReturnValue({
      objectRegistry: mockRegistry,
      callKernelMethod: mockCallKernelMethod,
      logMessage: vi.fn(),
      messageContent: '',
      setMessageContent: vi.fn(),
      panelLogs: [],
      clearLogs: vi.fn(),
      isLoading: false,
      status: undefined,
      setObjectRegistry: vi.fn(),
    } as unknown as PanelContextType);
  });

  afterEach(() => {
    cleanup();
  });

  it('fetches the object registry on mount', () => {
    render(<ObjectRegistry />);
    expect(fetchObjectRegistry).toHaveBeenCalledTimes(1);
  });

  it('shows loading state when objectRegistry is null', () => {
    vi.mocked(usePanelContext).mockReturnValue({
      objectRegistry: null,
      callKernelMethod: vi.fn(),
      logMessage: vi.fn(),
      messageContent: '',
      setMessageContent: vi.fn(),
      panelLogs: [],
      clearLogs: vi.fn(),
      isLoading: false,
      status: undefined,
      setObjectRegistry: vi.fn(),
    } as unknown as PanelContextType);

    render(<ObjectRegistry />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders kernel registry information correctly', () => {
    render(<ObjectRegistry />);
    expect(screen.getByText('Kernel Registry')).toBeInTheDocument();
    expect(screen.getByText('GC Actions')).toBeInTheDocument();
    expect(screen.getByText('test gc actions')).toBeInTheDocument();
    expect(screen.getByText('Reap Queue')).toBeInTheDocument();
    expect(screen.getByText('test reap queue')).toBeInTheDocument();
    expect(screen.getByText('Terminated Vats')).toBeInTheDocument();
    expect(screen.getByText('test terminated vats')).toBeInTheDocument();
  });

  it('renders vat list with correct number of vats', () => {
    const { container } = render(<ObjectRegistry />);
    expect(screen.getByText('Vats')).toBeInTheDocument();
    const vatTitles = container.querySelectorAll(
      '[data-testid="accordion-title"]',
    );
    expect(vatTitles.length).toBeGreaterThan(0);
    const vat1Title = Array.from(vatTitles).find(
      (el) =>
        el.textContent?.includes('TestVat1') &&
        el.textContent?.includes('vat1'),
    );
    expect(vat1Title).toBeDefined();
    const vat2Title = Array.from(vatTitles).find(
      (el) =>
        el.textContent?.includes('TestVat2') &&
        el.textContent?.includes('vat2'),
    );
    expect(vat2Title).toBeDefined();
  });

  it('displays correct vat details header', () => {
    const { container } = render(<ObjectRegistry />);

    const vatDetailsHeaders = container.querySelectorAll(
      '[data-testid="vat-details-header"]',
    );
    expect(vatDetailsHeaders.length).toBeGreaterThan(0);
    const vat1Header = Array.from(vatDetailsHeaders).find(
      (el) =>
        el.textContent?.includes('3 objects') &&
        el.textContent?.includes('2 promises'),
    );
    expect(vat1Header).toBeDefined();
    const vat2Header = Array.from(vatDetailsHeaders).find(
      (el) =>
        el.textContent?.includes('0 objects') &&
        el.textContent?.includes('0 promises'),
    );
    expect(vat2Header).toBeDefined();
  });

  it('toggles vat details when clicked', () => {
    const { container } = render(<ObjectRegistry />);
    // Initially, vat details should be collapsed
    expect(screen.queryByText('Owned Objects')).not.toBeInTheDocument();
    const collapseVat = expandVat(container, 'TestVat1', 'vat1');
    // Now details should be visible
    expect(screen.getByText('Owned Objects')).toBeInTheDocument();
    expect(screen.getByText('Imported Objects')).toBeInTheDocument();
    expect(screen.getByText('Imported Promises')).toBeInTheDocument();
    expect(screen.getByText('Exported Promises')).toBeInTheDocument();
    // Click again to collapse
    collapseVat();
    // Details should be hidden again
    expect(screen.queryByText('Owned Objects')).not.toBeInTheDocument();
  });

  it('renders empty state indicators for empty arrays', () => {
    const { container } = render(<ObjectRegistry />);
    expandVat(container, 'TestVat2', 'vat2');
    // TestVat2 should not have any tables
    expect(screen.queryByText('Owned Objects')).not.toBeInTheDocument();
    expect(screen.queryByText('Imported Objects')).not.toBeInTheDocument();
    expect(screen.queryByText('Imported Promises')).not.toBeInTheDocument();
    expect(screen.queryByText('Exported Promises')).not.toBeInTheDocument();
  });

  it('renders object tables with correct data', () => {
    const { container } = render(<ObjectRegistry />);
    expandVat(container, 'TestVat1', 'vat1');
    // Get tables by their headers
    const ownedObjectsTable = getTableByHeading(container, 'Owned Objects');
    const importedObjectsTable = getTableByHeading(
      container,
      'Imported Objects',
    );
    const importedPromisesTable = getTableByHeading(
      container,
      'Imported Promises',
    );
    const exportedPromisesTable = getTableByHeading(
      container,
      'Exported Promises',
    );
    // Check owned objects table
    within(ownedObjectsTable).getByText('kref1');
    within(ownedObjectsTable).getByText('eref1');
    within(ownedObjectsTable).getByText('vat2');
    within(ownedObjectsTable).getByText('kref2');
    within(ownedObjectsTable).getByText('eref2');
    // Check imported objects table
    within(importedObjectsTable).getByText('kref3');
    within(importedObjectsTable).getByText('eref3');
    within(importedObjectsTable).getByText('vat2');

    // Check imported promises table
    within(importedPromisesTable).getByText('promise1');
    within(importedPromisesTable).getByText('eref-promise1');
    within(importedPromisesTable).getByText('pending');
    within(importedPromisesTable).getByText('vat2');

    // Check exported promises table
    within(exportedPromisesTable).getByText('promise2');
    within(exportedPromisesTable).getByText('eref-promise2');
    within(exportedPromisesTable).getByText('fulfilled');
    within(exportedPromisesTable).getByText('value');
    within(exportedPromisesTable).getByText('vat2');

    // If we arrive here without error, the test passed.
    expect(true).toBe(true);
  });

  it('properly formats slots with and without eref', () => {
    const { container } = render(<ObjectRegistry />);
    expandVat(container, 'TestVat1', 'vat1');

    // Get the tables from the expanded content
    const importedPromisesTable = getTableByHeading(
      container,
      'Imported Promises',
    );
    const exportedPromisesTable = getTableByHeading(
      container,
      'Exported Promises',
    );

    // Get the cells containing slot information (5th column, index 4)
    const importedSlotsText = getCellTextByIndex(importedPromisesTable, 4);
    const exportedSlotsText = getCellTextByIndex(exportedPromisesTable, 4);

    // Test imported promise slots formatting
    expect(importedSlotsText).toContain('slot1 (eref-slot1)'); // With eref
    expect(importedSlotsText).toContain('slot2'); // With empty eref
    expect(importedSlotsText).toContain('slot3'); // With null eref
    expect(importedSlotsText).not.toContain('slot2 ()'); // Empty eref shouldn't show parentheses
    expect(importedSlotsText).not.toContain('slot3 ()'); // Null eref shouldn't show parentheses

    // Test exported promise slots formatting
    expect(exportedSlotsText).toContain('exported-slot1 (exported-eref1)'); // With eref
    expect(exportedSlotsText).toContain('exported-slot2'); // With null eref
    expect(exportedSlotsText).not.toContain('exported-slot2 ()'); // Null eref shouldn't show parentheses
  });

  it('refreshes registry when Refresh button is clicked', () => {
    render(<ObjectRegistry />);
    // fetchObjectRegistry should be called once on mount
    expect(fetchObjectRegistry).toHaveBeenCalledTimes(1);
    // Find and click the refresh button
    const refreshButton = screen.getByTestId('refresh-registry-button');
    expect(refreshButton).toBeDefined();
    expect(refreshButton?.textContent).toBe('Refresh');
    // Ensure refreshButton is not null before clicking
    expect(refreshButton).toBeInstanceOf(Element);
    fireEvent.click(refreshButton as Element);
    // fetchObjectRegistry should be called again
    expect(fetchObjectRegistry).toHaveBeenCalledTimes(2);
  });

  it.each`
    revoked  | expectedText | expectEnabled
    ${false} | ${'Revoke'}  | ${true}
    ${true}  | ${'Revoked'} | ${false}
  `(
    'displays the Revoke button reflecting the revocation status ($revoked)',
    async ({ revoked, expectedText, expectEnabled }) => {
      vi.mocked(usePanelContext).mockReturnValue({
        objectRegistry: (() => {
          const registry = structuredClone(
            mockRegistry,
          ) as ObjectRegistryType & {
            vats: { vat1: { ownedObjects: [{ revoked: string }] } };
          };
          registry.vats.vat1.ownedObjects[0].revoked = revoked
            ? 'true'
            : 'false';
          console.log(registry);
          return registry;
        })(),
        callKernelMethod: vi.fn().mockResolvedValue([revoked]),
        logMessage: vi.fn(),
        messageContent: '',
        setMessageContent: vi.fn(),
        panelLogs: [],
        clearLogs: vi.fn(),
        isLoading: false,
        status: undefined,
        setObjectRegistry: vi.fn(),
      } as unknown as PanelContextType);
      const { container } = render(<ObjectRegistry />);
      // Expand the vat to see the revoke button
      expandVat(container, 'TestVat1', 'vat1');
      const revokeButton = screen.getByTestId('revoke-button-kref1');
      expect(revokeButton).toBeInTheDocument();
      expect(revokeButton.textContent).toStrictEqual(expectedText);
      expect(revokeButton).toHaveProperty('disabled', !expectEnabled);
    },
  );

  it('revokes an object when the Revoke button is pressed', async () => {
    const { container } = render(<ObjectRegistry />);
    expandVat(container, 'TestVat1', 'vat1');
    const revokeButton = screen.getByTestId('revoke-button-kref1');
    expect(revokeButton).toBeInTheDocument();
    await waitFor(() => expect(revokeButton).toBeEnabled());
    expect(revokeButton?.textContent).toBe('Revoke');
    fireEvent.click(revokeButton as Element);
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    expect(revoke.mock.calls[0]).toStrictEqual(['kref1']);
  });

  it('displays the SendMessageForm component', () => {
    render(<ObjectRegistry />);
    const sendMessageForm = screen.queryByTestId('send-message-form');
    expect(sendMessageForm).toBeInTheDocument();
  });

  it('displays singular forms for VatDetailsHeader with 1 object/promise', () => {
    const registryWithSingular: ObjectRegistryType = {
      gcActions: 'test',
      reapQueue: 'test',
      terminatedVats: 'test',
      ocapUrls: [],
      vats: {
        singularVat: {
          overview: { name: 'SingleVat', bundleSpec: '' },
          ownedObjects: [
            {
              kref: 'kref1' as KRef,
              eref: 'eref1',
              refCount: '1',
              revoked: 'false',
              toVats: [],
            },
          ],
          importedObjects: [],
          importedPromises: [
            {
              kref: 'promise1' as KRef,
              eref: 'eref-promise1',
              state: 'pending',
              value: { body: '', slots: [] },
              fromVat: 'vat2',
            },
          ],
          exportedPromises: [],
        },
      },
    };

    vi.mocked(usePanelContext).mockReturnValue({
      objectRegistry: registryWithSingular,
      callKernelMethod: vi.fn(),
      logMessage: vi.fn(),
      messageContent: '',
      setMessageContent: vi.fn(),
      panelLogs: [],
      clearLogs: vi.fn(),
      isLoading: false,
      status: undefined,
      setObjectRegistry: vi.fn(),
    } as unknown as PanelContextType);

    render(<ObjectRegistry />);

    // Should display "1 object, 1 promise" (singular forms)
    expect(screen.getByText(/1 object, 1 promise/u)).toBeInTheDocument();
  });

  it('handles empty slots arrays and empty toVats arrays', () => {
    const registryWithEmptyArrays: ObjectRegistryType = {
      gcActions: 'test',
      reapQueue: 'test',
      terminatedVats: 'test',
      ocapUrls: [],
      vats: {
        emptyVat: {
          overview: { name: 'EmptyVat', bundleSpec: '' },
          ownedObjects: [
            {
              kref: 'kref1' as KRef,
              eref: 'eref1',
              refCount: '1',
              revoked: 'false',
              toVats: [],
            }, // Empty toVats
          ],
          importedObjects: [
            {
              kref: 'kref2' as KRef,
              eref: 'eref2',
              refCount: '1',
              fromVat: null,
            }, // Null fromVat
          ],
          importedPromises: [
            {
              kref: 'promise1' as KRef,
              eref: 'eref-promise1',
              state: 'pending',
              value: { body: 'test', slots: [] }, // Empty slots
              fromVat: null, // Null fromVat
            },
          ],
          exportedPromises: [
            {
              kref: 'promise2' as KRef,
              eref: 'eref-promise2',
              state: 'fulfilled',
              value: { body: 'test', slots: [] }, // Empty slots
              toVats: [], // Empty toVats
            },
          ],
        },
      },
    };

    vi.mocked(usePanelContext).mockReturnValue({
      objectRegistry: registryWithEmptyArrays,
      callKernelMethod: vi.fn().mockResolvedValue([false]),
      logMessage: vi.fn(),
      messageContent: '',
      setMessageContent: vi.fn(),
      panelLogs: [],
      clearLogs: vi.fn(),
      isLoading: false,
      status: undefined,
      setObjectRegistry: vi.fn(),
    } as unknown as PanelContextType);

    const { container } = render(<ObjectRegistry />);
    expandVat(container, 'EmptyVat', 'emptyVat');

    // Should display "—" for empty arrays and null values
    const dashElements = screen.getAllByText('—');
    expect(dashElements.length).toBeGreaterThan(0);
  });
});

/**
 * Helper function to find a table by its heading text
 *
 * @param container - The container element to search within
 * @param heading - The heading text to find
 * @returns The table element associated with the heading
 */
function getTableByHeading(
  container: HTMLElement,
  heading: string,
): HTMLElement {
  const headings = Array.from(
    container.querySelectorAll('[data-testid="table-heading"]'),
  );
  const targetHeading = headings.find(
    (element) => element.textContent === heading,
  );
  expect(targetHeading).toBeDefined();
  const parentBox = targetHeading?.closest('.mt-6');
  expect(parentBox).toBeDefined();
  const table = parentBox?.querySelector('table');
  expect(table).toBeDefined();
  return table as HTMLElement;
}

/**
 * Helper function to get the text content of a table cell by index
 *
 * @param table - The table element
 * @param columnIndex - The index of the column to extract
 * @returns The text content of the cell
 */
function getCellTextByIndex(table: HTMLElement, columnIndex: number): string {
  const cells = within(table).getAllByRole('cell');
  const columnCells = Array.from(cells).filter(
    (_, index) => index % 6 === columnIndex,
  );
  expect(columnCells.length).toBeGreaterThan(0);
  return columnCells[0]?.textContent ?? '';
}

/**
 * Helper function to expand a vat by clicking its accordion header
 *
 * @param container - The container element to search within
 * @param vatName - The name of the vat to expand
 * @param vatId - The id of the vat to expand
 * @returns A function that can be used to collapse the vat
 */
function expandVat(
  container: HTMLElement,
  vatName: string,
  vatId: string,
): () => void {
  const accordionHeaders = container.querySelectorAll(
    '[data-testid="accordion-header"]',
  );
  const vatHeader = Array.from(accordionHeaders).find(
    (ele) =>
      ele.textContent?.includes(vatName) && ele.textContent?.includes(vatId),
  ) as Element;
  expect(vatHeader).toBeDefined();
  expect(vatHeader).toBeInstanceOf(Element);
  fireEvent.click(vatHeader);
  return () => fireEvent.click(vatHeader);
}
