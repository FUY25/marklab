import { describe, expect, it } from 'vitest';
import { evaluateHealth } from '../../scripts/marklab-alpha-smoke.mjs';

describe('marklab alpha smoke helpers', () => {
  it('requires database schema and provider store readiness', () => {
    expect(evaluateHealth({
      ok: true,
      database: { ready: true },
      schema: { ready: true, missing: [] },
      provider: { ready: true, storeReady: true },
    })).toEqual({ ok: true, failures: [] });

    expect(evaluateHealth({
      ok: true,
      database: { ready: true },
      schema: { ready: false, missing: ['subscriptions.billing_mode'] },
      provider: { ready: true, storeReady: false },
    })).toEqual({
      ok: false,
      failures: [
        'schema.ready',
        'schema.missing:subscriptions.billing_mode',
        'provider.storeReady',
      ],
    });
  });
});
