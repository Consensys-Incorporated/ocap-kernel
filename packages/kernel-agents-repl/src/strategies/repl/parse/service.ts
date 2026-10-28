import { E } from '@endo/eventual-send';
import type { ERef } from '@endo/eventual-send';

import type { Parser, SyntaxTree } from './syntax-tree.ts';

/**
 * Canonical service name for the parser service in `ClusterConfig.services`.
 */
export const PARSER_SERVICE_NAME = 'parserService';

/**
 * Wrap a host-side parser as a kernel service object. Use the returned
 * `{ name, service }` with `kernel.registerKernelServiceObject(name, service)`,
 * then list `PARSER_SERVICE_NAME` in a subcluster's `services` so its
 * bootstrap vat receives the service reference.
 *
 * @param parser - The parser to expose, typically `makeTreeSitterParser()`.
 * @returns An object with `name` and `service` fields for use with the kernel.
 */
export const makeKernelParserService = (
  parser: Parser,
): { name: string; service: object } =>
  harden({
    name: PARSER_SERVICE_NAME,
    service: harden({
      async parse(code: string): Promise<SyntaxTree> {
        return harden(await parser.parse(code));
      },
    }),
  });

/**
 * Wrap a reference to a remote parser service as a `Parser` for use inside a
 * vat.
 *
 * @param serviceRef - The reference, e.g. the `parserService` a bootstrap vat
 * receives.
 * @returns The parser.
 */
export const makeParserClient = (serviceRef: ERef<Parser>): Parser =>
  harden({
    parse: async (code: string) => E(serviceRef).parse(code),
  });
