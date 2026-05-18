import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DbPool } from '../db/client';
import { getWorkspaceBillingState } from '../services/billing-service';
import { authenticateRequestUser } from '../services/user-service';

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

export function createBillingRoutes(pool: DbPool) {
  const router = Router();

  router.get('/workspaces/:workspaceId/billing', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await requireUser(pool, req);
      const workspaceId = requiredParam(req, 'workspaceId');
      const billing = await getWorkspaceBillingState(pool, { workspaceId, userId: user.userId });
      res.json({ billing });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
