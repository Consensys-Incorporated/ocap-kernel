export { delay } from './delay.ts';
export { makeErrorMatcherFactory } from './errors.ts';
export { makePromiseKitMock } from './promise-kit.ts';
export { fetchMock } from './env/fetch-mock.ts';
export { makeTwoFacedFetchInput } from './fetch-input.ts';
export * from './env/mock-kernel.ts';
export { makeMockMessageTarget } from './postMessage.ts';
export { makeAbortSignalMock } from './abort-signal.ts';

// oxlint-disable-next-line typescript/ban-ts-comment
// @ts-ignore Intermittent browser/Node incompatibility
if (typeof self === 'undefined') {
  // @ts-expect-error Consistent browser/Node incompatibility
  globalThis.self = globalThis;
}
