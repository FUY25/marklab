import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { toRoomName } from '../collab/persistence';
import type { DbPool } from '../db/client';
import type { HttpAppOptions, HttpAuthEnvironment } from '../http/app';
import {
  createOrUpdateAccessSession,
  generateAccessToken,
  generateAgentToken,
  generateShareToken,
  hashToken,
  isAdminToken,
  verifyAdminToken,
  verifyDocumentAccess,
  type AccessClientKind,
  type AccessOperation,
  type VerifiedDocumentAccess,
} from '../services/access-control';
import { authenticateRequestUser } from '../services/user-service';
import { requireUserDocumentAccess } from '../services/control-plane-access';

interface AgentTokenRow {
  id: string;
  name: string;
  can_read: boolean;
  can_write: boolean;
  expires_at: Date | string | null;
  created_at: Date | string;
}

interface ShareLinkRow {
  id: string;
  role: 'view' | 'edit';
  expires_at: Date | string | null;
  created_at: Date | string;
}

interface AccessGrantRow {
  id: string;
  doc_id?: string;
  branch_id: string;
  branch_name: string;
  role: 'view' | 'edit';
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  sessions?: AccessSessionListRow[];
}

interface AccessSessionListRow {
  sessionId?: string;
  session_id?: string;
  clientKind?: AccessClientKind;
  client_kind?: AccessClientKind;
  displayName?: string;
  display_name?: string;
  color: string;
  lastBranchId?: string | null;
  last_branch_id?: string | null;
  lastSeenAt?: Date | string;
  last_seen_at?: Date | string;
}

interface GrantManagementAccessRow {
  owner_id: string | null;
  workspace_id: string | null;
  member_role: 'Owner' | 'Member' | 'Reader' | null;
}

interface GrantManagementAccess {
  userId: string | null;
}

const createAgentTokenSchema = z.object({
  name: z.string().min(1),
  canRead: z.boolean().optional().default(true),
  canWrite: z.boolean().optional().default(false),
  expiresAt: z.string().datetime().nullable().optional(),
});

const createShareLinkSchema = z.object({
  role: z.enum(['view', 'edit']),
  expiresAt: z.string().datetime().nullable().optional(),
});

const createAccessGrantSchema = z.object({
  role: z.enum(['view', 'edit']),
  expiresAt: z.string().datetime().nullable().optional(),
});

const createAccessSessionSchema = z.object({
  clientId: z.string().min(1),
  clientKind: z.enum(['browser', 'app', 'daemon', 'agent', 'api']).optional().default('browser'),
  displayName: z.string().default(''),
});

type AccessRouteOptions = Pick<HttpAppOptions, 'closeCollabDocumentConnections' | 'authEnvironment'>;

function accessRouteAuthEnvironment(input?: Partial<HttpAuthEnvironment>): Pick<HttpAuthEnvironment, 'requireAuth' | 'devAnonymousAccess' | 'adminTokenHash'> {
  return {
    requireAuth: input?.requireAuth ?? process.env.MARKLAB_REQUIRE_AUTH === 'true',
    devAnonymousAccess: input?.devAnonymousAccess ?? process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB === 'true',
    adminTokenHash: input?.adminTokenHash ?? process.env.MARKLAB_ADMIN_TOKEN_HASH,
  };
}

function bearerToken(req: Request): string | undefined {
  const header = req.header('authorization');
  const match = /^Bearer\s+(.+)$/iu.exec(header ?? '');
  return match?.[1];
}

function documentToken(req: Request): string | undefined {
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return bearerToken(req);
}

function requireAdmin(req: Request, authEnvironment: Pick<HttpAuthEnvironment, 'requireAuth' | 'devAnonymousAccess' | 'adminTokenHash'>): void {
  if (!authEnvironment.requireAuth && authEnvironment.devAnonymousAccess) return;
  verifyAdminToken(bearerToken(req), authEnvironment.adminTokenHash);
}

function isAdminRequest(req: Request, authEnvironment: Pick<HttpAuthEnvironment, 'requireAuth' | 'devAnonymousAccess' | 'adminTokenHash'>): boolean {
  if (!authEnvironment.requireAuth && authEnvironment.devAnonymousAccess) return true;
  return isAdminToken(bearerToken(req), authEnvironment.adminTokenHash);
}

