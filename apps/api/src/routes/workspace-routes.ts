import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import { authenticateRequestUser } from '../services/user-service';
import {
  createWorkspace,
  createWorkspaceShareKey,
  joinWorkspaceWithShareKey,
  listWorkspaceDocuments,
  listWorkspaceMembers,
  removeWorkspaceMember,
  revokeWorkspaceShareKey,
  updateWorkspaceMemberRole,
} from '../services/workspace-service';

const workspaceRoleSchema = z.enum(['Owner', 'Member', 'Reader']);
const workspaceInviteRoleSchema = z.enum(['Member', 'Reader']);

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const createShareKeySchema = z.object({
  role: workspaceInviteRoleSchema.default('Member'),
  expiresAt: z.string().datetime().nullable().optional(),
});

const joinWorkspaceSchema = z.object({
  token: z.string().min(16),
});

const updateMemberRoleSchema = z.object({
  role: workspaceRoleSchema,
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

async function requireUser(pool: DbPool, req: Request) {
  const user = await authenticateRequestUser(pool, req);
  if (!user) throw new Error('unauthorized');
  return user;
}

export function createWorkspaceRoutes(pool: DbPool) {
  const router = Router();

  router.post('/workspaces', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const body = createWorkspaceSchema.parse(req.body);
      const workspace = await createWorkspace(pool, { userId: user.userId, name: body.name });
      res.status(201).json({ workspace });
    } catch (error) {
      next(error);
    }
  });

  router.get('/workspaces/:workspaceId/members', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const workspaceId = requiredParam(req, 'workspaceId');
      const members = await listWorkspaceMembers(pool, { workspaceId, userId: user.userId });
      res.json({ members });
    } catch (error) {
      next(error);
    }
  });

  router.post('/workspaces/:workspaceId/share-keys', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const workspaceId = requiredParam(req, 'workspaceId');
      const body = createShareKeySchema.parse(req.body);
      const key = await createWorkspaceShareKey(pool, {
        workspaceId,
        userId: user.userId,
        role: body.role,
        expiresAt: body.expiresAt ?? null,
      });
      res.status(201).json({ key });
    } catch (error) {
      next(error);
    }
  });

  router.post('/workspaces/join', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const body = joinWorkspaceSchema.parse(req.body);
      const workspace = await joinWorkspaceWithShareKey(pool, { userId: user.userId, token: body.token });
      res.status(201).json({ workspace });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/workspaces/:workspaceId/share-keys/:keyId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const workspaceId = requiredParam(req, 'workspaceId');
      const keyId = requiredParam(req, 'keyId');
      await revokeWorkspaceShareKey(pool, { workspaceId, userId: user.userId, keyId });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.patch('/workspaces/:workspaceId/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const workspaceId = requiredParam(req, 'workspaceId');
      const targetUserId = requiredParam(req, 'userId');
      const body = updateMemberRoleSchema.parse(req.body);
      const member = await updateWorkspaceMemberRole(pool, {
        workspaceId,
        actorUserId: user.userId,
        targetUserId,
        role: body.role,
      });
      res.json({ member });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/workspaces/:workspaceId/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const workspaceId = requiredParam(req, 'workspaceId');
      const targetUserId = requiredParam(req, 'userId');
      await removeWorkspaceMember(pool, { workspaceId, actorUserId: user.userId, targetUserId });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/workspaces/:workspaceId/documents', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const workspaceId = requiredParam(req, 'workspaceId');
      const documents = await listWorkspaceDocuments(pool, { workspaceId, userId: user.userId });
      res.json({ documents });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
