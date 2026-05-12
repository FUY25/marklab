import { randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { OIDC_LOGIN_STATE_TTL_SECONDS } from '../config/provider-token-policy';
import type { DbPool } from '../db/client';
import { hashToken } from '../services/access-control';
import {
  USER_SESSION_COOKIE,
  authenticateRequestUser,
  createUserSession,
  revokeUserSession,
  userSessionToken,
} from '../services/user-service';
import { buildOidcAuthorizationUrl, exchangeOidcCode, type OidcAuthConfig, type OidcExchange } from '../services/oidc-service';

const alphaLoginSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  givenName: z.string().min(1).max(80).optional(),
  familyName: z.string().min(1).max(80).optional(),
  subject: z.string().min(1).max(160).optional(),
});

const oidcCallbackSchema = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(32).max(512),
});

export interface AuthRouteOptions {
  devAuthEnabled?: boolean;
  cookieSecure?: boolean;
  oidcConfig?: OidcAuthConfig;
  oidcExchange?: OidcExchange;
}

const OIDC_STATE_COOKIE = 'marklab_oidc_state';

function authToken(): string {
  return randomBytes(32).toString('base64url');
}

function sessionCookie(token: string, options: AuthRouteOptions): string {
  const secure = options.cookieSecure ? '; Secure' : '';
  return `${USER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function oidcStateCookie(state: string, options: AuthRouteOptions): string {
  const secure = options.cookieSecure ? '; Secure' : '';
  return `${OIDC_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${OIDC_LOGIN_STATE_TTL_SECONDS}${secure}`;
}

function clearOidcStateCookie(options: AuthRouteOptions): string {
  const secure = options.cookieSecure ? '; Secure' : '';
  return `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function clearSessionCookie(options: AuthRouteOptions): string {
  const secure = options.cookieSecure ? '; Secure' : '';
  return `${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    try {
      cookies[rawName] = decodeURIComponent(rawValue.join('='));
    } catch {
      continue;
    }
  }
  return cookies;
}

export function createAuthRoutes(pool: DbPool, options: AuthRouteOptions = {}) {
  const router = Router();

  router.post('/auth/oidc/start', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!options.oidcConfig) throw new Error('oidc_not_configured');
      const state = authToken();
      const codeVerifier = authToken();
      await pool.query(
        `insert into oidc_login_states
           (state_hash, code_verifier, expires_at)
         values ($1, $2, now() + ($3 * interval '1 second'))`,
        [hashToken(state), codeVerifier, OIDC_LOGIN_STATE_TTL_SECONDS],
      );
      res.setHeader('set-cookie', oidcStateCookie(state, options));
      res.status(201).json({
        authorizationUrl: await buildOidcAuthorizationUrl({
          config: options.oidcConfig,
          state,
          codeVerifier,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/oidc/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!options.oidcConfig) throw new Error('oidc_not_configured');
      const body = oidcCallbackSchema.parse(req.body);
      const cookieState = parseCookieHeader(req.header('cookie'))[OIDC_STATE_COOKIE];
      if (!cookieState || cookieState !== body.state) throw new Error('oidc_login_state_invalid');
      const stateResult = await pool.query<{ code_verifier: string }>(
        `update oidc_login_states
            set used_at = now()
          where state_hash = $1
            and used_at is null
            and expires_at > now()
          returning code_verifier`,
        [hashToken(body.state)],
      );
      const codeVerifier = stateResult.rows[0]?.code_verifier;
      if (!codeVerifier) throw new Error('oidc_login_state_invalid');
      const claims = await (options.oidcExchange ?? exchangeOidcCode)({
        code: body.code,
        codeVerifier,
        config: options.oidcConfig,
      });
      const session = await createUserSession(pool, claims);
      res.setHeader('set-cookie', [sessionCookie(session.token, options), clearOidcStateCookie(options)]);
      res.status(201).json(session);
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/dev-login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!options.devAuthEnabled) throw new Error('dev_auth_disabled');
      const body = alphaLoginSchema.parse(req.body);
      const session = await createUserSession(pool, {
        provider: 'dev',
        email: body.email,
        ...(body.subject ? { subject: body.subject } : {}),
        ...(body.name ? { name: body.name } : {}),
        ...(body.givenName ? { givenName: body.givenName } : {}),
        ...(body.familyName ? { familyName: body.familyName } : {}),
      });
      res.setHeader('set-cookie', sessionCookie(session.token, options));
      res.status(201).json(session);
    } catch (error) {
      next(error);
    }
  });

  router.get('/auth/session', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await authenticateRequestUser(pool, req);
      if (!user) {
        res.status(401).json({ authenticated: false });
        return;
      }
      res.json({ authenticated: true, user });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/logout', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await revokeUserSession(pool, userSessionToken(req));
      res.setHeader('set-cookie', clearSessionCookie(options));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
