# Ocap Kernel Guide for Host Application Developers

This document explains the parts of the ocap kernel that are relevant to building services and vats in a host application. It is intended for an agent or developer who needs to register kernel services, write vat code, and wire up system subclusters — without needing to understand the kernel's internals.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [The Kernel API](#the-kernel-api)
3. [Writing Vat Code](#writing-vat-code)
4. [Vat Endowments](#vat-endowments)
5. [Kernel Services](#kernel-services)
6. [System Subclusters](#system-subclusters)
7. [Eventual Send with E()](#eventual-send-with-e)
8. [Exos (Remotable Objects)](#exos-remotable-objects)
9. [Baggage (Persistent State)](#baggage-persistent-state)
10. [Revocation](#revocation)
11. [Glossary and Key Types](#glossary-and-key-types)

---

## Core Concepts

The **kernel** is a centralized manager of **vats** and **distributed objects**. It routes messages between vats, manages object references, handles persistence, and performs garbage collection.

A **vat** is an isolated unit of computation — think of it as a worker process. User code runs inside vats. Vats communicate with each other and with the kernel through asynchronous message passing. You never call methods on objects in other vats directly; you use `E()` (eventual send) to queue messages.

A **subcluster** is a logically related group of vats that are launched together. When you launch a subcluster, all its vats start, and then the **bootstrap vat** receives references to the other vats and to any **kernel services** the subcluster requested.

A **system subcluster** is a subcluster declared at kernel startup time. System subclusters can access privileged services (marked `systemOnly`) that regular subclusters cannot.

A **kernel service** is an object registered with the kernel that vats can call via `E()`. Services run outside of vats — they execute in the kernel's own context. Examples include the kernel facet (privileged kernel operations) and IO services.

A **kref** (kernel reference) is a string like `ko42` that uniquely identifies an object within the kernel. Krefs are the kernel's internal addressing system. When a vat exports an object or receives a reference to one, the kernel assigns and tracks krefs.

An **exo** is a remotable object created with `makeDefaultExo()` (or the lower-level `@endo/exo` APIs). Exos are the standard way to create objects that can be passed between vats, stored in baggage, and invoked via `E()`.

---

## The Kernel API

The kernel is instantiated by the host application via `Kernel.make()`:

```ts
import { Kernel } from '@metamask/ocap-kernel';

const kernel = await Kernel.make(platformServices, kernelDatabase, {
  logger,
  systemSubclusters: [{ name: 'my-system', config: clusterConfig }],
});
```

### Key methods on the Kernel instance

| Method                                                | Description                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `registerKernelServiceObject(name, object, options?)` | Register a kernel service that vats can call via `E()`.                                 |
| `launchSubcluster(config)`                            | Launch a new subcluster of vats. Returns `{ subclusterId, rootKref, bootstrapResult }`. |
| `terminateSubcluster(subclusterId)`                   | Terminate a subcluster and all its vats.                                                |
| `queueMessage(target, method, args)`                  | Send a message to a kernel object (identified by kref).                                 |
| `getStatus()`                                         | Get current kernel status (vats, subclusters, remote comms state).                      |
| `revoke(kref)`                                        | Revoke an object. Any future `E()` calls to it will fail.                               |
| `isRevoked(kref)`                                     | Check if an object has been revoked.                                                    |
| `getPresence(kref, iface?)`                           | Convert a kref string to a slot value (presence) for use in messages.                   |
| `stop()`                                              | Gracefully stop the kernel.                                                             |
| `reset()`                                             | Stop all vats and reset kernel state (debugging only).                                  |

---

## Writing Vat Code

Every vat exports a `buildRootObject` function. This is the entry point for the vat's code.

```ts
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage } from '@metamask/ocap-kernel';

export function buildRootObject(
  vatPowers: unknown,
  parameters: Record<string, unknown>,
  baggage: Baggage,
) {
  return makeDefaultExo('root', {
    async bootstrap(
      vats: Record<string, unknown>,
      services: Record<string, unknown>,
    ): Promise<void> {
      // Called once when the subcluster is first launched.
      // `vats` contains references to other vats in the subcluster.
      // `services` contains references to kernel services requested in the cluster config.
    },

    async myMethod(arg: string): Promise<string> {
      return `hello ${arg}`;
    },
  });
}
```

### The three arguments

1. **`vatPowers`** — Special powers provided to the vat (e.g., a logger). Contents vary by vat configuration.
2. **`parameters`** — Static parameters from the vat's config (`VatConfig.parameters`). Useful for passing configuration like names or settings.
3. **`baggage`** — Persistent key-value storage that survives vat restarts. See [Baggage](#baggage-persistent-state).

### The bootstrap method

The `bootstrap` method is called exactly once when the subcluster is first launched. It receives:

- **`vats`** — A record mapping vat names to their root object references. Use `E()` to call methods on them.
- **`services`** — A record mapping service names to kernel service references. Use `E()` to call methods on them.

```ts
async bootstrap(
  vats: { alice: unknown; bob: unknown },
  services: { kernelFacet: unknown; myService: unknown },
): Promise<void> {
  // Store service references in baggage for use after restart
  baggage.init('kernelFacet', services.kernelFacet);

  // Communicate with other vats
  const greeting = await E(vats.alice).hello('world');
}
```

After a vat restart (resuscitation), `bootstrap` is **not** called again. The vat must restore its state from baggage.

---

## Vat Endowments

SES Compartments do not expose host or Web APIs by default — `setTimeout`, `Date.now()`, `crypto`, `Math.random()`, `URL`, and friends are either absent or deliberately tamed (e.g., `Date.now()` and `Math.random()` throw in secure mode). Vats that need them must request them explicitly through the `globals` field on their `VatConfig`.

### Requesting endowments from a vat

Name the host/Web APIs the vat needs in its cluster config:

```ts
await kernel.launchSubcluster({
  bootstrap: 'worker',
  vats: {
    worker: {
      bundleSpec: '...',
      parameters: {},
      globals: ['setTimeout', 'clearTimeout', 'Date', 'crypto', 'URL'],
    },
  },
});
```

Only names in the vat's `globals` array are installed in the vat's compartment. Names not in the kernel's allowed set cause `initVat` to fail with `Vat "<id>" requested unknown global "<name>"`.

### Default allowed globals

The kernel ships with the following set, sourced from `@metamask/snaps-execution-environments`:

| Name              | Category             | Notes                                                                                                                                                                                                         |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setTimeout`      | Timer (attenuated)   | Isolated per vat. Cancelled automatically on vat termination.                                                                                                                                                 |
| `clearTimeout`    | Timer (attenuated)   | Only clears timers created by the same vat.                                                                                                                                                                   |
| `setInterval`     | Timer (attenuated)   | Isolated per vat. Cancelled automatically on vat termination.                                                                                                                                                 |
| `clearInterval`   | Timer (attenuated)   | Only clears intervals created by the same vat.                                                                                                                                                                |
| `Date`            | Attenuated           | Each `Date.now()` read adds up to 1 ms of random jitter, clamped monotonic non-decreasing; precise sub-millisecond timing cannot leak through.                                                                |
| `Math`            | Attenuated           | `Math.random()` is sourced from `crypto.getRandomValues`. **Not a CSPRNG** per the upstream NOTE — defends against stock-RNG timing side channels only.                                                       |
| `crypto`          | Web Crypto           | Hardened Web Crypto API.                                                                                                                                                                                      |
| `SubtleCrypto`    | Web Crypto           | Hardened Web Crypto API.                                                                                                                                                                                      |
| `fetch`           | Network (attenuated) | Wrapped by the Snaps network factory; teardown aborts in-flight requests and cancels open body streams on vat termination. **Requires `network.allowedHosts`** — see [Network endowment](#network-endowment). |
| `Request`         | Network              | Hardened constructor surfaced alongside `fetch` so vat code can build requests before calling it.                                                                                                             |
| `Headers`         | Network              | Hardened constructor.                                                                                                                                                                                         |
| `Response`        | Network              | Hardened constructor; overrides `[Symbol.hasInstance]` so wrapped fetch results still pass `instanceof Response`.                                                                                             |
| `URL`             | URL                  | Plain hardened.                                                                                                                                                                                               |
| `URLSearchParams` | URL                  | Plain hardened.                                                                                                                                                                                               |
| `atob`            | Base64               | Plain hardened.                                                                                                                                                                                               |
| `btoa`            | Base64               | Plain hardened.                                                                                                                                                                                               |
| `AbortController` | Abort                | Plain hardened.                                                                                                                                                                                               |
| `AbortSignal`     | Abort                | Plain hardened.                                                                                                                                                                                               |

"Plain hardened" means the value is the host's implementation wrapped with `harden()` — it behaves identically to the browser/Node version. "Attenuated" means the value is a deliberate reimplementation with different semantics; the Notes column flags the relevant differences. The canonical list lives in [`endowments.ts`](../packages/ocap-kernel/src/vats/endowments.ts).

`TextEncoder` and `TextDecoder` are absent from the table because SES permits them in every compartment, so they are not endowments and naming them in `globals` fails like any other unknown global. The same goes for JS intrinsics such as `ArrayBuffer` and `Intl`. The exceptions are `Float16Array`, `Float32Array`, and `Float64Array`, which SES withholds from compartments to close a `NaN` bit-pattern side channel and which the kernel therefore cannot endow; use `DataView` instead.

### Network endowment

`fetch`, `Request`, `Headers`, and `Response` are only available when the vat also declares a per-vat host allowlist in `VatConfig.network.allowedHosts`:

```ts
await kernel.launchSubcluster({
  bootstrap: 'worker',
  vats: {
    worker: {
      bundleSpec: '...',
      globals: ['fetch', 'Request', 'Headers', 'Response'],
      network: { allowedHosts: ['api.example.com', 'api.github.com'] },
    },
  },
});
```

Requesting `'fetch'` without an `allowedHosts` entry (or with an absent `network` block) fails `initVat` with `Vat "<id>" requested "fetch" but no network.allowedHosts was specified`. There is no implicit allow-all; an empty `allowedHosts: []` is legal but rejects every outbound host. Host matching is a case-sensitive exact comparison against `URL.hostname` — ports and schemes are not considered, so `allowedHosts: ['api.example.com']` accepts both `http://api.example.com` and `https://api.example.com:8443`. `file://` URLs are **rejected** by fetch — use the `fs` platform capability for filesystem access.

Lifecycle notes:

- The network factory reads `globalThis.fetch` at call time — host applications that need to stub it (e.g., tests) should override the global before constructing the `VatSupervisor`.
- Teardown cancels in-flight requests and open body streams. It runs as part of `VatSupervisor.terminate()` alongside timer teardown.
- `fetch` returns a `ResponseWrapper` rather than the raw `Response`; the endowed `Response` constructor is patched so `instanceof Response` still returns `true` for wrapper instances.

### Restricting or replacing the allowed set

Two levers, applied at different layers:

**1. Kernel-level allowlist via `Kernel.make({ allowedGlobalNames })`.** Restrict the set of globals any vat is permitted to request. Names outside this list cause `initVat` to fail even if the vat asks for them.

```ts
const kernel = await Kernel.make(platformServices, db, {
  allowedGlobalNames: ['URL', 'URLSearchParams'],
});
```

Omit the option to allow the full default set.

**2. Supervisor-level factory via `VatSupervisor({ makeAllowedGlobals })`.** Replace the endowment factory entirely — useful for tests or host applications that need custom attenuations. The factory is invoked once per supervisor and must return `{ globals, teardown }`, where `teardown` releases any resources the custom endowments hold.

```ts
import type { VatEndowments } from '@metamask/ocap-kernel';

const makeAllowedGlobals = (): VatEndowments =>
  harden({
    globals: harden({ Date: globalThis.Date }),
    teardown: async () => undefined,
  });

new VatSupervisor({
  id,
  kernelStream,
  logger,
  makeAllowedGlobals,
});
```

Most host applications should stick with the default `createDefaultEndowments()` factory; override only when you need bespoke attenuations.

---

## Kernel Services

A kernel service is a JavaScript object registered with the kernel. Vats interact with it via `E()` just like any other remote object, but it runs in the kernel's own context (not in a vat).

### Registering a service (host application side)

```ts
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

const myService = makeDefaultExo('myService', {
  async doSomething(arg: string): Promise<string> {
    // This runs in the kernel's context, not in a vat.
    // You have full access to the host application's APIs here.
    return `result: ${arg}`;
  },
});

// Register before launching subclusters that need it
kernel.registerKernelServiceObject('myService', myService);
```

### Registering a system-only service

```ts
kernel.registerKernelServiceObject('privilegedService', serviceObj, {
  systemOnly: true,
});
```

System-only services can only be accessed by system subclusters. Regular subclusters that request them will get an error at launch time.

### Requesting services in a cluster config

Services are requested by name in the `services` array of the cluster config:

```ts
const config: ClusterConfig = {
  bootstrap: 'myVat',
  services: ['myService', 'kernelFacet'],
  vats: {
    myVat: { sourceSpec: './my-vat.ts' },
  },
};
```

The kernel validates that all requested services exist (and are accessible) before launching the subcluster. If validation fails, the launch throws.

### Using a service from vat code

```ts
import { E } from '@endo/eventual-send';

export function buildRootObject(
  _vatPowers: unknown,
  _params: unknown,
  baggage: Baggage,
) {
  let myService: unknown;

  return makeDefaultExo('root', {
    async bootstrap(_vats: unknown, services: { myService: unknown }) {
      myService = services.myService;
      baggage.init('myService', myService); // persist for restarts
    },

    async doWork() {
      const result = await E(myService).doSomething('hello');
      console.log(result); // "result: hello"
    },
  });
}
```

### How service invocation works (overview)

When a vat calls `E(service).method(args)`:

1. The vat issues a **syscall** sending a message to the service's kref.
2. The kernel's **router** recognizes the target as a kernel service (not a vat).
3. The **KernelServiceManager** deserializes the message and calls the method on the service object directly.
4. The result (or error) is resolved as a kernel promise, which is delivered back to the vat as a notification.

This is transparent to the vat — it just looks like a normal `E()` call.

---

## System Subclusters

System subclusters are declared at kernel startup and have special properties:

- They can access `systemOnly` services (like the kernel facet).
- They persist across kernel restarts — the kernel restores them automatically.
- They are identified by a unique name (not just a subcluster ID).
- The host application can retrieve the bootstrap root kref via `kernel.getSystemSubclusterRoot(name)`.

### Declaring a system subcluster

```ts
const kernel = await Kernel.make(platformServices, kernelDatabase, {
  systemSubclusters: [
    {
      name: 'my-system-subcluster',
      config: {
        bootstrap: 'controllerVat',
        services: ['kernelFacet', 'myHostService'],
        vats: {
          controllerVat: {
            sourceSpec: './controller-vat.ts',
            parameters: { name: 'controller' },
          },
        },
      },
    },
  ],
});
```

### The kernel facet

The **kernel facet** is a built-in `systemOnly` service that gives system vats access to privileged kernel operations:

| Method                               | Description                         |
| ------------------------------------ | ----------------------------------- |
| `getStatus()`                        | Get kernel status                   |
| `getSubclusters()`                   | List all subclusters                |
| `getSubcluster(id)`                  | Get a specific subcluster           |
| `launchSubcluster(config)`           | Launch a new subcluster             |
| `terminateSubcluster(id)`            | Terminate a subcluster              |
| `getSystemSubclusterRoot(name)`      | Get a system subcluster's root kref |
| `queueMessage(target, method, args)` | Send a message to any kernel object |
| `getPresence(kref, iface?)`          | Convert a kref to a presence        |
| `pingVat(vatId)`                     | Ping a vat                          |
| `reset()`                            | Reset the kernel (debugging)        |
| `ping()`                             | Returns `'pong'`                    |

Usage from a system vat:

```ts
import { E } from '@endo/eventual-send';

// In bootstrap:
const kernelFacet = services.kernelFacet;

// Later:
const status = await E(kernelFacet).getStatus();
const { subclusterId } = await E(kernelFacet).launchSubcluster(config);
await E(kernelFacet).terminateSubcluster(subclusterId);
```

---

## Eventual Send with E()

`E()` from `@endo/eventual-send` is the standard way to send messages to remote objects (objects in other vats or kernel services). It returns a promise for the result.

```ts
import { E } from '@endo/eventual-send';

// Basic call — always returns a promise
const result = await E(remoteObject).methodName(arg1, arg2);

// Fire-and-forget (don't await)
E(remoteObject).notifyOfSomething(data);

// Error handling
try {
  await E(remoteObject).riskyMethod();
} catch (error) {
  console.error('Remote call failed:', error);
}
```

**Rules:**

- Always use `E()` when calling methods on objects from other vats or kernel services.
- `E()` can also be used on local objects — it just queues the call for the next microtask.
- `E()` can be used on promises that resolve to objects: `E(promise).method()` will wait for the promise to resolve, then send the message.
- Never call methods directly on remote references (e.g., `remoteObject.method()` won't work).

---

## Exos (Remotable Objects)

An **exo** is a remotable object — one that can be passed between vats, stored in baggage, and invoked via `E()`. All objects that participate in the kernel's object capability system must be exos.

### Creating an exo

```ts
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

const myObject = makeDefaultExo('MyObject', {
  greet(name: string): string {
    return `hello ${name}`;
  },

  async fetchData(id: string): Promise<unknown> {
    // async methods work too
    return someAsyncOperation(id);
  },
});
```

The first argument is a **name** (used for debugging and interface identification). The second is an object of methods. `makeDefaultExo` wraps `@endo/exo`'s `makeExo` with permissive default guards (accepting any "passable" arguments).

### Key properties of exos

- **Remotable**: Can be sent to other vats as arguments or return values.
- **Durable**: Can be stored in baggage and survive vat restarts.
- **Hardened**: Exos are automatically frozen/hardened — their methods cannot be modified after creation.
- **Interface-guarded**: Method arguments are validated against an interface guard (default: "passable", which accepts most serializable values).

### Do NOT use `Far()`

This codebase uses `makeDefaultExo` instead of `Far()` from `@endo/far`. Do not use `Far()`.

---

## Baggage (Persistent State)

**Baggage** is a durable key-value store provided to each vat. Data stored in baggage survives vat restarts (resuscitation). Baggage is the primary mechanism for vat state persistence.

### API

```ts
// Check if a key exists
baggage.has('myKey'); // boolean

// Initialize a new key (throws if key already exists)
baggage.init('myKey', value);

// Get a value (throws if key doesn't exist)
baggage.get('myKey'); // unknown — cast to expected type

// Update an existing key (throws if key doesn't exist)
baggage.set('myKey', newValue);

// Delete a key
baggage.delete('myKey');
```

### Common pattern: restore or initialize

```ts
export function buildRootObject(_vp: unknown, _p: unknown, baggage: Baggage) {
  // Restore state from baggage, or initialize if first run
  let counter: number;
  if (baggage.has('counter')) {
    counter = baggage.get('counter') as number;
  } else {
    counter = 0;
    baggage.init('counter', counter);
  }

  // Restore service references from baggage (for resuscitation)
  let myService: unknown = baggage.has('myService')
    ? baggage.get('myService')
    : undefined;

  return makeDefaultExo('root', {
    async bootstrap(_vats: unknown, services: { myService: unknown }) {
      // Only called on first launch, not on restart
      myService = services.myService;
      baggage.init('myService', myService);
    },

    increment(): number {
      counter += 1;
      baggage.set('counter', counter);
      return counter;
    },
  });
}
```

### What can be stored in baggage

- Primitive values (strings, numbers, booleans)
- Hardened plain objects and arrays
- Exos and other remotable objects (including references to objects in other vats)
- **Not** arbitrary class instances, functions, or unhardened objects

---

## Revocation

The kernel supports **revoking** object references. Once revoked, any `E()` call targeting that object will fail.

```ts
// Host application side
kernel.revoke(kref);

// Check revocation status
kernel.isRevoked(kref); // true
```

Revocation is a kernel-level operation. Vats holding a reference to a revoked object will get errors when they try to use it. Revocation is permanent and cannot be undone.

---

## Glossary and Key Types

For definitions of terms used in this guide (kernel, vat, subcluster, exo, baggage, kref, etc.), see the [canonical glossary](./glossary.md).

### Key Types

```ts
// Configuration for launching a group of vats
type ClusterConfig = {
  bootstrap: string; // Name of the bootstrap vat
  forceReset?: boolean; // Force reset of persisted state
  services?: string[]; // Names of kernel services to inject
  io?: Record<string, IOConfig>; // IO channel configurations
  vats: Record<string, VatConfig>; // Vat configurations by name
  bundles?: Record<string, VatConfig>; // Named bundles
};

// Configuration for a single vat (one of these source specs is required)
type VatConfig = {
  sourceSpec?: string; // Path to source file
  bundleSpec?: string; // Path to bundle file
  bundleName?: string; // Name of a pre-registered bundle
  creationOptions?: Record<string, Json>; // Options for vat creation
  parameters?: Record<string, Json>; // Static parameters passed to buildRootObject
  platformConfig?: Partial<PlatformConfig>; // Platform-specific configuration (currently `fs` only)
  globals?: AllowedGlobalName[]; // Host/Web API globals the vat requests — see [Vat Endowments](#vat-endowments)
  network?: { allowedHosts: string[] }; // Host allowlist required when requesting `fetch`
};

// Configuration for a system subcluster
type SystemSubclusterConfig = {
  name: string; // Unique name (used for retrieval)
  config: ClusterConfig; // The cluster configuration
};

// Result of launching a subcluster
type SubclusterLaunchResult = {
  subclusterId: string; // The assigned subcluster ID
  rootKref: KRef; // Kref of the bootstrap vat's root object
  bootstrapResult: CapData<KRef> | undefined; // Return value of bootstrap()
};

// Kernel status
type KernelStatus = {
  vats: { id: VatId; config: VatConfig; subclusterId: string }[];
  subclusters: Subcluster[];
  remoteComms?:
    | { state: 'disconnected' }
    | { state: 'identity-only'; peerId: string }
    | { state: 'connected'; peerId: string; listenAddresses: string[] };
};
```

---

## Complete Example: A System Subcluster with a Custom Service

### Host application side

```ts
import { Kernel } from '@metamask/ocap-kernel';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

// 1. Create a kernel service
const weatherService = makeDefaultExo('weatherService', {
  async getTemperature(city: string): Promise<number> {
    // Call your host application's internal APIs here
    return hostApp.weather.getTemp(city);
  },

  async getForecast(city: string, days: number): Promise<string[]> {
    return hostApp.weather.forecast(city, days);
  },
});

// 2. Create the kernel
const kernel = await Kernel.make(platformServices, db, {
  systemSubclusters: [
    {
      name: 'weather-system',
      config: {
        bootstrap: 'weatherVat',
        services: ['weatherService', 'kernelFacet'],
        vats: {
          weatherVat: {
            sourceSpec: './weather-vat.ts',
            parameters: { defaultCity: 'London' },
          },
        },
      },
    },
  ],
});

// 3. Register the service (must happen before kernel.make resolves,
//    or before any subcluster that uses it is launched)
kernel.registerKernelServiceObject('weatherService', weatherService);

// 4. Interact with the system subcluster's root object
const rootKref = kernel.getSystemSubclusterRoot('weather-system');
const result = await kernel.queueMessage(rootKref, 'getWeatherReport', [
  'Paris',
]);
```

### Vat side (weather-vat.ts)

```ts
import { E } from '@endo/eventual-send';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage } from '@metamask/ocap-kernel';

type WeatherService = {
  getTemperature(city: string): Promise<number>;
  getForecast(city: string, days: number): Promise<string[]>;
};

export function buildRootObject(
  _vatPowers: unknown,
  parameters: { defaultCity?: string },
  baggage: Baggage,
) {
  const defaultCity = parameters.defaultCity ?? 'London';

  let weatherService: WeatherService | undefined = baggage.has('weatherService')
    ? (baggage.get('weatherService') as WeatherService)
    : undefined;

  return makeDefaultExo('root', {
    async bootstrap(
      _vats: unknown,
      services: { weatherService: WeatherService },
    ): Promise<void> {
      weatherService = services.weatherService;
      baggage.init('weatherService', weatherService);
    },

    async getWeatherReport(city?: string): Promise<string> {
      const target = city ?? defaultCity;
      const temp = await E(weatherService!).getTemperature(target);
      const forecast = await E(weatherService!).getForecast(target, 3);
      return `${target}: ${temp}C. Next 3 days: ${forecast.join(', ')}`;
    },
  });
}
```
