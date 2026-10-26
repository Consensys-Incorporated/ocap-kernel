import { E } from '@endo/eventual-send';
import { GET_INTERFACE_GUARD } from '@endo/exo';
import { getInterfaceGuardPayload } from '@endo/patterns';
import type { InterfaceGuard, MethodGuard } from '@endo/patterns';
import { ifDefined } from '@metamask/kernel-utils';

import { makeSection } from './section.ts';
import type { MetadataSpec, Provider } from './types.ts';

/**
 * Wrap a remote (CapTP) reference as a Provider.
 *
 * The sheaf requires synchronous [GET_INTERFACE_GUARD] access on every section,
 * but remote references are opaque CapTP handles that cannot provide this
 * synchronously. This function fetches the guard from the remote via E() once
 * at construction time, then creates a local wrapper exo that carries it and
 * forwards every method call back to the remote via E().
 *
 * @param name - Name for the wrapper exo.
 * @param remoteRef - The remote reference to forward calls to.
 * @param metadata - Optional metadata spec for the provider.
 * @returns A Provider whose exo forwards method calls to the remote.
 */
export const makeRemoteSection = async <M extends Record<string, unknown>>(
  name: string,
  remoteRef: object,
  metadata?: MetadataSpec<M>,
): Promise<Provider<M>> => {
  const interfaceGuard: InterfaceGuard = await (
    E(remoteRef) as unknown as {
      [GET_INTERFACE_GUARD](): Promise<InterfaceGuard>;
    }
  )[GET_INTERFACE_GUARD]();

  const { methodGuards } = getInterfaceGuardPayload(
    interfaceGuard,
  ) as unknown as {
    methodGuards: Record<string, MethodGuard>;
  };

  const remote = remoteRef as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(methodGuards)) {
    handlers[method] = async (...args: unknown[]) =>
      // method is always present: it comes from Object.keys(methodGuards)
      // oxlint-disable-next-line typescript/no-non-null-assertion
      (E(remote) as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        method
      ]!(...args);
  }

  const exo = makeSection(name, interfaceGuard, handlers);
  return ifDefined({ exo, metadata }) as Provider<M>;
};
