# OCAP Kernel Usage Guide

The OCAP Kernel is a powerful object capability-based system that enables secure, isolated execution of JavaScript code in vats (similar to secure sandboxes). This guide will help you understand how to set up, configure, and use the OCAP Kernel.

## Table of Contents

- [Setting Up the Kernel](#setting-up-the-kernel)
  - [Browser Environment](#browser-environment)
  - [Node.js Environment](#nodejs-environment)
- [Vat Bundles](#vat-bundles)
- [Cluster Configuration](#cluster-configuration)
- [Kernel API](#kernel-api)
- [Identity Backup and Recovery](#identity-backup-and-recovery)
- [Common Use Cases](#common-use-cases)
- [Endo Integration](#endo-integration)
- [Development Tools](#development-tools)
  - [API Documentation](#api-documentation)
  - [CLI Tools](#cli-tools)
  - [Testing](#testing)
  - [Debugging](#debugging)
- [End-to-End Testing](#end-to-end-testing)
- [Implementation Example](#implementation-example)

## Setting Up the Kernel

To initialize the OCAP Kernel, you need the following components:

1. A platform services implementation (browser or Node.js)
2. A kernel database for state persistence

### Browser Environment

Here's a basic example for browser environments:

```typescript
import { Kernel } from '@metamask/ocap-kernel';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/wasm';
import { PlatformServicesClient } from '@metamask/kernel-browser-runtime';

// Initialize kernel dependencies
const platformServices = await PlatformServicesClient.make(globalThis);
const kernelDatabase = await makeSQLKernelDatabase({
  dbFilename: 'store.db',
});

// Initialize the kernel - it's ready to use immediately
const kernel = await Kernel.make(platformServices, kernelDatabase, {
  resetStorage: false, // Set to true to reset storage on startup
});
```

#### Configuring Remote Comms for Workers

When creating kernel workers with relay and other remote comms options, use the utilities from `@metamask/kernel-browser-runtime`:

```typescript
import {
  createCommsQueryString,
  getCommsParamsFromCurrentLocation,
} from '@metamask/kernel-browser-runtime';

// Define relay addresses and other RemoteCommsOptions (allowedWsHosts, maxQueue, directListenAddresses, etc.)
const commsParams = {
  relays: [
    '/ip4/127.0.0.1/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc',
  ],
  allowedWsHosts: ['localhost'],
};

// Build worker URL with query string (createCommsQueryString returns URLSearchParams)
const workerUrlParams = createCommsQueryString(commsParams);
workerUrlParams.set('reset-storage', 'false'); // append other params as needed
const workerUrl = new URL('kernel-worker.js', import.meta.url);
workerUrl.search = workerUrlParams.toString();
const worker = new Worker(workerUrl, { type: 'module' });

// Inside the worker, retrieve all comms options and init
const options = getCommsParamsFromCurrentLocation();
await kernel.initRemoteComms(options);
```

### Node.js Environment

For Node.js environments, you can use the provided utility function:

```typescript
import { makeKernel } from '@metamask/kernel-node-runtime';
import { MessageChannel } from 'node:worker_threads';

// Create a message channel for kernel communication
const { port1: kernelPort } = new MessageChannel();

// Initialize the kernel with Node.js-specific components
const kernel = await makeKernel({
  port: kernelPort,
  workerFilePath: './path/to/vat-worker.js', // Optional: Path to worker implementation
  resetStorage: false, // Optional: Reset storage on startup
  dbFilename: 'store.db', // Optional: Database file location
});
```

Alternatively, you can manually set up the Node.js components:

```typescript
import { Kernel } from '@metamask/ocap-kernel';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';

// Initialize kernel database with Node.js SQLite implementation
const kernelDatabase = await makeSQLKernelDatabase({
  dbFilename: 'store.db',
});

// Initialize platform services for Node.js
const platformServices = new NodejsPlatformServices();

// Create and start the kernel
const kernel = await Kernel.make(platformServices, kernelDatabase, {
  resetStorage: false,
});
```

## Vat Bundles

Vats execute JavaScript code bundled into a specific format. To create a vat bundle:

1. Write your vat code with a root object that exports methods
2. Bundle the code using the `@metamask/kernel-cli` with `yarn ocap bundle ./path/to/vat.js`

Example vat code:

```javascript
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

/**
 * Build function for a vat.
 *
 * @param {object} vatPowers - Special powers granted to this vat.
 * @param {object} parameters - Initialization parameters from the vat's config.
 * @param {object} _baggage - Root of vat's persistent state.
 * @returns {object} The root object for the new vat.
 */
export function buildRootObject(vatPowers, parameters, _baggage) {
  const { name } = parameters;

  return makeDefaultExo('root', {
    greet() {
      return `Greeting from ${name}`;
    },

    async processMessage(message) {
      return `${name} processed: ${message}`;
    },
  });
}
```

## Cluster Configuration

Vats are organized into clusters, which are defined using a configuration object. A cluster configuration specifies:

1. Which vats to launch
2. Where to find their bundles
3. Parameters to pass to each vat
4. The bootstrap vat (entry point)

Example cluster configuration:

```json
{
  "bootstrap": "alice",
  "forceReset": true,
  "vats": {
    "alice": {
      "bundleSpec": "http://localhost:3000/sample-vat.bundle",
      "parameters": {
        "name": "Alice"
      }
    },
    "bob": {
      "bundleSpec": "http://localhost:3000/sample-vat.bundle",
      "parameters": {
        "name": "Bob"
      }
    }
  }
}
```

The `bundleSpec` can be:

- A URL to a bundle file (e.g., `http://localhost:3000/sample-vat.bundle`)
- A file path for Node.js (e.g., `file:///path/to/sample-vat.bundle`)
- A data URL containing the bundle content

A vat can also request host/Web API globals (timers, `Date`, `crypto`, `URL`, …) via the `globals` field. SES Compartments do not expose these by default, so anything the vat needs must be named explicitly:

```json
{
  "bootstrap": "alice",
  "vats": {
    "alice": {
      "bundleSpec": "http://localhost:3000/sample-vat.bundle",
      "globals": ["setTimeout", "clearTimeout", "Date", "crypto"]
    }
  }
}
```

Network access is not a global. A vat is granted the `http` platform capability scoped to some domains, and wraps it as a `fetch` with `makeFetch` from `@metamask/kernel-platforms`, which needs the `URL`, `Request`, `Headers`, and `Response` globals:

```json
{
  "bootstrap": "alice",
  "vats": {
    "alice": {
      "bundleSpec": "http://localhost:3000/sample-vat.bundle",
      "globals": ["URL", "Request", "Headers", "Response"],
      "platformConfig": {
        "http": { "hosts": ["api.example.com"] }
      }
    }
  }
}
```

See [Vat Endowments](./kernel-guide.md#vat-endowments) in the kernel guide for the full list and for how to narrow the set with `Kernel.make({ allowedGlobalNames })`.

## Kernel API

The kernel exposes several methods for managing vats and sending messages:

### Launching Vats and Clusters

```typescript
// Launch a cluster of vats (individual vat launching is not directly exposed)
const result = await kernel.launchSubcluster(clusterConfig);

// Reload a subcluster (terminates and restarts all its vats)
const newSubcluster = await kernel.reloadSubcluster(subclusterId);

// Terminate a subcluster and all its vats
await kernel.terminateSubcluster(subclusterId);
```

### Sending Messages

```typescript
// Get a vat's root Ref object from the store with vatId
const target = kernelStore.getRootObject(vatId);
// Queue a message to a vat
const result = await kernel.queueMessage(
  target, // Object reference
  'greet', // Method name
  [], // Arguments
);

// Parse the result
import { kunser } from '@metamask/ocap-kernel';
const parsedResult = kunser(result);
```

### Vat Management

Standard API methods:

```typescript
// Ping a vat
await kernel.pingVat(vatId);

// Terminate a specific vat
await kernel.terminateVat(vatId);

// Restart a specific vat
await kernel.restartVat(vatId);
```

### Remote Communications

The `initRemoteComms` method enables peer-to-peer communication between kernels using libp2p relay servers. This allows kernels to communicate across different machines or networks, even when behind NATs or firewalls.

```typescript
//... initialize kernel

// Initialize remote communications with relay servers
const relays = [
  '/ip4/127.0.0.1/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc',
];
await kernel.initRemoteComms({ relays });

//... launch subcluster

// The kernel can now:
// - Connect to other kernels through the relay
// - Accept incoming connections from remote kernels
// - Exchange messages with remote vats
```

**Note:** Relay addresses must be libp2p multiaddrs that include the relay server's peer ID. For browser environments, only WebSocket transports (`/ws`) are supported.

After initialization, you can check the remote communications status via `getStatus()`:

```typescript
const status = await kernel.getStatus();
// status.remoteComms will contain:
// { isInitialized: true, peerId: '12D3KooW...' } if initialized
// { isInitialized: false } if not initialized
```

## Identity Backup and Recovery

The kernel supports BIP39 mnemonic phrases for backing up and recovering kernel identity. This enables users to restore their kernel's peer ID on a new device.

```typescript
import { generateMnemonic, isValidMnemonic } from '@metamask/ocap-kernel';

// Generate a mnemonic for the user to back up BEFORE initializing
const mnemonic = generateMnemonic();
// Display mnemonic to user for secure storage...

// Initialize kernel with the mnemonic
const kernel = await Kernel.make(platformServices, db, { mnemonic });
await kernel.initRemoteComms({ relays });

// Later, recover identity on a new device using the same mnemonic
const kernel = await Kernel.make(platformServices, db, {
  resetStorage: true,
  mnemonic: 'user provided recovery phrase...',
});
```

For detailed documentation on backup and recovery procedures, see the [Identity Backup and Recovery Guide](./identity-backup-recovery.md).

### State and Configuration

```typescript
// Get current status (includes vats, subclusters, and remote comms info)
const status = await kernel.getStatus();
// Returns: {
//   vats: Array of { id, config, subclusterId }
//   subclusters: Array of { id, config, vats }
//   remoteComms: { isInitialized, peerId? }
// }

// Get information about subclusters
const subclusters = kernel.getSubclusters();
const subcluster = kernel.getSubcluster(subclusterId);

// Check vat-subcluster relationships
const isInSubcluster = kernel.isVatInSubcluster(vatId, subclusterId);
const vatIds = kernel.getSubclusterVats(subclusterId);
```

### Testing and Debugging Methods

The following methods are intended for testing and debugging purposes only:

```typescript
// Pin an object to prevent garbage collection
await kernel.pinVatRoot(vatId);

// Unpin an object to allow garbage collection
await kernel.unpinVatRoot(vatId);

// Clear kernel storage
await kernel.clearStorage();

// Reset the kernel (stops all vats and resets state)
await kernel.reset();

// Terminate all running vats
await kernel.terminateAllVats();

// Reload the last launched subcluster configuration
await kernel.reload();

// Run garbage collection
kernel.collectGarbage();
```

## Common Use Cases

### Creating a New Vat

1. Write your vat code
2. Bundle it with `yarn ocap bundle ./path/to/vat.js`
3. Create a vat configuration
4. Launch the vat with `kernel.launchVat()`

### Communication Between Vats

1. Get a reference to an object in another vat
2. Send messages to that reference using `kernel.queueMessage()`
3. Handle responses in your vat code

### Persistence

The kernel automatically persists state using the provided database. Vats can use **baggage** (persistent key-value storage) to manage their own durable state across restarts. See [Baggage (Persistent State)](./kernel-guide.md#baggage-persistent-state) in the Kernel Guide for details and examples.

## Endo Integration

The OCAP Kernel builds on the [Endo project](https://github.com/endojs/endo), which provides core object capability patterns and tools. Understanding these fundamental concepts is essential for effective vat development.

For in-depth coverage of writing vat code, kernel services, system subclusters, and persistence patterns, see the [Kernel Guide](./kernel-guide.md).

### Object Capability Model

Vats use Endo's implementation of the object capability security model through `makeDefaultExo` to create shareable objects:

```javascript
import { makeDefaultExo } from '@metamask/kernel-utils/exo';

/**
 * Build function for a vat.
 *
 * @param {object} vatPowers - Special powers granted to this vat.
 * @param {object} parameters - Initialization parameters from the vat's config.
 * @param {object} _baggage - Root of vat's persistent state.
 * @returns {object} The root object for the new vat.
 */
export function buildRootObject(vatPowers, parameters, _baggage) {
  const { name } = parameters;

  // Helper function for logging
  function log(message) {
    console.log(`${name}: ${message}`);
  }

  // Creating a capability-based service object
  const service = makeDefaultExo('service', {
    getData() {
      log('getData called');
      return { value: 'some data' };
    },
  });

  // The root object must be created with makeDefaultExo
  return makeDefaultExo('root', {
    getService() {
      return service;
    },

    bootstrap() {
      log('bootstrap called');
      return 'bootstrap complete';
    },
  });
}
```

### Eventual Sends

Vats communicate asynchronously using the `E()` notation for eventual sends:

```javascript
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import { E } from '@endo/eventual-send';

// In another vat that wants to use the service
export function buildRootObject(vatPowers, parameters, _baggage) {
  return makeDefaultExo('root', {
    async useRemoteService(serviceProvider) {
      // Get a reference to the service
      const service = await E(serviceProvider).getService();

      // Call a method on the remote service
      const data = await E(service).getData();

      return data;
    },
  });
}
```

### Further Resources

For more detailed information about the technology underlying the OCAP Kernel:

- [Notes On The Design Of An Ocap Kernel](https://github.com/Consensys-Incorporated/ocap-kernel/wiki/Notes-On-The-Design-Of-An-Ocap-Kernel)
- [Endo Documentation](https://github.com/endojs/endo/blob/master/README.md)
- [SES (Secure ECMAScript)](https://github.com/endojs/endo/tree/master/packages/ses)
- [Endo Marshal](https://github.com/endojs/endo/tree/master/packages/marshal)
- [Object Capability Model](https://en.wikipedia.org/wiki/Object-capability_model)
- [Agoric Documentation](https://docs.agoric.com/) (Endo is based on technology developed for Agoric)

## Development Tools

The OCAP Kernel project includes several useful tools for development:

### API Documentation

The project uses TypeDoc to generate API documentation from source code comments. To build and view the API documentation:

```bash
# Build documentation for all packages
yarn build:docs

# Build documentation for a specific package
yarn workspace @metamask/ocap-kernel build:docs
```

This will generate documentation in the `docs` directory of each package. To view the documentation:

1. Navigate to the `docs` directory of the desired package
2. Open `index.html` in your browser

For a comprehensive overview of the API:

2. Review the TypeDoc-generated documentation for detailed API references
   - This currently has to be built locally using `yarn build:docs`.
3. Check the test files (e.g., `*.test.ts`) for usage examples

### CLI Tools

The `@metamask/kernel-cli` package provides tools for working with vat bundles:

```bash
# Bundle a vat file
yarn ocap bundle ./path/to/vat.js

# Run a local development server for testing
yarn ocap serve ./path/to/bundles
```

### Testing

For testing vats and kernel integration, the project uses Vitest:

```typescript
import { makeKernel } from '@metamask/kernel-node-runtime';
import { MessageChannel } from 'node:worker_threads';
import { describe, it, expect } from 'vitest';

describe('My vat tests', () => {
  it('should process messages correctly', async () => {
    // Set up a test kernel
    const { port1: kernelPort } = new MessageChannel();
    const kernel = await makeKernel({
      port: kernelPort,
      resetStorage: true,
      dbFilename: ':memory:',
    });

    // Launch your test vat
    const vatId = await kernel.launchVat({
      bundleSpec: 'file:///path/to/test-vat.bundle',
      parameters: { testMode: true },
    });

    // Send a test message
    const rootRef = kernel.getRootObject(vatId);
    const result = await kernel.queueMessage(rootRef, 'testMethod', [
      'test arg',
    ]);

    // Verify the result
    expect(result).toStrictEqual(expectedResult);
  });
});
```

### Debugging

For debugging issues with vats or message passing:

1. Enable verbose logging in your vats using `vatPowers.stdout()`
2. Use the kernel's status API to check the state: `const status = await kernel.getStatus()`
3. For persistent data issues, examine the database directly: `const result = kernelDatabase.executeQuery('SELECT * FROM kv')`

## End-to-End Testing

The project includes end-to-end tests using Playwright to test the extension and kernel integration in a real browser environment:

```bash
# Navigate to extension package
cd packages/extension

# 1. Bundle vats first (required for all test commands)
yarn ocap bundle ./src/vats

# 2. For yarn test:e2e, you must also serve the vats in a separate terminal
yarn ocap serve ./src/vats

# 3. Then run E2E tests
yarn test:e2e

# Run E2E tests with UI (also requires the vats to be served)
yarn test:e2e:ui

# ALTERNATIVELY: Use the CI command which bundles vats, serves them, and runs tests in one step
yarn test:e2e:ci
```

When running tests with the UI mode (`test:e2e:ui`), you can:

1. Watch tests execute in real-time in a browser window
2. See test steps and assertions as they happen
3. Explore the DOM and application state at each step
4. Debug test failures visually

The E2E tests demonstrate complete kernel workflows including:

- Extension initialization
- Launching vats
- Message passing between vats
- UI interaction with the kernel control panel

To view test reports after execution:

```bash
# Open the HTML test report
open playwright-report/index.html
```

## Implementation Example

Here's a complete example of implementing the OCAP Kernel in both browser and Node.js environments:

### Browser Implementation

```typescript
import { Kernel, ClusterConfigStruct } from '@metamask/ocap-kernel';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/wasm';
import { fetchValidatedJson } from '@metamask/kernel-utils';
import { PlatformServicesClient } from '@metamask/kernel-browser-runtime';

async function initBrowserKernel() {
  // Create client end of the platform services
  const platformServices = await PlatformServicesClient.make(globalThis);

  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename: 'store.db',
  });

  // Initialize the kernel
  return await Kernel.make(platformServices, kernelDatabase, {
    resetStorage: true, // For development purposes
  });
}

// Usage:
async function run() {
  const kernel = await initBrowserKernel();

  // Launch a cluster
  const clusterConfig = await fetchValidatedJson(
    'path/to/cluster-config.json',
    ClusterConfigStruct,
  );

  const result = await kernel.launchSubcluster(clusterConfig);
  console.log(`Subcluster launched: ${JSON.stringify(result)}`);
}
```

### Node.js Implementation

```typescript
import { makeKernel } from '@metamask/kernel-node-runtime';
import { ClusterConfigStruct } from '@metamask/ocap-kernel';
import { MessageChannel } from 'node:worker_threads';
import fs from 'node:fs/promises';

async function initNodeKernel() {
  // Create a message channel for kernel communication
  const { port1: kernelPort } = new MessageChannel();

  // Initialize the kernel with Node.js-specific components
  return await makeKernel({
    port: kernelPort,
    workerFilePath: './path/to/vat-worker.js',
    resetStorage: true, // For development purposes
    dbFilename: ':memory:', // Use in-memory database for testing
  });
}

// Usage:
async function run() {
  const kernel = await initNodeKernel();

  // Load cluster configuration
  const configRaw = await fs.readFile('./path/to/cluster-config.json', 'utf8');
  const clusterConfig = ClusterConfigStruct.check(JSON.parse(configRaw));

  // Launch the cluster
  const result = await kernel.launchSubcluster(clusterConfig);
  console.log(`Subcluster launched: ${JSON.stringify(result)}`);
}

run().catch(console.error);
```

This pattern of initializing the kernel and then using it to launch clusters and send messages is consistent across both environments. The main differences are in the initialization steps and dependencies used.
