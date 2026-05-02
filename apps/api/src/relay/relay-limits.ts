export interface RelayLimitOptions {
  maxMessageBytes?: number;
  maxConnectionsPerRoom?: number;
}

export interface ResolvedRelayLimits {
  maxMessageBytes: number;
  maxConnectionsPerRoom: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS_PER_ROOM = 64;

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveRelayLimits(options: RelayLimitOptions = {}): ResolvedRelayLimits {
  return {
    maxMessageBytes: positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES),
    maxConnectionsPerRoom: positiveInteger(options.maxConnectionsPerRoom, DEFAULT_MAX_CONNECTIONS_PER_ROOM),
  };
}

export function relayRawDataByteLength(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + relayRawDataByteLength(chunk), 0);
  return Buffer.byteLength(String(data), 'utf8');
}

export function assertRelayMessageBytes(data: unknown, maxMessageBytes: number): void {
  if (relayRawDataByteLength(data) > maxMessageBytes) throw new Error('message_too_large');
}

export function assertRelayRoomConnectionLimit(currentConnections: number, maxConnectionsPerRoom: number): void {
  if (currentConnections >= maxConnectionsPerRoom) throw new Error('room_connection_limit_exceeded');
}
