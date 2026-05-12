import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { GUEST_EDIT_SESSION_IDLE_TIMEOUT_SECONDS, GUEST_EDIT_SESSION_QUOTA } from '../config/collab-session-policy';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';
import type { DbPool } from '../db/client';
import type { HttpAppOptions, HttpRequestAuth } from '../http/app';
import { toRoomName } from '../collab/persistence';
import { readBranchState } from '../services/doc-read';
import {
  type ActiveProviderTokenSession,
  collabSessionActorId,
  deleteCollabSession,
  ensureProviderDocId,
  findActiveProviderTokenSession,
  markProviderDocSeeded,
  markProviderTokenIssuanceStatus,
  markProviderTokenIssuanceIssuedIfSessionActive,
  providerTokenIssuanceCanIssue,
  recordCollabSession,
  recordProviderTokenIssuanceWithPolicy,
  type ProviderTokenClientKind,
} from '../services/provider-doc-service';

const collabSessionSchema = z.object({
  mode: z.enum(['view', 'edit']),
  clientKind: z.enum(['browser', 'app', 'daemon', 'agent', 'guest']).default('browser'),
  displayName: z.string().trim().min(1).max(80).default('Guest'),
});

const providerTokenRefreshPayloadSchema = z.object({
  refreshToken: z.string().min(32).max(256),
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

function requireAuth(options: HttpAppOptions): HttpRequestAuth {
  if (!options.auth) throw new Error('auth_not_configured');
  return options.auth;
}

function requireProviderTokenService(options: HttpAppOptions) {
  if (!options.providerTokenService) throw new Error('provider_token_service_not_configured');
  return options.providerTokenService;
}

function serverActorFromAccess(access: Awaited<ReturnType<HttpRequestAuth['requireDocumentAccess']>>) {
  if (!access) throw new Error('forbidden');
  return access;
}

function serverClientKind(
  actor: { actorType: 'agent' | 'user' },
  requestedClientKind: ProviderTokenClientKind,
): ProviderTokenClientKind {
  if (actor.actorType === 'agent') return 'agent';
  void requestedClientKind;
  return 'browser';
}

function assertProviderTokenAccessIsExplicit(access: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string }): void {
  if (access.grantId && access.actorId) return;
  if (access.actorType === 'agent' && access.actorId?.startsWith('agent:')) return;
  if (access.actorId === 'admin') return;
  if (access.actorId === 'dev-anonymous' && process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB === 'true') return;
  if (
    access.actorType === 'user'
    && access.actorId
    && !access.actorId.startsWith('share:')
    && !access.actorId.startsWith('access:')
    && !access.actorId.startsWith('agent:')
    && access.actorId !== 'dev-anonymous'
  ) return;
  throw new Error('forbidden');
}

function accessIsGuest(access: { actorId?: string; grantId?: string }): boolean {
  return Boolean(access.grantId && access.actorId?.startsWith('share:'));
}

function createCollabSessionRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashCollabSessionRefreshToken(refreshToken: string): string {
  return `sha256:${createHash('sha256').update(refreshToken).digest('hex')}`;
}

function assertRefreshActorMatchesSession(
  session: ActiveProviderTokenSession,
  actor: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string },
  sessionId: string,
): void {
  if (session.actorType !== actor.actorType) throw new Error('forbidden');

  if (session.actorGrantId || actor.grantId) {
    if (!session.actorGrantId || session.actorGrantId !== actor.grantId) throw new Error('forbidden');
    if (session.isGuest) {
      if (session.actorId !== collabSessionActorId(sessionId)) throw new Error('forbidden');
      return;
    }
    if (!session.actorId || !actor.actorId || session.actorId !== actor.actorId) throw new Error('forbidden');
    return;
  }

  if (!session.actorId || !actor.actorId || session.actorId !== actor.actorId) throw new Error('forbidden');
}

function providerAuditActorFromAccess(
  access: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string },
  sessionId: string,
): { actorType: 'agent' | 'user'; actorId?: string; grantId?: string } {
  const actorId = accessIsGuest(access) ? collabSessionActorId(sessionId) : access.actorId;
  return {
    actorType: access.actorType,
    ...(actorId ? { actorId } : {}),
    ...(access.grantId ? { grantId: access.grantId } : {}),
  };
}

function isDirectLoggedInUserActor(actor: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string }): boolean {
  return Boolean(
    actor.actorType === 'user'
    && actor.actorId
    && !actor.grantId
    && actor.actorId !== 'admin'
    && actor.actorId !== 'dev-anonymous'
    && !actor.actorId.startsWith('share:')
    && !actor.actorId.startsWith('access:')
    && !actor.actorId.startsWith('agent:'),
  );
}

function assertSameProviderActor(
  expected: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string },
  actual: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string },
): void {
  if (
    expected.actorType !== actual.actorType
    || expected.actorId !== actual.actorId
    || expected.grantId !== actual.grantId
  ) {
    throw new Error('forbidden');
  }
}

