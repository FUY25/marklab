import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import {
  generateAgentToken,
  generateShareToken,
  hashToken,
  isAdminToken,
  verifyAdminToken,
  verifyDocumentAccess,
} from '../services/access-control';

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

function authRequired(): boolean {
  return process.env.MARKLAB_REQUIRE_AUTH === 'true';
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

function requireAdmin(req: Request): void {
  if (!authRequired()) return;
  verifyAdminToken(bearerToken(req), process.env.MARKLAB_ADMIN_TOKEN_HASH);
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

export function createAccessRoutes(pool: DbPool) {
  const router = Router();

  router.get('/docs/:docId/branches/:branchId/access', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!authRequired()) {
        res.json({ canRead: true, canWrite: true, actorType: 'user' });
        return;
      }

      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const token = documentToken(req);
      if (isAdminToken(token, process.env.MARKLAB_ADMIN_TOKEN_HASH)) {
        res.json({ canRead: true, canWrite: true, actorType: 'user' });
        return;
      }

      const readAccess = await verifyDocumentAccess(pool, token, docId, branchId, 'read');
      let canWrite = false;
      try {
        await verifyDocumentAccess(pool, token, docId, branchId, 'write');
        canWrite = true;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'forbidden') throw error;
      }

      res.json({
        canRead: true,
        canWrite,
        actorType: readAccess.actorType,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/agent-tokens', async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireAdmin(req);
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
      requireAdmin(req);
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
      requireAdmin(req);
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

  router.post('/docs/:docId/branches/:branchId/share-links', async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireAdmin(req);
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const body = createShareLinkSchema.parse(req.body);
      const token = generateShareToken();
      const result = await pool.query<ShareLinkRow>(
        `insert into share_links
           (doc_id, branch_id, token_hash, role, expires_at)
         values ($1, $2, $3, $4, $5)
         returning id, role, expires_at, created_at`,
        [docId, branchId, hashToken(token), body.role, body.expiresAt ?? null],
      );
      const row = result.rows[0];
      if (!row) throw new Error('share_link_insert_failed');
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
      requireAdmin(req);
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const result = await pool.query<ShareLinkRow>(
        `select id, role, expires_at, created_at
           from share_links
          where doc_id = $1
            and branch_id = $2
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
      requireAdmin(req);
      const linkId = requiredParam(req, 'linkId');
      const result = await pool.query<{ id: string }>(
        `update share_links
            set revoked_at = now()
          where id = $1
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
