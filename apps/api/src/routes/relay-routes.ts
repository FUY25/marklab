import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { RelayServerHandle } from '../relay/relay-server';
import type { RelayAccessRole, RelayClientKind, RelayRouteService } from '../relay/relay-room-service';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';

export interface RelayRoutesOptions {
  relayService?: RelayRouteService;
  relayServer?: RelayServerHandle;
}

const createRelayRoomSchema = z.object({
  hostSessionId: z.string().min(1).nullable().optional(),
  hostAuthToken: z.string().min(1).nullable().optional(),
  lastEphemeralYjsStateBase64: z.string().nullable().optional(),
  lastSharedHash: z.string().nullable().optional(),
});

const createRelayGrantSchema = z.object({
  role: z.enum(['view', 'edit']),
  expiresAt: z.string().datetime().nullable().optional(),
});

const createRelaySessionSchema = z.object({
  token: z.string().min(1),
  clientId: z.string().min(1),
  clientKind: z.enum(['browser', 'daemon', 'agent']).optional().default('browser'),
  displayName: z.string().default(''),
});

const acceptRelaySharedStateSchema = z.object({
  yjsStateBase64: z.string().min(1),
  sharedHash: z.string().min(1),
  expectedSharedRevision: z.number().int().nonnegative().nullable().optional(),
  expectedSharedHash: z.string().nullable().optional(),
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

function relayToken(req: Request): string | undefined {
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  const match = /^Bearer\s+(.+)$/iu.exec(req.header('authorization') ?? '');
  return match?.[1];
}

function bearerToken(req: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(req.header('authorization') ?? '');
  return match?.[1];
}

function requireRelayManagement(req: Request): void {
  const expected = process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
  if (!expected) throw new Error('relay_management_token_not_configured');
  if (bearerToken(req) !== expected) throw new Error('forbidden');
}

function hasRelayManagement(req: Request): boolean {
  const expected = process.env.MARKLAB_RELAY_MANAGEMENT_TOKEN;
  return Boolean(expected && bearerToken(req) === expected);
}

async function requireRelayManagementOrRoomHost(
  req: Request,
  service: RelayRouteService,
  relayRoomId: string,
): Promise<void> {
  if (hasRelayManagement(req)) return;
  await service.verifyHost(relayRoomId, bearerToken(req));
}

function decodeBase64(value: string | null | undefined): Uint8Array | null {
  if (!value) return null;
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function encodeBase64(value: Uint8Array | null): string | null {
  return value ? Buffer.from(value).toString('base64') : null;
}

function suggestedFilenameFromMarkdown(markdown: string, fallback: string): string {
  const heading = markdown
    .split(/\r?\n/u)
    .map((line) => /^#\s+(.+)$/u.exec(line.trim())?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  const source = heading || fallback || 'shared-notes';
  const safeBase = source
    .normalize('NFKD')
    .replace(/[^\w.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return `${safeBase || 'shared-notes'}.md`;
}

function requireRelayService(service: RelayRouteService | undefined): RelayRouteService {
  if (!service) throw new Error('relay_service_not_configured');
  return service;
}

const runtime = createHeadlessMilkdownRuntime();

function relayUrlFor(req: Request, relayRoomId: string, token: string, role: RelayAccessRole): string {
  const configuredWebUrl = process.env.MARKLAB_PUBLIC_WEB_URL?.trim() ?? process.env.MARKLAB_WEB_ORIGIN?.split(',')[0]?.trim();
  const baseUrl = configuredWebUrl || `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  const url = new URL(`/relay/${encodeURIComponent(relayRoomId)}`, baseUrl);
  url.searchParams.set('token', token);
  url.searchParams.set('mode', role);
  if (process.env.MARKLAB_PUBLIC_API_URL) url.searchParams.set('apiUrl', process.env.MARKLAB_PUBLIC_API_URL);
  if (process.env.MARKLAB_PUBLIC_RELAY_WS_URL) url.searchParams.set('wsUrl', process.env.MARKLAB_PUBLIC_RELAY_WS_URL);
  return url.toString();
}

export function createRelayRoutes(options: RelayRoutesOptions = {}) {
  const router = Router();

  router.post('/relay/rooms', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = requireRelayService(options.relayService);
      const body = createRelayRoomSchema.parse(req.body);
      const room = await service.createRoom({
        hostSessionId: body.hostSessionId ?? null,
        hostAuthToken: body.hostAuthToken ?? null,
        lastEphemeralYjsState: decodeBase64(body.lastEphemeralYjsStateBase64),
        lastSharedHash: body.lastSharedHash ?? null,
      });
      res.status(201).json({
        relayRoomId: room.relayRoomId,
        hostSessionId: room.hostSessionId,
        state: room.state,
        sharedRevision: room.sharedRevision,
        lastSharedHash: room.lastSharedHash,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/relay/rooms/:relayRoomId/access', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = requireRelayService(options.relayService);
      const relayRoomId = requiredParam(req, 'relayRoomId');
      const access = await service.verifyAccess({
        relayRoomId,
        token: relayToken(req),
        operation: 'read',
      });
      const markdown = access.lastEphemeralYjsState
        ? (await runtime.serializeYjsState(access.lastEphemeralYjsState)).markdown
        : '';
      res.json({
        relayRoomId: access.relayRoomId,
        grantId: access.grantId,
        role: access.role,
        canRead: access.canRead,
        canWrite: access.canWrite,
        hostOnline: access.hostOnline,
        hostSessionId: access.hostSessionId,
        sharedRevision: access.sharedRevision,
        lastSharedHash: access.lastSharedHash,
        yjsStateBase64: encodeBase64(access.lastEphemeralYjsState),
        markdown,
        cacheUpdatedAt: access.cacheUpdatedAt,
        ephemeralCacheExpiresAt: access.ephemeralCacheExpiresAt,
        stale: access.stale,
        suggestedFilename: suggestedFilenameFromMarkdown(markdown, access.relayRoomId),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/relay/rooms/:relayRoomId/access-grants', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = requireRelayService(options.relayService);
      const relayRoomId = requiredParam(req, 'relayRoomId');
      await requireRelayManagementOrRoomHost(req, service, relayRoomId);
      const body = createRelayGrantSchema.parse(req.body);
      const grant = await service.createAccessGrant({
        relayRoomId,
        role: body.role,
        expiresAt: body.expiresAt ?? null,
      });
      res.status(201).json({
        grantId: grant.grantId,
        relayRoomId: grant.relayRoomId,
        token: grant.token,
        role: grant.role,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
        url: relayUrlFor(req, grant.relayRoomId, grant.token, grant.role),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/relay/rooms/:relayRoomId/share-state', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = requireRelayService(options.relayService);
      const relayRoomId = requiredParam(req, 'relayRoomId');
      await requireRelayManagementOrRoomHost(req, service, relayRoomId);
      res.json(await service.listShareState(relayRoomId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/relay/rooms/:relayRoomId/shared-state', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = requireRelayService(options.relayService);
      if (!service.acceptSharedState) throw new Error('relay_service_not_configured');
      const relayRoomId = requiredParam(req, 'relayRoomId');
      await requireRelayManagementOrRoomHost(req, service, relayRoomId);
      const body = acceptRelaySharedStateSchema.parse(req.body);
      const room = await service.acceptSharedState({
        relayRoomId,
        yjsState: decodeBase64(body.yjsStateBase64) ?? new Uint8Array(),
        sharedHash: body.sharedHash,
        expectedRevision: body.expectedSharedRevision ?? null,
        expectedSharedHash: body.expectedSharedHash ?? null,
      });
      res.json({
        relayRoomId: room.relayRoomId,
        hostSessionId: room.hostSessionId,
        state: room.state,
        sharedRevision: room.sharedRevision,
        lastSharedHash: room.lastSharedHash,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/relay/rooms/:relayRoomId/access-sessions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = requireRelayService(options.relayService);
      const relayRoomId = requiredParam(req, 'relayRoomId');
      const body = createRelaySessionSchema.parse(req.body);
      const access = await service.verifyAccess({
        relayRoomId,
        token: body.token,
        operation: 'read',
      });
      const session = await service.createOrUpdateSession({
        relayRoomId,
        grantId: access.grantId,
        clientId: body.clientId,
        clientKind: body.clientKind as RelayClientKind,
        displayName: body.displayName,
      });
      res.status(session.createdAt === session.lastSeenAt ? 201 : 200).json({
        grantId: session.grantId,
        sessionId: session.sessionId,
        displayName: session.displayName,
        color: session.color,
        role: session.role,
        canRead: true,
        canWrite: session.role === 'edit',
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/relay/rooms/:relayRoomId/host-offline', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = requireRelayService(options.relayService);
      const relayRoomId = requiredParam(req, 'relayRoomId');
      await requireRelayManagementOrRoomHost(req, service, relayRoomId);
      const room = await service.markHostOffline(relayRoomId);
      res.json({ relayRoomId, hostOnline: false, state: room?.state ?? 'host_offline' });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/relay/rooms/:relayRoomId/access-grants/:grantId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = requireRelayService(options.relayService);
      const relayRoomId = requiredParam(req, 'relayRoomId');
      const grantId = requiredParam(req, 'grantId');
      await requireRelayManagementOrRoomHost(req, service, relayRoomId);
      const revoked = await service.revokeAccessGrant(grantId);
      if (revoked.relayRoomId !== relayRoomId) throw new Error('relay_access_grant_not_found');
      options.relayServer?.disconnectGrant(revoked.grantId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.delete('/relay/access-grants/:grantId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireRelayManagement(req);
      const service = requireRelayService(options.relayService);
      const grantId = requiredParam(req, 'grantId');
      const revoked = await service.revokeAccessGrant(grantId);
      options.relayServer?.disconnectGrant(revoked.grantId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
