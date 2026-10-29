import type { KernelStatus } from '@metamask/ocap-kernel';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RunLoopBanner } from './RunLoopBanner.tsx';
import { usePanelContext } from '../context/PanelContext.tsx';
import type { PanelContextType } from '../context/PanelContext.tsx';

vi.mock('../context/PanelContext.tsx', () => ({
  usePanelContext: vi.fn(),
}));

const mockUsePanelContext = vi.mocked(usePanelContext);

const makeMockPanelContext = (
  status: KernelStatus | undefined,
): PanelContextType => ({
  status,
  callKernelMethod: vi.fn(),
  logMessage: vi.fn(),
  messageContent: '',
  setMessageContent: vi.fn(),
  panelLogs: [],
  clearLogs: vi.fn(),
  isLoading: false,
  objectRegistry: null,
  setObjectRegistry: vi.fn(),
});

const makeMockStatus = (runLoop: KernelStatus['runLoop']): KernelStatus => ({
  vats: [],
  subclusters: [],
  runLoop,
});

describe('RunLoopBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('announces a dead run loop with the reason it died', () => {
    mockUsePanelContext.mockReturnValue(
      makeMockPanelContext(
        makeMockStatus({
          state: 'failed',
          error: 'crank exploded',
          detail: '{"message":"crank exploded"}',
        }),
      ),
    );

    render(<RunLoopBanner />);

    expect(screen.getByTestId('run-loop-failure')).toHaveTextContent(
      'Kernel run loop has died',
    );
    expect(screen.getByTestId('run-loop-failure-error')).toHaveTextContent(
      'crank exploded',
    );
  });

  // When a crank dies and its rollback then fails, the headline names the
  // rollback and only the chain names what killed the kernel.
  it('shows the cause chain behind the headline', () => {
    mockUsePanelContext.mockReturnValue(
      makeMockPanelContext(
        makeMockStatus({
          state: 'failed',
          error: 'Run loop died and its crank could not be rolled back',
          detail:
            '{"message":"rollback failed","cause":{"message":"disk gone"}}',
        }),
      ),
    );

    render(<RunLoopBanner />);

    expect(screen.getByTestId('run-loop-failure-detail')).toHaveTextContent(
      'disk gone',
    );
  });

  it.each([
    { name: 'running', runLoop: { state: 'running' } as const },
    { name: 'idle', runLoop: { state: 'idle' } as const },
    { name: 'stopped', runLoop: { state: 'stopped' } as const },
  ])('renders nothing when the run loop is $name', ({ runLoop }) => {
    mockUsePanelContext.mockReturnValue(
      makeMockPanelContext(makeMockStatus(runLoop)),
    );

    render(<RunLoopBanner />);

    expect(screen.queryByTestId('run-loop-failure')).toBeNull();
  });

  it('renders nothing before the first status arrives', () => {
    mockUsePanelContext.mockReturnValue(makeMockPanelContext(undefined));

    render(<RunLoopBanner />);

    expect(screen.queryByTestId('run-loop-failure')).toBeNull();
  });
});
