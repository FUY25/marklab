export type RelayObservabilityEvent =
  | 'room_created'
  | 'room_closed'
  | 'room_connection_limit_rejected'
  | 'grant_validation'
  | 'host_lease_online'
  | 'host_lease_offline'
  | 'host_lease_expired'
  | 'write_rejected'
  | 'grant_revoked'
  | 'oversized_message'
  | 'ephemeral_cache_cleaned'
  | 'expired_grants_cleaned'
  | 'stale_sessions_cleaned';

export interface RelayObservabilityFields {
  relayRoomId?: string | null;
  grantId?: string | null;
  sessionId?: string | null;
  role?: string | null;
  clientKind?: string | null;
  reason?: string | null;
  count?: number;
  messageBytes?: number;
}

export interface RelayObservabilitySink {
  increment(event: RelayObservabilityEvent, fields?: RelayObservabilityFields): void;
  log(event: RelayObservabilityEvent, fields?: RelayObservabilityFields): void;
}

export interface RelayObservabilityCounter {
  event: RelayObservabilityEvent;
  fields: RelayObservabilityFields;
}

const SAFE_FIELD_KEYS = new Set<keyof RelayObservabilityFields>([
  'relayRoomId',
  'grantId',
  'sessionId',
  'role',
  'clientKind',
  'reason',
  'count',
  'messageBytes',
]);

function sanitizeFields(fields: RelayObservabilityFields = {}): RelayObservabilityFields {
  const safe: RelayObservabilityFields = {};
  for (const key of SAFE_FIELD_KEYS) {
    const value = fields[key];
    if (value === undefined) continue;
    Object.assign(safe, { [key]: value });
  }
  return safe;
}

export function createInMemoryRelayObservabilitySink(): RelayObservabilitySink & {
  readonly counters: RelayObservabilityCounter[];
  readonly logs: RelayObservabilityCounter[];
} {
  const counters: RelayObservabilityCounter[] = [];
  const logs: RelayObservabilityCounter[] = [];
  return {
    counters,
    logs,
    increment(event, fields) {
      counters.push({ event, fields: sanitizeFields(fields) });
    },
    log(event, fields) {
      logs.push({ event, fields: sanitizeFields(fields) });
    },
  };
}

export const noopRelayObservabilitySink: RelayObservabilitySink = {
  increment() {
    // Intentionally empty.
  },
  log() {
    // Intentionally empty.
  },
};
