import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbPool } from '../db/client';
import { createHttpApp } from '../http/app';
import { createInMemoryRelayRoomService } from '../relay/relay-room-service';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

function createLocalOnlyPool(): DbPool {
  async function unavailable(): Promise<never> {
    throw new Error('database_not_configured');
  }

  return {
    query: unavailable,
    connect: unavailable,
  };
}

const originalManagementToken = process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;

afterEach(() => {
  process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN = originalManagementToken;
});

describe('relay routes anonymous alpha host policy', () => {
  it('lets an anonymous alpha host create a room and then requires the room host token for grants', async () => {
    delete process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
    const relayService = createInMemoryRelayRoomService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), { relayService });

    const roomResponse = await request(app)
      .post('/api/relay/rooms')
      .send({
        hostSessionId: 'host_1',
        hostAuthToken: 'host_secret',
        lastSharedHash: 'sha256:host',
      })
      .expect(201);

    const relayRoomId = roomResponse.body.relayRoomId as string;
    expect(relayRoomId).toBeTruthy();

    await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/access-grants`)
      .send({ role: 'edit' })
      .expect(403);

    const grantResponse = await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/access-grants`)
      .set('Authorization', 'Bearer host_secret')
      .send({ role: 'edit' })
      .expect(201);

    expect(grantResponse.body.url).toContain(`/relay/${relayRoomId}`);
    expect(grantResponse.body.url).toContain('token=ml_relay_');
    expect(grantResponse.body.url).not.toContain('host_secret');
  });

  it('uses the room host token for share state and grant revoke without a global management token', async () => {
    delete process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
    const relayService = createInMemoryRelayRoomService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), { relayService });

    const roomResponse = await request(app)
      .post('/api/relay/rooms')
      .send({ hostSessionId: 'host_1', hostAuthToken: 'host_secret' })
      .expect(201);
    const relayRoomId = roomResponse.body.relayRoomId as string;
    const grantResponse = await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/access-grants`)
      .set('Authorization', 'Bearer host_secret')
      .send({ role: 'view' })
      .expect(201);

    await request(app)
      .get(`/api/relay/rooms/${relayRoomId}/share-state`)
      .set('Authorization', 'Bearer wrong_secret')
      .expect(403);

    const stateResponse = await request(app)
      .get(`/api/relay/rooms/${relayRoomId}/share-state`)
      .set('Authorization', 'Bearer host_secret')
      .expect(200);

    expect(stateResponse.body.links).toHaveLength(1);

    await request(app)
      .delete(`/api/relay/rooms/${relayRoomId}/access-grants/${grantResponse.body.grantId}`)
      .set('Authorization', 'Bearer host_secret')
      .expect(204);
  });
});
