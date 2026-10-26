import 'vitest';

declare module 'vitest' {
  // Declaration merging needs an interface.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  export interface ProvidedContext {
    /** Where `global-setup.ts` collects this run's reports. */
    performanceRunDir: string;
  }
}
