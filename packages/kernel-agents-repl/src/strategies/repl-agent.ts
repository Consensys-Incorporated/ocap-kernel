import { makeAgent } from '@ocap/kernel-agents/agent';
import type { Agent } from '@ocap/kernel-agents/types';

import type { State, Action, Observation } from './repl/messages.ts';
import { prepareAttempt } from './repl/prepare-attempt.ts';

export const makeReplAgent = (
  args: Parameters<typeof makeAgent<State, Action, Observation>>[0],
): Agent => makeAgent<State, Action, Observation>(args, prepareAttempt);
