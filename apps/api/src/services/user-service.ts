import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { USER_SESSION_TTL_SECONDS } from '../config/provider-token-policy';
import type { DbExecutor, DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import { hashToken } from './access-control';

export const USER_SESSION_COOKIE = 'marklab_session';

export interface AuthenticatedUser {
  userId: string;
  email: string | null;
  displayName: string;
}

export interface AlphaLoginClaims {
  provider?: string;
  subject?: string;
  email: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
}

interface SessionUserRow extends UserRow {
  session_id: string;
}

export interface CreatedUserSession {
  user: AuthenticatedUser;
  sessionId: string;
  token: string;
  expiresAt: string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function bearerToken(req: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(req.header('authorization') ?? '');
  return match?.[1];
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

export function userSessionToken(req: Request): string | undefined {
  const bearer = bearerToken(req);
  if (bearer?.startsWith('ml_user_')) return bearer;
  return parseCookieHeader(req.header('cookie'))[USER_SESSION_COOKIE] ?? bearer;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('invalid_email');
  return email;
}

function normalizeDisplayName(claims: AlphaLoginClaims): string {
  const name = claims.name?.trim();
  if (name) return name;
  const given = claims.givenName?.trim() ?? '';
  const family = claims.familyName?.trim() ?? '';
  const combined = `${given} ${family}`.trim();
  if (combined) return combined;
  return normalizeEmail(claims.email);
}

export function normalizeOidcClaims(claims: AlphaLoginClaims): Required<Pick<AlphaLoginClaims, 'provider' | 'subject' | 'email' | 'name'>> {
  // Adapted from Relay's MIT-licensed OIDC claim normalization:
  // Copyright (c) 2024 No Instructions, LLC.
  const email = normalizeEmail(claims.email);
  return {
    provider: claims.provider?.trim() || 'alpha',
    subject: claims.subject?.trim() || email,
    email,
    name: normalizeDisplayName(claims),
  };
}

function sessionToken(): string {
  return `ml_user_${randomBytes(32).toString('base64url')}`;
}

function expiresAtSql(): string {
  return `now() + (${USER_SESSION_TTL_SECONDS} * interval '1 second')`;
}

function toUser(row: UserRow): AuthenticatedUser {
  return {
    userId: row.id,
    email: row.email,
    displayName: row.display_name,
  };
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: string; constraint?: string };
  return candidate.code === '23505' && (!constraint || candidate.constraint === constraint);
}

async function upsertUserBySubject(pool: DbExecutor, normalized: Required<Pick<AlphaLoginClaims, 'provider' | 'subject' | 'email' | 'name'>>): Promise<UserRow> {
  const result = await pool.query<UserRow>(
    `insert into users
       (email, display_name, auth_provider, auth_subject)
     values ($1, $2, $3, $4)
     on conflict (auth_provider, auth_subject) do update
       set email = excluded.email,
           display_name = excluded.display_name,
           updated_at = now()
     returning id, email, display_name`,
    [normalized.email, normalized.name, normalized.provider, normalized.subject],
  );
  const row = result.rows[0];
  if (!row) throw new Error('user_upsert_failed');
  return row;
}

async function rebindManualAlphaUserByEmail(pool: DbExecutor, normalized: Required<Pick<AlphaLoginClaims, 'provider' | 'subject' | 'email' | 'name'>>): Promise<UserRow | null> {
  if (normalized.provider === 'dev' || normalized.provider === 'manual-alpha') return null;
  const result = await pool.query<UserRow>(
    `update users
        set auth_provider = $3,
            auth_subject = $4,
            display_name = $2,
            updated_at = now()
      where email = $1
        and auth_provider = 'manual-alpha'
      returning id, email, display_name`,
    [normalized.email, normalized.name, normalized.provider, normalized.subject],
  );
  return result.rows[0] ?? null;
}

export async function upsertUserFromClaims(pool: DbExecutor, claims: AlphaLoginClaims): Promise<AuthenticatedUser> {
  const normalized = normalizeOidcClaims(claims);
  try {
    const rebound = await rebindManualAlphaUserByEmail(pool, normalized);
    if (rebound) return toUser(rebound);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error('email_already_linked');
    throw error;
  }
  try {
    return toUser(await upsertUserBySubject(pool, normalized));
  } catch (error) {
    if (!isUniqueViolation(error, 'users_email_key')) throw error;
  }
  throw new Error('email_already_linked');
}

export async function createUserSession(pool: DbPool, claims: AlphaLoginClaims): Promise<CreatedUserSession> {
  return withTransaction(pool, async (client) => {
    const user = await upsertUserFromClaims(client, claims);
    const token = sessionToken();
    const inserted = await client.query<{ id: string; expires_at: Date | string }>(
      `insert into user_sessions
         (user_id, token_hash, expires_at)
       values ($1, $2, ${expiresAtSql()})
       returning id, expires_at`,
      [user.userId, hashToken(token)],
    );
    const session = inserted.rows[0];
    if (!session) throw new Error('user_session_insert_failed');
    return {
      user,
      sessionId: session.id,
      token,
      expiresAt: toIsoString(session.expires_at),
    };
  });
}

export async function authenticateUserToken(pool: DbExecutor, token: string | undefined): Promise<AuthenticatedUser | null> {
  if (!token) return null;
  const result = await pool.query<SessionUserRow>(
    `update user_sessions s
        set last_seen_at = now()
       from users u
      where s.user_id = u.id
        and s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
      returning s.id as session_id, u.id, u.email, u.display_name`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

export async function authenticateRequestUser(pool: DbExecutor, req: Request): Promise<AuthenticatedUser | null> {
  const bearer = bearerToken(req);
  if (bearer?.startsWith('ml_user_')) return authenticateUserToken(pool, bearer);
  const cookie = parseCookieHeader(req.header('cookie'))[USER_SESSION_COOKIE];
  const first = cookie;
  const second = bearer;
  const user = await authenticateUserToken(pool, first);
  if (user || !second || second === first) return user;
  return authenticateUserToken(pool, second);
}

export async function revokeUserSession(pool: DbExecutor, token: string | undefined): Promise<void> {
  if (!token) return;
  await pool.query(
    `update user_sessions
        set revoked_at = now()
      where token_hash = $1
        and revoked_at is null`,
    [hashToken(token)],
  );
}
