// Minimal JSON-RPC probe for the ocap JSON-RPC vat.
//
// Connects to the vat's Unix socket. For each URL supplied on the
// command line, sends a `redeemURL` request; if any URLs were supplied,
// follows with a deliberately-invalid `send` to prove the error path
// also works. Prints every request/response pair to stdout.
//
// Usage:
//   node scripts/probe.mjs [SOCKET_PATH] [URL ...]
//
// Defaults SOCKET_PATH to ~/.ocap/ocap-jsonrpc.sock and the URL list to
// empty (which exercises just connection setup).

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const defaultSocket = path.join(
  process.env.OCAP_HOME ?? path.join(os.homedir(), '.ocap'),
  'ocap-jsonrpc.sock',
);

let socketPath = defaultSocket;
let urls = [];
if (args.length > 0) {
  if (args[0].startsWith('/') || args[0].startsWith('.')) {
    socketPath = args[0];
    urls = args.slice(1);
  } else {
    urls = args;
  }
}

/**
 * Connect a client socket, resolving once connected.
 *
 * @param {string} target - Filesystem path of the Unix socket.
 * @returns {Promise<net.Socket>} The connected socket.
 */
function connectSocket(target) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(target);
    client.once('connect', () => resolve(client));
    client.once('error', reject);
  });
}

/**
 * Send one JSON-RPC request over `socket` and await the next line of
 * response. The vat's protocol is strictly request/reply on a single
 * stream, so this simple wait-for-one-line loop is safe as long as
 * callers issue requests serially.
 *
 * @param {net.Socket} socket - The connected socket.
 * @param {object} request - The JSON-RPC request envelope.
 * @returns {Promise<object>} The parsed response envelope.
 */
function callOnce(socket, request) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    /**
     * Detach both listeners so we don't double-fire on the socket.
     */
    const detach = () => {
      // oxlint-disable-next-line no-use-before-define
      socket.removeListener('data', onData);
      // oxlint-disable-next-line no-use-before-define
      socket.removeListener('error', onError);
    };
    /**
     * Buffer incoming bytes and resolve on the first complete line.
     *
     * @param {Buffer} chunk - Incoming data.
     */
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline);
      detach();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`bad response line: ${line}`));
      }
    };
    /**
     * Propagate socket errors as promise rejection.
     *
     * @param {Error} cause - Socket error.
     */
    const onError = (cause) => {
      detach();
      reject(cause);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

const socket = await connectSocket(socketPath);
process.stderr.write(`connected to ${socketPath}\n`);

let firstRef;
let nextId = 1;
for (const url of urls) {
  const req = {
    jsonrpc: '2.0',
    id: nextId,
    method: 'redeemURL',
    params: { url },
  };
  nextId += 1;
  process.stdout.write(`→ ${JSON.stringify(req)}\n`);
  const reply = await callOnce(socket, req);
  process.stdout.write(`← ${JSON.stringify(reply)}\n`);
  if (firstRef === undefined && typeof reply?.result === 'string') {
    firstRef = reply.result;
  }
}

if (urls.length > 0) {
  const sendRequest = {
    jsonrpc: '2.0',
    id: nextId,
    method: 'send',
    params: {
      target: firstRef ?? '@@j1',
      method: '__nonexistent_method__',
      args: [],
    },
  };
  process.stdout.write(`→ ${JSON.stringify(sendRequest)}\n`);
  const sendReply = await callOnce(socket, sendRequest);
  process.stdout.write(`← ${JSON.stringify(sendReply)}\n`);
}

socket.destroy();
