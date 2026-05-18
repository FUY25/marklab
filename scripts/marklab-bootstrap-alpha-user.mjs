#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Client } = requireFromApi('pg');

const sessionTtlSeconds = 60 * 60 * 24 * 30;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function hashToken(token) {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

function sessionToken() {
  return `ml_user_${randomBytes(32).toString('base64url')}`;
}

async function main() {
  const databaseUrl = requiredEnv('DATABASE_URL');
  const email = requiredEnv('MARKLAB_BOOTSTRAP_EMAIL').toLowerCase();
  const displayName = process.env.MARKLAB_BOOTSTRAP_NAME?.trim() || email;
  const workspaceName = process.env.MARKLAB_BOOTSTRAP_WORKSPACE_NAME?.trim() || 'MarkLab Alpha Pilot';
  const planId = process.env.MARKLAB_BOOTSTRAP_PLAN_ID?.trim() || 'dev';
  const rotateExistingSessions = process.env.MARKLAB_BOOTSTRAP_ROTATE_SESSIONS !== '0';
  const token = sessionToken();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    let user = await client.query(
      `select id, email, display_name
         from users
        where email = $1
        limit 1`,
      [email],
    );
    if (!user.rows[0]) {
      user = await client.query(
        `insert into users
           (email, display_name, auth_provider, auth_subject)
         values ($1, $2, 'manual-alpha', $1)
         on conflict (auth_provider, auth_subject) do update
           set email = excluded.email,
               display_name = excluded.display_name,
               updated_at = now()
         returning id, email, display_name`,
        [email, displayName],
      );
    } else {
      await client.query(
        `update users
            set display_name = $2,
                updated_at = now()
          where id = $1`,
        [user.rows[0].id, displayName],
      );
    }
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('user_bootstrap_failed');

    if (rotateExistingSessions) {
      await client.query(
        `update user_sessions
            set revoked_at = now()
          where user_id = $1
            and revoked_at is null`,
        [userId],
      );
    }

    const workspace = await client.query(
      `insert into workspaces
         (name, owner_user_id)
       values ($1, $2)
       returning id, name`,
      [workspaceName, userId],
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) throw new Error('workspace_bootstrap_failed');

    await client.query(
      `insert into workspace_members
         (workspace_id, user_id, role)
       values ($1, $2, 'Owner')
       on conflict (workspace_id, user_id) do update
         set role = 'Owner',
             updated_at = now()`,
      [workspaceId, userId],
    );

    await client.query(
      `insert into subscriptions
         (workspace_id, plan_id, status, billing_mode, current_period_end)
       values ($1, $2, 'manual', 'manual', null)
       on conflict (workspace_id) do update
         set plan_id = excluded.plan_id,
             status = 'manual',
             billing_mode = 'manual',
             current_period_end = null,
             updated_at = now()`,
      [workspaceId, planId],
    );

    const session = await client.query(
      `insert into user_sessions
         (user_id, token_hash, expires_at)
       values ($1, $2, now() + ($3 * interval '1 second'))
       returning id, expires_at`,
      [userId, hashToken(token), sessionTtlSeconds],
    );
    await client.query('commit');
    console.log(JSON.stringify({
      ok: true,
      userId,
      email,
      workspaceId,
      workspaceName: workspace.rows[0]?.name ?? workspaceName,
      planId,
      userToken: token,
      sessionId: session.rows[0]?.id ?? null,
      expiresAt: session.rows[0]?.expires_at ?? null,
      rotatedExistingSessions: rotateExistingSessions,
      env: {
        MARKLAB_USER_TOKEN: token,
        MARKLAB_WORKSPACE_ID: workspaceId,
      },
    }, null, 2));
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