function directUserPostMintAccessRecheck(input: {
  auth: HttpRequestAuth;
  req: Request;
  docId: string;
  branchId: string;
  expectedActor: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string };
  sessionId: string;
}): (() => Promise<void>) | undefined {
  if (!isDirectLoggedInUserActor(input.expectedActor)) return undefined;
  return async () => {
    const access = serverActorFromAccess(await input.auth.requireDocumentAccess(input.req, input.docId, input.branchId, 'write'));
    assertProviderTokenAccessIsExplicit(access);
    assertSameProviderActor(input.expectedActor, providerAuditActorFromAccess(access, input.sessionId));
  };
}

function providerSessionIdentityActorId(input: {
  actor: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string };
  sessionId: string;
  isGuestSession: boolean;
}): string {
  if (input.isGuestSession || input.actor.actorType === 'agent') return collabSessionActorId(input.sessionId);
  if (input.actor.grantId) return `grant:${input.actor.grantId}`;
  return input.actor.actorId ?? collabSessionActorId(input.sessionId);
}

function providerErrorAuditMessage(): string {
  return 'provider_token_issue_failed';
}

async function readCurrentMarkdownSnapshot(pool: DbPool, options: HttpAppOptions, docId: string, branchId: string) {
  let attemptedLiveSnapshot = false;
  if (options.collabSnapshotService) {
    attemptedLiveSnapshot = true;
    const liveSnapshot = await options.collabSnapshotService.readCurrentMarkdownSnapshot({ docId, branchId });
    if (liveSnapshot) return liveSnapshot;
  }

  if (options.flushCollabDocument) {
    await options.flushCollabDocument(toRoomName(docId, branchId));
  } else if (!attemptedLiveSnapshot) {
    throw new Error('collab_snapshot_service_not_configured');
  }

  try {
    return await readBranchState(pool, docId, branchId);
  } catch (error) {
    if (error instanceof Error && error.message === 'branch_not_found') {
      throw new Error('collab_snapshot_unavailable');
    }
    throw error;
  }
}

async function issueAuditedProviderToken(pool: DbPool, options: HttpAppOptions, input: {
  docId: string;
  branchId: string;
  providerDocId: string;
  sessionId: string;
  clientKind: ProviderTokenClientKind;
  actor: { actorType: 'agent' | 'user'; actorId?: string; grantId?: string };
  displayName: string;
  seedYjsState?: Uint8Array;
  isGuestSession: boolean;
  enforceGuestQuota?: boolean;
  recheckBeforeMarkIssued?: () => Promise<void>;
}) {
  const providerTokenService = requireProviderTokenService(options);
  const issuance = await recordProviderTokenIssuanceWithPolicy(pool, {
    docId: input.docId,
    branchId: input.branchId,
    providerDocId: input.providerDocId,
    sessionId: input.sessionId,
    clientKind: input.clientKind,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId ?? null,
    actorGrantId: input.actor.grantId ?? null,
    authorization: 'full',
    validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
    status: 'pending',
    isGuestSession: input.isGuestSession,
    enforceGuestQuota: input.enforceGuestQuota ?? true,
    guestQuota: GUEST_EDIT_SESSION_QUOTA,
    guestSessionIdleTimeoutSeconds: GUEST_EDIT_SESSION_IDLE_TIMEOUT_SECONDS,
  });

  try {
    const canIssue = await providerTokenIssuanceCanIssue(pool, {
      issuanceId: issuance.issuanceId,
      docId: input.docId,
      branchId: input.branchId,
      sessionId: input.sessionId,
    });
    if (!canIssue) throw new Error('collab_session_not_found');
    const providerToken = await providerTokenService.issueProviderToken({
      providerDocId: input.providerDocId,
      sessionId: input.sessionId,
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
        sessionIdentity: {
          sessionId: input.sessionId,
          actorType: input.actor.actorType,
          actorId: providerSessionIdentityActorId({
            actor: input.actor,
            sessionId: input.sessionId,
            isGuestSession: input.isGuestSession,
          }),
          displayName: input.displayName,
          isGuest: input.isGuestSession,
        },
      ...(input.seedYjsState ? { seedYjsState: input.seedYjsState } : {}),
    });
    await input.recheckBeforeMarkIssued?.();
    if (input.seedYjsState) {
      await markProviderDocSeeded(pool, {
        docId: input.docId,
        branchId: input.branchId,
        providerDocId: input.providerDocId,
        seededYjsState: input.seedYjsState,
      });
    }
    const markedIssued = await markProviderTokenIssuanceIssuedIfSessionActive(pool, {
      issuanceId: issuance.issuanceId,
      docId: input.docId,
      branchId: input.branchId,
      sessionId: input.sessionId,
    });
    if (!markedIssued) throw new Error('collab_session_not_found');
    return providerToken;
  } catch (error) {
    await markProviderTokenIssuanceStatus(pool, {
      issuanceId: issuance.issuanceId,
      status: 'failed',
      providerError: providerErrorAuditMessage(),
    }).catch(() => undefined);
    throw error;
  }
}

