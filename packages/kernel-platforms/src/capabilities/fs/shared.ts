import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import type { MethodGuard } from '@endo/patterns';

import type {
  PathLike,
  SyncPathCaveat,
  ReadFile,
  Access,
  FsConfig,
  FsCapability,
  FsMethodName,
  FsMethods,
} from './types.ts';
import { fsConfigStruct } from './types.ts';
import { makeCapabilitySpecification } from '../../specification.ts';

/**
 * Cross-platform FS operation wrapper with validation
 *
 * @param operation - The underlying operation to wrap
 * @param syncPathCaveat - The caveat to apply to path arguments
 * @returns The operation restricted by the provided caveat
 */
export const makeCaveatedFsOperation = <
  Operation extends (...args: never[]) => Promise<unknown>,
>(
  operation: Operation,
  syncPathCaveat: SyncPathCaveat,
): Operation => {
  return harden(async (...args: Parameters<Operation>) => {
    try {
      // Assuming first argument is always the path
      syncPathCaveat(args[0] as unknown as PathLike);
      // We don't need async caveats yet, but we could await one here.
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Caveat failed';
      throw new Error(`fs.${operation.name}: ${message}`, { cause });
    }
    return operation(...args);
  }) as Operation;
};

// Written out per method rather than via `makeDefaultExo`, whose
// `defaultGuards: 'passable'` leaves an empty guard map: narrowing conjoins a
// delta onto a per-argument guard, so there has to be one to conjoin onto.
const fsMethodGuards: Record<FsMethodName, MethodGuard> = harden({
  readFile: M.callWhen(M.string()).optional(M.any()).returns(M.any()),
  access: M.callWhen(M.string()).optional(M.number()).returns(M.undefined()),
});

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Cross-platform FS capability specification factory
 *
 * @param config - The configuration for the capability specification
 * @param config.makeReadFile - The factory returning a read file operation
 * @param config.makeAccess - The factory returning an access operation
 * @param config.makePathCaveat - Factory function to create path caveats
 * @returns The capability specification
 */
export const makeFsSpecification = ({
  makeReadFile,
  makeAccess,
  makePathCaveat,
}: {
  makeReadFile: () => ReadFile;
  makeAccess: () => Access;
  makePathCaveat: (rootDir: string) => SyncPathCaveat;
}) =>
  makeCapabilitySpecification(
    fsConfigStruct,
    (config: FsConfig): FsCapability => {
      const { rootDir, methods = [] } = config;
      const caveat = makePathCaveat(rootDir);
      const makeOperation = { readFile: makeReadFile, access: makeAccess };

      const guards: Partial<Record<FsMethodName, MethodGuard>> = {};
      const operations: Partial<Record<FsMethodName, FsMethods[FsMethodName]>> =
        {};
      for (const name of methods) {
        guards[name] = fsMethodGuards[name];
        operations[name] = makeCaveatedFsOperation(
          makeOperation[name](),
          caveat,
        );
      }

      return makeExo(
        'Fs',
        M.interface('Fs', guards),
        operations as Partial<FsMethods>,
      );
    },
  );
/* eslint-enable @typescript-eslint/explicit-function-return-type */
