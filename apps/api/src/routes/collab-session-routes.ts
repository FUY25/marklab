import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';
import type { DbPool } from '../db/client';
import type { HttpAppOptions, HttpRequestAuth } from '../http/app';
import { readBranchState } from '../services/doc-read';
import { ensureProviderDocId, recordProviderTokenIssuance } from '../services/provider-doc-service';

const collabSessionSchema = z.object({
  mode: z.enum(['view', 'edit']),
  clientKind: z.enum(['browser', 'app', 'daemon', 'agent', 'guest']).default('browser'),
  displayName: z.string().trim().min(1).max(80).default('Guest'),
  sessionId: z.string().trim().min(1).optional(),
});

const providerTokenRefreshSchema = z.object({
  clientKind: z.enum(['browser', 'app', 'daemon', 'agent', 'guest']).default('browser'),
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

export function createCollabSessionRoutes(pool: DbPool, options: HttpAppOptions = {}) {
  const router = Router();

  router.post('/docs/:docId/branches/:branchId/collab/session', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const body = collabSessionSchema.parse(req.body);
      const sessionId = body.sessionId ?? `session_${randomUUID()}`;
      const auth = requireAuth(options);

      if (body.mode === 'view') {
        await auth.requireDocumentAccess(req, docId, branchId, 'read');
        const document = await readBranchState(pool, docId, branchId);
        res.status(200).json({
          mode: 'view',
          session: {
            sessionId,
            clientKind: body.clientKind,
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

      await auth.requireDocumentAccess(req, docId, branchId, 'write');
      const providerDocId = await ensureProviderDocId(pool, branchId);
      const providerTokenService = requireProviderTokenService(options);
      const providerToken = await providerTokenService.issueProviderToken({
        providerDocId,
        sessionId,
        authorization: 'full',
        validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
      });
      await recordProviderTokenIssuance(pool, {
        docId,
        branchId,
        providerDocId,
        sessionId,
        clientKind: body.clientKind,
        authorization: 'full',
        validForSeconds: providerToken.validForSeconds,
      });

      res.status(201).json({
        mode: 'edit',
        session: {
          sessionId,
          clientKind: body.clientKind,
          displayName: body.displayName,
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
        const body = providerTokenRefreshSchema.parse(req.body);
        const auth = requireAuth(options);

        await auth.requireDocumentAccess(req, docId, branchId, 'write');
        const providerDocId = await ensureProviderDocId(pool, branchId);
        const providerTokenService = requireProviderTokenService(options);
        const providerToken = await providerTokenService.issueProviderToken({
          providerDocId,
          sessionId,
          authorization: 'full',
          validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
        });
        await recordProviderTokenIssuance(pool, {
          docId,
          branchId,
          providerDocId,
          sessionId,
          clientKind: body.clientKind,
          authorization: 'full',
          validForSeconds: providerToken.validForSeconds,
        });

        res.status(200).json({ providerToken });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
