import { describe, expect, it } from 'vitest';
import {
  assertRelayMessageBytes,
  assertRelayRoomConnectionLimit,
  relayRawDataByteLength,
  resolveRelayLimits,
} from './relay-limits';

describe('relay limits', () => {
  it('uses conservative defaults and accepts explicit positive limits', () => {
    expect(resolveRelayLimits()).toEqual({
      maxMessageBytes: 1024 * 1024,
      maxConnectionsPerRoom: 64,
    });
    expect(resolveRelayLimits({ maxMessageBytes: 128, maxConnectionsPerRoom: 3 })).toEqual({
      maxMessageBytes: 128,
      maxConnectionsPerRoom: 3,
    });
    expect(resolveRelayLimits({ maxMessageBytes: 0, maxConnectionsPerRoom: -1 })).toEqual({
      maxMessageBytes: 1024 * 1024,
      maxConnectionsPerRoom: 64,
    });
  });

  it('measures websocket payload bytes across raw data shapes', () => {
    expect(relayRawDataByteLength('abc')).toBe(3);
    expect(relayRawDataByteLength(Buffer.from([1, 2, 3]))).toBe(3);
    expect(relayRawDataByteLength([Buffer.from([1]), Buffer.from([2, 3])])).toBe(3);
  });

  it('rejects oversized messages and full rooms', () => {
    expect(() => assertRelayMessageBytes(Buffer.alloc(4), 3)).toThrow('message_too_large');
    expect(() => assertRelayMessageBytes(Buffer.alloc(3), 3)).not.toThrow();
    expect(() => assertRelayRoomConnectionLimit(2, 2)).toThrow('room_connection_limit_exceeded');
    expect(() => assertRelayRoomConnectionLimit(1, 2)).not.toThrow();
  });
});
