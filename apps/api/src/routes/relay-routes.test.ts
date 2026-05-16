import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
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

function createState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, text);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

describe('relay routes anonymous alpha host policy', () => {
  it('lets an anonymous alpha host create a room and then requires the room host token for grants', async () => {
    delete process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
    const relayService = createInMemoryRelayRoomService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), { relayService, localMode: true });

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
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), { relayService, localMode: true });

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

  it('lets the room host publish resolved shared state with a revision guard', async () => {
    delete process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
    const relayService = createInMemoryRelayRoomService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), { relayService, localMode: true });
    const nextState = createState('# Next\n');
    const nextHash = sha256Hex('# Next\n');

    const roomResponse = await request(app)
      .post('/api/relay/rooms')
      .send({ hostSessionId: 'host_1', hostAuthToken: 'host_secret', lastSharedHash: sha256Hex('# Base\n') })
      .expect(201);
    const relayRoomId = roomResponse.body.relayRoomId as string;

    await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/shared-state`)
      .set('Authorization', 'Bearer wrong_secret')
      .send({
        yjsStateBase64: Buffer.from(nextState).toString('base64'),
        sharedHash: nextHash,
        expectedSharedRevision: 0,
        expectedSharedHash: sha256Hex('# Base\n'),
      })
      .expect(403);

    await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/shared-state`)
      .set('Authorization', 'Bearer host_secret')
      .send({
        yjsStateBase64: Buffer.from(nextState).toString('base64'),
        sharedHash: nextHash,
        expectedSharedRevision: 0,
        expectedSharedHash: sha256Hex('# Different base\n'),
      })
      .expect(409);

    const accepted = await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/shared-state`)
      .set('Authorization', 'Bearer host_secret')
      .send({
        yjsStateBase64: Buffer.from(nextState).toString('base64'),
        sharedHash: 'sha256:caller-supplied-wrong-hash',
        expectedSharedRevision: 0,
        expectedSharedHash: sha256Hex('# Base\n'),
      })
      .expect(200);

    expect(accepted.body).toMatchObject({
      relayRoomId,
      sharedRevision: 1,
      lastSharedHash: nextHash,
    });
    await expect(relayService.getRoom(relayRoomId)).resolves.toMatchObject({
      sharedRevision: 1,
      lastSharedHash: nextHash,
    });

    await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/shared-state`)
      .set('Authorization', 'Bearer host_secret')
      .send({
        yjsStateBase64: Buffer.from(createState('# Stale\n')).toString('base64'),
        sharedHash: sha256Hex('# Stale\n'),
        expectedSharedRevision: 0,
        expectedSharedHash: nextHash,
      })
      .expect(409);
  });

  it('lets the room host publish initial shared state guarded by an empty expected hash', async () => {
    delete process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
    const relayService = createInMemoryRelayRoomService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), { relayService, localMode: true });
    const nextState = createState('# Initial shared\n');
    const nextHash = sha256Hex('# Initial shared\n');

    const roomResponse = await request(app)
      .post('/api/relay/rooms')
      .send({ hostSessionId: 'host_1', hostAuthToken: 'host_secret' })
      .expect(201);
    const relayRoomId = roomResponse.body.relayRoomId as string;

    const accepted = await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/shared-state`)
      .set('Authorization', 'Bearer host_secret')
      .send({
        yjsStateBase64: Buffer.from(nextState).toString('base64'),
        sharedHash: nextHash,
        expectedSharedRevision: 0,
        expectedSharedHash: '',
      })
      .expect(200);

    expect(accepted.body).toMatchObject({
      relayRoomId,
      sharedRevision: 1,
      lastSharedHash: nextHash,
    });
  });

  it('rejects invalid host-published shared state before corrupting the relay room', async () => {
    delete process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
    const relayService = createInMemoryRelayRoomService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), { relayService, localMode: true });

    const roomResponse = await request(app)
      .post('/api/relay/rooms')
      .send({
        hostSessionId: 'host_1',
        hostAuthToken: 'host_secret',
        lastEphemeralYjsStateBase64: Buffer.from(createState('# Base\n')).toString('base64'),
        lastSharedHash: sha256Hex('# Base\n'),
      })
      .expect(201);
    const relayRoomId = roomResponse.body.relayRoomId as string;

    await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/shared-state`)
      .set('Authorization', 'Bearer host_secret')
      .send({
        yjsStateBase64: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'),
        sharedHash: 'sha256:invalid',
        expectedSharedRevision: 0,
      })
      .expect(400);

    await expect(relayService.getRoom(relayRoomId)).resolves.toMatchObject({
      sharedRevision: 0,
      lastSharedHash: sha256Hex('# Base\n'),
    });
  });

  it('returns invalid_request for malformed host-published shared state bodies', async () => {
    delete process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
    const relayService = createInMemoryRelayRoomService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), { relayService, localMode: true });

    const roomResponse = await request(app)
      .post('/api/relay/rooms')
      .send({
        hostSessionId: 'host_1',
        hostAuthToken: 'host_secret',
        lastEphemeralYjsStateBase64: Buffer.from(createState('# Base\n')).toString('base64'),
        lastSharedHash: sha256Hex('# Base\n'),
      })
      .expect(201);
    const relayRoomId = roomResponse.body.relayRoomId as string;

    const response = await request(app)
      .post(`/api/relay/rooms/${relayRoomId}/shared-state`)
      .set('Authorization', 'Bearer host_secret')
      .send({})
      .expect(400);

    expect(response.body.error).toBe('invalid_request');
    await expect(relayService.getRoom(relayRoomId)).resolves.toMatchObject({
      sharedRevision: 0,
      lastSharedHash: sha256Hex('# Base\n'),
    });
  });
});
