/* oxlint-disable */
import { readLine, writeLine } from '@metamask/kernel-node-runtime/daemon';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { kunser } from '@metamask/ocap-kernel';
import * as net from 'node:net';

let rpcId = 0;

function connectToSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.removeListener('error', reject);
      resolve(client);
    });
    client.on('error', reject);
  });
}

async function rpc(socketPath, method, params) {
  const socket = await connectToSocket(socketPath);
  try {
    rpcId++;
    const request = {
      jsonrpc: '2.0',
      id: String(rpcId),
      method,
      ...(params === undefined ? {} : { params }),
    };
    await writeLine(socket, JSON.stringify(request, (_k, v) => typeof v === 'bigint' ? String(v) : v));
    const responseLine = await readLine(socket);
    return JSON.parse(responseLine);
  } finally {
    socket.destroy();
  }
}

async function callVat(socketPath, target, method, args = []) {
  const response = await rpc(socketPath, 'queueMessage', [target, method, args]);
  if (response.error) {
    throw new Error(`RPC error: ${response.error.message || JSON.stringify(response.error)}`);
  }
  await waitUntilQuiescent();
  return kunser(response.result);
}

async function callVatExpectError(socketPath, target, method, args = []) {
  const response = await rpc(socketPath, 'queueMessage', [target, method, args]);
  if (response.error) {
    return response.error.message;
  }
  await waitUntilQuiescent();
  throw new Error(`Expected error but call succeeded: ${JSON.stringify(response.result)}`);
}

/**
 * Create a daemon client bound to a socket path.
 */
export function makeDaemonClient(socketPath) {
  return {
    rpc: (method, params) => rpc(socketPath, method, params),
    callVat: (target, method, args) => callVat(socketPath, target, method, args),
    callVatExpectError: (target, method, args) => callVatExpectError(socketPath, target, method, args),
  };
}
