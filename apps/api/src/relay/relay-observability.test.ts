import { describe, expect, it } from 'vitest';
import { createInMemoryRelayObservabilitySink } from './relay-observability';

describe('relay observability', () => {
  it('records structured counters and drops unsafe arbitrary fields', () => {
    const sink = createInMemoryRelayObservabilitySink();

    sink.increment('grant_validation', {
      relayRoomId: 'room_1',
      grantId: 'grant_1',
      role: 'edit',
      // @ts-expect-error intentional unsafe field regression guard
      token: 'ml_relay_secret',
    });
    sink.log('write_rejected', {
      relayRoomId: 'room_1',
      reason: 'forbidden',
      // @ts-expect-error intentional unsafe field regression guard
      localFileContents: '# private',
    });

    expect(sink.counters).toEqual([
      {
        event: 'grant_validation',
        fields: { relayRoomId: 'room_1', grantId: 'grant_1', role: 'edit' },
      },
    ]);
    expect(sink.logs).toEqual([
      {
        event: 'write_rejected',
        fields: { relayRoomId: 'room_1', reason: 'forbidden' },
      },
    ]);
    expect(JSON.stringify(sink)).not.toContain('ml_relay_secret');
    expect(JSON.stringify(sink)).not.toContain('# private');
  });
});