export function createCollabSessionRoutes(pool: DbPool, options: HttpAppOptions = {}) {
  const router = Router();

  router.post('/docs/:docId/branches/:branchId/collab/session', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const body = collabSessionSchema.parse(req.body);
      const sessionId = `session_${randomUUID()}`;
      const auth = requireAuth(options);

      if (body.mode === 'view') {
        const access = serverActorFromAccess(await auth.requireDocumentAccess(req, docId, branchId, 'read'));
        assertProviderTokenAccessIsExplicit(access);
        const document = await readCurrentMarkdownSnapshot(pool, options, docId, branchId);
        const clientKind = serverClientKind(access, body.clientKind);
        const sessionActor = providerAuditActorFromAccess(access, sessionId);
        await recordCollabSession(pool, {
          sessionId,
          docId,
          branchId,
          mode: 'view',
          clientKind,
          actorType: sessionActor.actorType,
          actorId: sessionActor.actorId ?? null,
          actorGrantId: sessionActor.grantId ?? null,
          isGuest: accessIsGuest(access),
          role: access.role ?? 'view',
          displayName: body.displayName,
        });
        res.status(200).json({
          mode: 'view',
          session: {
            sessionId,
            clientKind,
            displayName: body.displayName,
          },
          document: {
            docId: document.docId,
            branchId: document.branchId,
            versionId: document.versionId,
            versionNumber: document.versionNumber,
            hash: document.hash,
            markdown: document.markdown,
          },
        });
        return;
      }

      const access = serverActorFromAccess(await auth.requireDocumentAccess(req, docId, branchId, 'write'));
      assertProviderTokenAccessIsExplicit(access);
      const providerDoc = await ensureProviderDocId(pool, { docId, branchId });
      const refreshToken = createCollabSessionRefreshToken();
      const clientKind = serverClientKind(access, body.clientKind);
      const sessionActor = providerAuditActorFromAccess(access, sessionId);
      const isGuestSession = accessIsGuest(access);
      await recordCollabSession(pool, {
        sessionId,
        docId,
        branchId,
        mode: 'edit',
        clientKind,
        actorType: sessionActor.actorType,
        actorId: sessionActor.actorId ?? null,
        actorGrantId: sessionActor.grantId ?? null,
        refreshTokenHash: hashCollabSessionRefreshToken(refreshToken),
        isGuest: isGuestSession,
        role: access.role ?? 'edit',
        displayName: body.displayName,
      });
      let providerToken;
      try {
        const recheckBeforeMarkIssued = directUserPostMintAccessRecheck({
          auth,
          req,
          docId,
          branchId,
          expectedActor: sessionActor,
          sessionId,
        });
        providerToken = await issueAuditedProviderToken(pool, options, {
          docId,
          branchId,
          providerDocId: providerDoc.providerDocId,
          sessionId,
          clientKind,
          actor: sessionActor,
          displayName: body.displayName,
          isGuestSession,
          ...(recheckBeforeMarkIssued ? { recheckBeforeMarkIssued } : {}),
          ...(providerDoc.needsSeed ? { seedYjsState: providerDoc.initialYjsState } : {}),
        });
      } catch (error) {
        await deleteCollabSession(pool, sessionId).catch(() => undefined);
        throw error;
      }

      res.status(201).json({
        mode: 'edit',
        session: {
          sessionId,
          clientKind,
          displayName: body.displayName,
          refreshToken,
        },
        providerToken,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/docs/:docId/branches/:branchId/collab/session/:sessionId/provider-token/refresh',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const docId = requiredParam(req, 'docId');
        const branchId = requiredParam(req, 'branchId');
        const sessionId = requiredParam(req, 'sessionId');
        const body = providerTokenRefreshPayloadSchema.parse(req.body);
        const auth = requireAuth(options);

        const access = serverActorFromAccess(await auth.requireDocumentAccess(req, docId, branchId, 'write'));
        assertProviderTokenAccessIsExplicit(access);
        const existingSession = await findActiveProviderTokenSession(pool, {
          docId,
          branchId,
          sessionId,
          refreshTokenHash: hashCollabSessionRefreshToken(body.refreshToken),
        });
        if (!existingSession) throw new Error('collab_session_not_found');
        assertRefreshActorMatchesSession(existingSession, access, sessionId);
        const sessionActor = providerAuditActorFromAccess(access, sessionId);
        const recheckBeforeMarkIssued = directUserPostMintAccessRecheck({
          auth,
          req,
          docId,
          branchId,
          expectedActor: sessionActor,
          sessionId,
        });
        const providerToken = await issueAuditedProviderToken(pool, options, {
          docId,
          branchId,
          providerDocId: existingSession.providerDocId,
          sessionId,
          clientKind: existingSession.clientKind,
          actor: sessionActor,
          displayName: existingSession.displayName,
          isGuestSession: existingSession.isGuest,
          enforceGuestQuota: false,
          ...(recheckBeforeMarkIssued ? { recheckBeforeMarkIssued } : {}),
        });

        res.status(200).json({ providerToken });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