async function verifyRequestDocumentAccess(
  pool: DbPool,
  req: Request,
  docId: string,
  branchId: string,
  operation: AccessOperation,
  authEnvironment: Pick<HttpAuthEnvironment, 'adminTokenHash'>,
): Promise<VerifiedDocumentAccess> {
  const token = documentToken(req);
  if (isAdminToken(bearerToken(req), authEnvironment.adminTokenHash)) return { actorType: 'user', actorId: 'admin', canManageAccess: true };
  const user = await authenticateRequestUser(pool, req);
  if (user) {
    try {
      return await requireUserDocumentAccess(pool, { userId: user.userId, docId, branchId, operation });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'forbidden') throw error;
      if (operation === 'write') {
        let hasReadAccess = false;
        try {
          await requireUserDocumentAccess(pool, { userId: user.userId, docId, branchId, operation: 'read' });
          hasReadAccess = true;
        } catch (readError) {
          if (!(readError instanceof Error) || readError.message !== 'forbidden') throw readError;
        }
        if (hasReadAccess) throw new Error('forbidden');
      }
    }
  }

  return verifyDocumentAccess(pool, token, docId, branchId, operation);
}

async function requireGrantManagementAccess(
  pool: DbPool,
  req: Request,
  docId: string,
  branchId: string | null,
  authEnvironment: Pick<HttpAuthEnvironment, 'requireAuth' | 'devAnonymousAccess' | 'adminTokenHash'>,
): Promise<GrantManagementAccess> {
  if (isAdminRequest(req, authEnvironment)) return { userId: null };
  const user = await authenticateRequestUser(pool, req);
  if (!user) throw new Error('forbidden');

  const result = await pool.query<GrantManagementAccessRow>(
    `select d.owner_id,
            d.workspace_id,
            m.role as member_role
	       from documents d
	       left join document_branches b
	         on b.doc_id = d.id
	        and b.id = $2
	        and b.is_archived = false
       left join workspace_members m
         on m.workspace_id = d.workspace_id
        and m.user_id = $3
	      where d.id = $1
	        and ($2 is null or b.id is not null)`,
    [docId, branchId, user.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('branch_not_found');
  if (row.workspace_id) {
    if (row.member_role === 'Owner') return { userId: user.userId };
    throw new Error('forbidden');
  }
  if (row.owner_id === user.userId) return { userId: user.userId };
  throw new Error('forbidden');
}

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toAgentTokenSummary(row: AgentTokenRow) {
  return {
    tokenId: row.id,
    name: row.name,
    canRead: row.can_read,
    canWrite: row.can_write,
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
  };
}

function toShareLinkSummary(row: ShareLinkRow) {
  return {
    linkId: row.id,
    role: row.role,
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
  };
}

function normalizeSessions(value: unknown): AccessSessionListRow[] {
  if (Array.isArray(value)) return value as AccessSessionListRow[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as AccessSessionListRow[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toAccessSessionSummary(row: AccessSessionListRow) {
  return {
    sessionId: row.sessionId ?? row.session_id,
    clientKind: row.clientKind ?? row.client_kind,
    displayName: row.displayName ?? row.display_name,
    color: row.color,
    lastBranchId: row.lastBranchId ?? row.last_branch_id ?? null,
    lastSeenAt: toIsoString(row.lastSeenAt ?? row.last_seen_at ?? null),
  };
}

function toAccessGrantSummary(row: AccessGrantRow) {
  return {
    grantId: row.id,
    role: row.role,
    branchId: row.branch_id,
    branchName: row.branch_name,
    expiresAt: toIsoString(row.expires_at),
    revokedAt: toIsoString(row.revoked_at),
    createdAt: toIsoString(row.created_at),
    sessions: normalizeSessions(row.sessions).map(toAccessSessionSummary),
  };
}

export function createAccessRoutes(pool: DbPool, options: AccessRouteOptions = {}) {
  const router = Router();
  const authEnvironment = accessRouteAuthEnvironment(options.authEnvironment);

  router.get('/docs/:docId/branches/:branchId/access', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!authEnvironment.requireAuth) {
        if (authEnvironment.devAnonymousAccess) {
          res.json({ canRead: true, canWrite: true, actorType: 'user' });
          return;
        }
      }

      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      if (isAdminToken(bearerToken(req), authEnvironment.adminTokenHash)) {
        res.json({ canRead: true, canWrite: true, actorType: 'user' });
        return;
      }

      const readAccess = await verifyRequestDocumentAccess(pool, req, docId, branchId, 'read', authEnvironment);
      let canWrite = false;
      try {
        await verifyRequestDocumentAccess(pool, req, docId, branchId, 'write', authEnvironment);
        canWrite = true;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'forbidden') throw error;
      }

      res.json({
        canRead: true,
        canWrite,
        actorType: readAccess.actorType,
        ...(readAccess.grantId ? { grantId: readAccess.grantId } : {}),
        ...(readAccess.role ? { role: readAccess.role } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/agent-tokens', async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireAdmin(req, authEnvironment);
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const body = createAgentTokenSchema.parse(req.body);
      const token = generateAgentToken();
      const result = await pool.query<AgentTokenRow>(
        `insert into agent_tokens
           (doc_id, branch_id, token_hash, name, can_read, can_write, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, name, can_read, can_write, expires_at, created_at`,
        [docId, branchId, hashToken(token), body.name, body.canRead, body.canWrite, body.expiresAt ?? null],
      );
      const row = result.rows[0];
      if (!row) throw new Error('token_insert_failed');
      res.status(201).json({
        tokenId: row.id,
        token,
        name: row.name,
        canRead: row.can_read,
        canWrite: row.can_write,
        expiresAt: toIsoString(row.expires_at),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches/:branchId/agent-tokens', async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireAdmin(req, authEnvironment);
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const result = await pool.query<AgentTokenRow>(
        `select id, name, can_read, can_write, expires_at, created_at
           from agent_tokens
          where doc_id = $1
            and branch_id = $2
            and revoked_at is null
          order by created_at desc`,
        [docId, branchId],
      );
      res.json({ tokens: result.rows.map(toAgentTokenSummary) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/agent-tokens/:tokenId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireAdmin(req, authEnvironment);
      const tokenId = requiredParam(req, 'tokenId');
      const result = await pool.query<{ id: string }>(
        `update agent_tokens
            set revoked_at = now()
          where id = $1
            and revoked_at is null
          returning id`,
        [tokenId],
      );
      if (!result.rows[0]) throw new Error('token_not_found');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/access-grants', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const manager = await requireGrantManagementAccess(pool, req, docId, branchId, authEnvironment);
      const body = createAccessGrantSchema.parse(req.body);
      const token = generateAccessToken();
      const result = await pool.query<AccessGrantRow>(
        `insert into document_access_grants
           (doc_id, branch_id, workspace_id, folder_id, created_by_user_id, grant_kind, token_hash, role, expires_at)
         select d.id, b.id, d.workspace_id, d.folder_id, $6, 'access', $3, $4, $5
           from documents d
           join document_branches b
             on b.doc_id = d.id
            and b.id = $2
            and b.is_archived = false
          where d.id = $1
         returning id, branch_id, role, expires_at, revoked_at, created_at`,
        [docId, branchId, hashToken(token), body.role, body.expiresAt ?? null, manager.userId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('branch_not_found');
      res.status(201).json({
        grantId: row.id,
        branchId: row.branch_id,
        token,
        role: row.role,
        expiresAt: toIsoString(row.expires_at),
        createdAt: toIsoString(row.created_at),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches/:branchId/access-grants', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      await requireGrantManagementAccess(pool, req, docId, branchId, authEnvironment);
      const result = await pool.query<AccessGrantRow>(
        `select g.id,
                g.branch_id,
                b.name as branch_name,
                g.role,
                g.expires_at,
                g.revoked_at,
                g.created_at,
                coalesce(
                  json_agg(
                    json_build_object(
                      'sessionId', s.id,
                      'clientKind', s.client_kind,
                      'displayName', s.display_name,
                      'color', s.color,
                      'lastBranchId', s.last_branch_id,
                      'lastSeenAt', s.last_seen_at
                    )
                    order by s.last_seen_at desc
                  ) filter (where s.id is not null),
                  '[]'::json
                ) as sessions
           from (
             select *
               from document_access_grants
              where doc_id = $1
                and branch_id = $2
                and grant_kind = 'access'
                and revoked_at is null
           ) g
           join document_branches b on b.id = g.branch_id
           left join document_access_sessions s on s.grant_id = g.id
          group by g.id, g.branch_id, b.name, g.role, g.expires_at, g.revoked_at, g.created_at
          order by g.created_at desc`,
        [docId, branchId],
      );
      res.json({ grants: result.rows.map(toAccessGrantSummary) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/access-grants/:grantId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const grantId = requiredParam(req, 'grantId');
      const grantResult = await pool.query<{ doc_id: string; branch_id: string }>(
        `select doc_id, branch_id
          from document_access_grants
          where id = $1
            and grant_kind = 'access'
            and revoked_at is null`,
        [grantId],
      );
      const grant = grantResult.rows[0];
      if (!grant) throw new Error('access_grant_not_found');
      await requireGrantManagementAccess(pool, req, grant.doc_id, grant.branch_id, authEnvironment);
      const result = await pool.query<{ id: string }>(
        `update document_access_grants
            set revoked_at = now()
          where id = $1
            and grant_kind = 'access'
            and revoked_at is null
          returning id`,
        [grantId],
      );
      if (!result.rows[0]) throw new Error('access_grant_not_found');
      options.closeCollabDocumentConnections?.(toRoomName(grant.doc_id, grant.branch_id));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/access-sessions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const body = createAccessSessionSchema.parse(req.body);
      const access = await verifyRequestDocumentAccess(pool, req, docId, branchId, 'write', authEnvironment);
      if (!access.grantId || access.grantSource !== 'document_access_grants' || access.role !== 'edit') throw new Error('forbidden');

      const session = await createOrUpdateAccessSession(pool, {
        grantId: access.grantId,
        docId,
        branchId,
        clientId: body.clientId,
        clientKind: body.clientKind,
        displayName: body.displayName,
      });

      const status = session.createdAt === session.lastSeenAt ? 201 : 200;
      res.status(status).json({
        grantId: session.grantId,
        sessionId: session.sessionId,
        displayName: session.displayName,
        color: session.color,
        role: access.role,
        canRead: true,
        canWrite: true,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/share-links', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const manager = await requireGrantManagementAccess(pool, req, docId, branchId, authEnvironment);
      const body = createShareLinkSchema.parse(req.body);
      const token = generateShareToken();
      const result = await pool.query<ShareLinkRow>(
        `insert into document_access_grants
           (doc_id, branch_id, workspace_id, folder_id, created_by_user_id, grant_kind, token_hash, role, expires_at)
         select d.id, b.id, d.workspace_id, d.folder_id, $6, 'share', $3, $4, $5
           from documents d
           join document_branches b
             on b.doc_id = d.id
            and b.id = $2
            and b.is_archived = false
          where d.id = $1
         returning id, role, expires_at, created_at`,
        [docId, branchId, hashToken(token), body.role, body.expiresAt ?? null, manager.userId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('branch_not_found');
      res.status(201).json({
        linkId: row.id,
        token,
        role: row.role,
        expiresAt: toIsoString(row.expires_at),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches/:branchId/share-links', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      await requireGrantManagementAccess(pool, req, docId, branchId, authEnvironment);
      const result = await pool.query<ShareLinkRow>(
        `select id, role, expires_at, created_at
          from document_access_grants
          where doc_id = $1
            and (branch_id = $2 or branch_id is null)
            and grant_kind = 'share'
            and revoked_at is null
          order by created_at desc`,
        [docId, branchId],
      );
      res.json({ links: result.rows.map(toShareLinkSummary) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/share-links/:linkId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const linkId = requiredParam(req, 'linkId');
      const grantResult = await pool.query<{ doc_id: string; branch_id: string | null }>(
        `select doc_id, branch_id
          from document_access_grants
          where id = $1
            and grant_kind = 'share'
            and revoked_at is null`,
        [linkId],
      );
      const grant = grantResult.rows[0];
      if (!grant) throw new Error('share_link_not_found');
      await requireGrantManagementAccess(pool, req, grant.doc_id, grant.branch_id, authEnvironment);
      const result = await pool.query<{ id: string }>(
        `update document_access_grants
            set revoked_at = now()
          where id = $1
            and grant_kind = 'share'
            and revoked_at is null
          returning id`,
        [linkId],
      );
      if (!result.rows[0]) throw new Error('share_link_not_found');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
