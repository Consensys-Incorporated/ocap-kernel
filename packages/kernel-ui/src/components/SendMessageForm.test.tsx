import { stringify } from '@metamask/kernel-utils';
import type { KRef } from '@metamask/ocap-kernel';
import { setupOcapKernelMock } from '@ocap/repo-tools/test-utils';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { PanelContextType } from '../context/PanelContext.tsx';
import { usePanelContext } from '../context/PanelContext.tsx';
import { useRegistry } from '../hooks/useRegistry.ts';
import type { ObjectRegistry } from '../types.ts';
import { SendMessageForm } from './SendMessageForm.tsx';

const { resetMocks, setMockBehavior } = setupOcapKernelMock();

vi.mock('../context/PanelContext.tsx', () => ({
  usePanelContext: vi.fn(),
}));

vi.mock('../hooks/useRegistry.ts', () => ({
  useRegistry: vi.fn(),
}));

vi.mock('@metamask/kernel-utils', async (importOriginal) => ({
  ...(await importOriginal()),
  stringify: vi.fn(),
}));

describe('SendMessageForm Component', () => {
  const callKernelMethod = vi.fn();
  const logMessage = vi.fn();
  const fetchObjectRegistry = vi.fn();

  const mockObjectRegistry: ObjectRegistry = {
    gcActions: '',
    reapQueue: '',
    terminatedVats: '',
    ocapUrls: [],
    vats: {
      vat1: {
        overview: { name: 'TestVat1', bundleSpec: '' },
        ownedObjects: [
          {
            kref: 'ko1' as KRef,
            eref: 'eref1',
            refCount: '1',
            toVats: [],
            revoked: 'false',
          },
          {
            kref: 'ko2' as KRef,
            eref: 'eref2',
            refCount: '1',
            toVats: [],
            revoked: 'false',
          },
        ],
        importedObjects: [],
        importedPromises: [],
        exportedPromises: [],
      },
      vat2: {
        overview: { name: 'TestVat2', bundleSpec: '' },
        ownedObjects: [
          {
            kref: 'ko3' as KRef,
            eref: 'eref3',
            refCount: '1',
            toVats: [],
            revoked: 'false',
          },
        ],
        importedObjects: [
          {
            kref: 'ko4' as KRef,
            eref: 'eref4',
            refCount: '1',
            fromVat: 'vat1',
          },
        ],
        importedPromises: [],
        exportedPromises: [],
      },
    },
  };

  beforeEach(() => {
    vi.mocked(stringify).mockImplementation((value) =>
      JSON.stringify(value, null, 2),
    );

    vi.mocked(useRegistry).mockReturnValue({
      fetchObjectRegistry,
    } as unknown as ReturnType<typeof useRegistry>);

    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod,
      logMessage,
      objectRegistry: mockObjectRegistry,
    } as unknown as PanelContextType);

    callKernelMethod.mockResolvedValue({ body: 'success', slots: [] });
  });

  afterEach(() => {
    cleanup();
    resetMocks();
    vi.resetModules();
  });

  it('renders nothing when objectRegistry is null', async () => {
    vi.mocked(usePanelContext).mockReturnValue({
      callKernelMethod,
      logMessage,
      objectRegistry: null,
    } as unknown as PanelContextType);
    const { container } = render(<SendMessageForm />);
    expect(container.firstChild).toBeNull();
  });

  it('renders form with correct initial values when objectRegistry is available', async () => {
    const { getByTestId } = render(<SendMessageForm />);

    // Check form elements are rendered
    expect(screen.getByText('Send Message')).toBeInTheDocument();
    expect(screen.getByLabelText('Target:')).toBeInTheDocument();
    expect(screen.getByLabelText('Method:')).toBeInTheDocument();
    expect(screen.getByLabelText('Params (JSON):')).toBeInTheDocument();
    expect(screen.getByText('Send')).toBeInTheDocument();

    // Check initial values
    expect(screen.getByDisplayValue('__getMethodNames__')).toBeInTheDocument();
    expect(screen.getByDisplayValue('[]')).toBeInTheDocument();

    // Check target dropdown contains the expected options
    const targetSelect = getByTestId('message-target');
    expect(targetSelect).toBeInTheDocument();
    expect(targetSelect).toHaveValue('');

    const options = within(targetSelect).getAllByRole('option');
    expect(options).toHaveLength(5); // 1 placeholder + 4 options from mock registry

    // Check dropdown options include objects from the registry
    expect(screen.getByText('ko1 (TestVat1)')).toBeInTheDocument();
    expect(screen.getByText('ko2 (TestVat1)')).toBeInTheDocument();
    expect(screen.getByText('ko3 (TestVat2)')).toBeInTheDocument();
    expect(screen.getByText('ko4 (TestVat1)')).toBeInTheDocument();
  });

  it('updates form values when inputs change', async () => {
    const { getByTestId } = render(<SendMessageForm />);

    // Change target
    const targetSelect = getByTestId('message-target');
    fireEvent.change(targetSelect, { target: { value: 'ko1' } });
    expect(targetSelect).toHaveValue('ko1');

    // Change method
    const methodInput = getByTestId('message-method');
    await userEvent.clear(methodInput);
    await userEvent.type(methodInput, 'testMethod');
    expect(methodInput).toHaveValue('testMethod');

    // Change params - using fireEvent.change instead of userEvent.type
    const paramsInput = getByTestId('message-params');
    fireEvent.change(paramsInput, { target: { value: '["arg1", "arg2"]' } });
    expect(paramsInput).toHaveValue('["arg1", "arg2"]');
  });

  it('disables Send button when target is empty', async () => {
    const { getByTestId } = render(<SendMessageForm />);

    // Initially button should be disabled (no target selected)
    const sendButton = getByTestId('message-send-button');
    expect(sendButton).toBeDisabled();

    // Select a target
    const targetSelect = getByTestId('message-target');
    fireEvent.change(targetSelect, { target: { value: 'ko1' } });

    // Button should now be enabled
    expect(sendButton).not.toBeDisabled();

    // Clear method
    const methodInput = getByTestId('message-method');
    await userEvent.clear(methodInput);

    // Button should be disabled again
    expect(sendButton).toBeDisabled();
  });

  it('does not set target when value fails KRef validation', async () => {
    setMockBehavior({ isKRef: false });
    const { getByTestId } = render(<SendMessageForm />);

    const targetSelect = getByTestId('message-target');
    fireEvent.change(targetSelect, { target: { value: 'not-a-kref' } });

    // Target should remain unset, button stays disabled
    expect(targetSelect).toHaveValue('');
    expect(getByTestId('message-send-button')).toBeDisabled();
  });

  it('calls callKernelMethod with correct parameters when Send button is clicked', async () => {
    const { getByTestId } = render(<SendMessageForm />);

    // Set up form values
    const targetSelect = getByTestId('message-target');
    fireEvent.change(targetSelect, { target: { value: 'ko1' } });

    const methodInput = getByTestId('message-method');
    fireEvent.change(methodInput, { target: { value: 'testMethod' } });

    const paramsInput = getByTestId('message-params');
    fireEvent.change(paramsInput, { target: { value: '["arg1", "arg2"]' } });

    // Parse expected args to match what the component will do
    const expectedArgs = ['arg1', 'arg2'];

    // Click send button
    const sendButton = getByTestId('message-send-button');
    await userEvent.click(sendButton);

    // Check if callKernelMethod was called with correct parameters
    expect(callKernelMethod).toHaveBeenCalledWith({
      method: 'queueMessage',
      params: ['ko1', 'testMethod', expectedArgs],
    });

    // Check if fetchObjectRegistry was called
    await waitFor(() => {
      expect(fetchObjectRegistry).toHaveBeenCalled();
    });
  });

  it('logs error when callKernelMethod fails', async () => {
    const testError = new Error('Test error');
    callKernelMethod.mockRejectedValueOnce(testError);

    const { getByTestId } = render(<SendMessageForm />);

    // Set up form values and submit
    const targetSelect = getByTestId('message-target');
    fireEvent.change(targetSelect, { target: { value: 'ko1' } });

    const sendButton = getByTestId('message-send-button');
    await userEvent.click(sendButton);

    // Check if error was logged
    await waitFor(() => {
      expect(logMessage).toHaveBeenCalledWith(String(testError), 'error');
    });
  });

  it('displays response after successful submission', async () => {
    const mockResponse = { body: 'Success response', slots: [] };
    callKernelMethod.mockResolvedValueOnce(mockResponse);

    // Mock stringify to return a consistent string
    const mockResponseString = JSON.stringify(mockResponse, null, 2);
    vi.mocked(stringify).mockReturnValueOnce(mockResponseString);

    const { getByTestId } = render(<SendMessageForm />);

    // Set up form values and submit
    const targetSelect = getByTestId('message-target');
    fireEvent.change(targetSelect, { target: { value: 'ko1' } });

    const sendButton = getByTestId('message-send-button');
    await userEvent.click(sendButton);

    // Check if response section is displayed
    await waitFor(() => {
      const responseHeading = screen.getByText('Response:');
      expect(responseHeading).toBeInTheDocument();

      // Find the pre element that contains the response
      const preElement = responseHeading.parentElement?.querySelector('pre');
      expect(preElement).toBeInTheDocument();
      expect(preElement?.textContent).toContain('Success response');
    });
  });

  it('handles invalid JSON in params input', async () => {
    const { getByTestId } = render(<SendMessageForm />);

    // Set up form values with invalid JSON
    const targetSelect = getByTestId('message-target');
    fireEvent.change(targetSelect, { target: { value: 'ko1' } });

    const paramsInput = getByTestId('message-params');
    fireEvent.change(paramsInput, { target: { value: 'invalid json' } });

    // Click send button
    const sendButton = getByTestId('message-send-button');
    await userEvent.click(sendButton);

    // Now the JSON parse error is caught by the component's catch handler
    await waitFor(() => {
      expect(logMessage).toHaveBeenCalledWith(
        expect.stringContaining('SyntaxError'),
        'error',
      );
    });
  });

  it('triggers submission when Enter key is pressed in input fields', async () => {
    const { getByTestId } = render(<SendMessageForm />);

    // Set up form values - we need a valid target and valid JSON
    const targetSelect = getByTestId('message-target');
    fireEvent.change(targetSelect, { target: { value: 'ko1' } });

    // Ensure we have valid JSON in the params field
    const paramsInput = getByTestId('message-params');
    fireEvent.change(paramsInput, { target: { value: '[]' } });

    // Press Enter in method input - using fireEvent for better control
    const methodInput = getByTestId('message-method');
    fireEvent.keyDown(methodInput, { key: 'Enter', code: 'Enter' });

    // Wait for the async handleSend to be called
    await waitFor(() => {
      expect(callKernelMethod).toHaveBeenCalled();
    });

    callKernelMethod.mockClear();

    // Press Enter in params input
    fireEvent.keyDown(paramsInput, { key: 'Enter', code: 'Enter' });

    // Wait for the async handleSend to be called
    await waitFor(() => {
      expect(callKernelMethod).toHaveBeenCalled();
    });
  });
});
