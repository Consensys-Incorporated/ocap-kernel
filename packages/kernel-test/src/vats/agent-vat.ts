import type { ERef } from '@endo/eventual-send';
import {
  makeChatClient,
  makeSampleClient,
} from '@metamask/kernel-language-model-service';
import type {
  ChatService,
  LanguageModel,
  SampleService,
} from '@metamask/kernel-language-model-service';
import { ifDefined } from '@metamask/kernel-utils';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Agent, CapabilityRecord } from '@ocap/kernel-agents';
import {
  getMoonPhase,
  search,
} from '@ocap/kernel-agents/capabilities/examples';
import { add, count, multiply } from '@ocap/kernel-agents/capabilities/math';
import { makeChatAgent } from '@ocap/kernel-agents/chat';
import { makeJsonAgent } from '@ocap/kernel-agents/json';
import { makeParserClient, makeReplAgent } from '@ocap/kernel-agents-repl';
import type { Parser } from '@ocap/kernel-agents-repl';

import {
  AGENT_VAT_TAG,
  formatError,
  formatInvocation,
  formatResult,
} from '../agent-protocol.ts';
import type {
  AgentCapabilityName,
  AgentVatParameters,
} from '../agent-protocol.ts';
import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

type Services = {
  languageModelService: ERef<SampleService & ChatService>;
  /** Required by the `repl` strategy, whose parser is native code in the host. */
  parserService?: ERef<Parser>;
};

const builtinCapabilities: CapabilityRecord<AgentCapabilityName> = {
  count,
  add,
  multiply,
  getMoonPhase,
  search,
};

/**
 * A vat that runs a capability-augmented agent against the kernel's language
 * model service and logs what the agent did: each capability invocation, then
 * the task's result or error. The strategy, model, intent and granted
 * capabilities are vat parameters, so one bundle serves every agent test.
 *
 * @param vatPowers - The powers of the vat.
 * @param parameters - The parameters of the vat.
 * @returns A default Exo instance.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  parameters: AgentVatParameters,
) {
  const {
    strategy,
    model,
    intent,
    capabilities: names = [],
    invocationBudget,
    maxTokens,
  } = parameters;
  const tlog = unwrapTestLogger(vatPowers, AGENT_VAT_TAG);
  const logger = vatPowers.logger.subLogger({ tags: ['agent'] });

  const capabilities: CapabilityRecord = Object.fromEntries(
    names.map((name) => {
      const { func, schema } = builtinCapabilities[name];
      const logged = async (args: never): Promise<unknown> => {
        tlog(formatInvocation(name, args));
        return await func(args);
      };
      return [name, { func: logged, schema }];
    }),
  );

  // The kernel service answers a sample in one piece, while the sampling
  // strategies read a stream, so the whole answer becomes the only chunk.
  const makeLanguageModel = (
    service: ERef<SampleService>,
  ): LanguageModel<unknown, { response: string }> => {
    const client = makeSampleClient(service, model);
    return {
      getInfo: async () => ({ model, options: {} }),
      load: async () => undefined,
      unload: async () => undefined,
      sample: async (prompt: string) => {
        const { text } = await client.sample({
          prompt,
          ...ifDefined({ max_tokens: maxTokens }),
        });
        return {
          stream: (async function* () {
            yield { response: text };
          })(),
          abort: async () => undefined,
        };
      },
    };
  };

  const makeAgent = ({
    languageModelService,
    parserService,
  }: Services): Agent => {
    switch (strategy) {
      case 'json':
        return makeJsonAgent({
          languageModel: makeLanguageModel(languageModelService),
          capabilities,
          logger,
        });
      case 'repl': {
        if (!parserService) {
          throw new Error('The repl strategy needs the parser service.');
        }
        return makeReplAgent({
          languageModel: makeLanguageModel(languageModelService),
          capabilities,
          logger,
          parser: makeParserClient(parserService),
        });
      }
      case 'chat': {
        const client = makeChatClient(languageModelService, model);
        return makeChatAgent({
          chat: async ({ messages, tools }) =>
            client.chat.completions.create({
              messages,
              ...(tools && { tools }),
            }),
          capabilities,
        });
      }
      default:
        throw new Error(`Unknown strategy: ${String(strategy)}`);
    }
  };

  return makeDefaultExo('root', {
    async bootstrap(_roots: unknown, services: Services) {
      try {
        const agent = makeAgent(services);
        const result = await agent.task(intent, undefined, {
          ...ifDefined({ invocationBudget }),
          logger: logger.subLogger({ tags: ['transcript'] }),
        });
        tlog(formatResult(result));
        return result;
      } catch (error) {
        tlog(formatError(error));
        return undefined;
      }
    },
  });
}
