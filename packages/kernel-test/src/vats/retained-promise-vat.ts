import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

type Store = {
  init: (key: string, value: unknown) => void;
  get: (key: string) => unknown;
};

declare const VatData: {
  makeScalarBigMapStore: (label: string) => Store;
};

type Peer = {
  hold: (promise: Promise<unknown>) => string;
  awaitHeld: () => Promise<unknown>;
  passHeldTo: (target: Peer) => Promise<unknown>;
  take: (promise: Promise<unknown>) => Promise<unknown>;
};

/**
 * A vat that keeps an imported promise in virtual data, where liveslots keeps
 * its vpid registered after the promise settles.
 *
 * @returns The root object.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject() {
  const store = VatData.makeScalarBigMapStore('held');

  return makeDefaultExo('root', {
    async bootstrap(vats: { bob: Peer; carol: Peer }) {
      let resolve: ((value: unknown) => void) | undefined;
      const promise = new Promise((resolver) => {
        resolve = resolver;
      });
      await E(vats.bob).hold(promise);
      resolve?.('hi');
      // Bob has been notified of the resolution once this returns.
      await E(vats.bob).awaitHeld();
      return E(vats.bob).passHeldTo(vats.carol);
    },

    hold(promise: Promise<unknown>) {
      store.init('p', promise);
      return 'held';
    },

    async awaitHeld() {
      return store.get('p');
    },

    async passHeldTo(target: Peer) {
      return E(target).take(store.get('p') as Promise<unknown>);
    },

    async take(promise: Promise<unknown>) {
      return promise;
    },
  });
}
