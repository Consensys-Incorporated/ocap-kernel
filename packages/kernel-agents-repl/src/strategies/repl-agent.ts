import { makeAgent } from '@ocap/kernel-agents/agent';
import type { MakeAgentArgs } from '@ocap/kernel-agents/agent';
import type { Agent } from '@ocap/kernel-agents/types';

import type { State, Action, Observation } from './repl/messages.ts';
import type { Parser } from './repl/parse/syntax-tree.ts';
import { makePrepareAttempt } from './repl/prepare-attempt.ts';

export type MakeReplAgentArgs = MakeAgentArgs & {
  /**
   * The JavaScript parser that reads the agent's statements, e.g.
   * `makeTreeSitterParser()` from `@ocap/kernel-agents-repl/parser/tree-sitter`.
   */
  parser: Parser;
};

export const makeReplAgent = ({ parser, ...args }: MakeReplAgentArgs): Agent =>
  makeAgent<State, Action, Observation>(args, makePrepareAttempt(parser));
