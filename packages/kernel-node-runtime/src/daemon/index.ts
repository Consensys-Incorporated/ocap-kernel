export { assertSupportedPlatform } from '../platform.ts';
export { startDaemon } from './start-daemon.ts';
export type { StartDaemonOptions, DaemonHandle } from './start-daemon.ts';
export { startRpcSocketServer, DEV_ONLY_METHODS } from './rpc-socket-server.ts';
export type { RpcSocketServerHandle } from './rpc-socket-server.ts';
export { deleteDaemonState } from './delete-daemon-state.ts';
export type { DeleteDaemonStateOptions } from './delete-daemon-state.ts';
export { readLine, writeLine } from './socket-line.ts';
