import {
  authSessionSchema,
  leaderboardVisibilitySchema,
  magicLinkStartRequestSchema,
  magicLinkStartResponseSchema,
  magicLinkVerifyRequestSchema,
  profileUpdateRequestSchema,
  userProfileSchema,
  userSchema
} from "@project-veritas/contracts";
import { createHttpLogger, createLogger } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { baseServiceEnvSchema, createEnv } from "@project-veritas/config";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4005),
  POSTGRES_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/veritas"),
  API_PREFIX: z.string().default("/api/identity"),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30)
});

const logger = createLogger("identity-service", env.LOG_LEVEL);
const app = express();

app.use(cors());
app.use(express.json());
app.use(createHttpLogger("identity-service", env.LOG_LEVEL));

function normalizeOptionalText(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\s+/g, " ") : undefined;
}

function titleizeSeed(text: string) {
  return text
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase())
    .join(" ");
}

async function bootstrapIdentitySchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar TEXT,
      school TEXT,
      major TEXT,
      country TEXT,
      bio TEXT,
      leaderboard_visibility TEXT NOT NULL DEFAULT 'private',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_magic_links (
      magic_link_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT NOT NULL,
      device_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      access_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureUserWithProfile(pool: Pool, email: string) {
  const existing = await pool.query(
    `
      SELECT
        users.user_id,
        users.email,
        users.created_at,
        users.updated_at,
        profiles.display_name,
        profiles.avatar,
        profiles.school,
        profiles.major,
        profiles.country,
        profiles.bio,
        profiles.leaderboard_visibility,
        profiles.created_at AS profile_created_at,
        profiles.updated_at AS profile_updated_at
      FROM users
      JOIN profiles ON profiles.user_id = users.user_id
      WHERE users.email = $1
    `,
    [email]
  );

  if (existing.rowCount && existing.rows[0]) {
    return existing.rows[0];
  }

  const userId = uuidv4();
  const displayName = titleizeSeed(email.split("@")[0] ?? "Real Talk User");

  await pool.query(
    `
      INSERT INTO users (user_id, email, updated_at)
      VALUES ($1, $2, NOW())
    `,
    [userId, email]
  );

  await pool.query(
    `
      INSERT INTO profiles (user_id, display_name, leaderboard_visibility, updated_at)
      VALUES ($1, $2, $3, NOW())
    `,
    [userId, displayName, "private"]
  );

  const created = await pool.query(
    `
      SELECT
        users.user_id,
        users.email,
        users.created_at,
        users.updated_at,
        profiles.display_name,
        profiles.avatar,
        profiles.school,
        profiles.major,
        profiles.country,
        profiles.bio,
        profiles.leaderboard_visibility,
        profiles.created_at AS profile_created_at,
        profiles.updated_at AS profile_updated_at
      FROM users
      JOIN profiles ON profiles.user_id = users.user_id
      WHERE users.user_id = $1
    `,
    [userId]
  );

  return created.rows[0];
}

function mapAuthRecord(row: Record<string, unknown>) {
  const user = userSchema.parse({
    userId: String(row.user_id),
    email: String(row.email),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  });

  const profile = userProfileSchema.parse({
    userId: user.userId,
    email: user.email,
    displayName: String(row.display_name),
    avatar: row.avatar ? String(row.avatar) : undefined,
    school: row.school ? String(row.school) : undefined,
    major: row.major ? String(row.major) : undefined,
    country: row.country ? String(row.country) : undefined,
    bio: row.bio ? String(row.bio) : undefined,
    leaderboardVisibility: leaderboardVisibilitySchema.parse(String(row.leaderboard_visibility)),
    createdAt: String(row.profile_created_at ?? row.created_at),
    updatedAt: String(row.profile_updated_at ?? row.updated_at)
  });

  return { user, profile };
}

function parseBearerToken(headerValue: string | undefined) {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token?.trim()) {
    return null;
  }

  return token.trim();
}

async function resolveAuthSession(pool: Pool, authorizationHeader: string | undefined) {
  const accessToken = parseBearerToken(authorizationHeader);
  if (!accessToken) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT
        users.user_id,
        users.email,
        users.created_at,
        users.updated_at,
        profiles.display_name,
        profiles.avatar,
        profiles.school,
        profiles.major,
        profiles.country,
        profiles.bio,
        profiles.leaderboard_visibility,
        profiles.created_at AS profile_created_at,
        profiles.updated_at AS profile_updated_at
      FROM auth_sessions
      JOIN users ON users.user_id = auth_sessions.user_id
      JOIN profiles ON profiles.user_id = users.user_id
      WHERE auth_sessions.access_token = $1 AND auth_sessions.expires_at > NOW()
    `,
    [accessToken]
  );

  if (result.rowCount === 0 || !result.rows[0]) {
    return null;
  }

  return mapAuthRecord(result.rows[0]);
}

async function attachGuestHistory(pool: Pool, userId: string, deviceId: string) {
  const sessionIdsResult = await pool.query(
    "SELECT session_id FROM sessions WHERE device_id = $1 AND user_id IS NULL",
    [deviceId]
  );

  const sessionIds = sessionIdsResult.rows.map((row) => String(row.session_id));
  if (sessionIds.length === 0) {
    return;
  }

  await pool.query("UPDATE sessions SET user_id = $1 WHERE session_id = ANY($2::text[])", [userId, sessionIds]);
  await pool.query("UPDATE transcript_segments SET user_id = $1 WHERE session_id = ANY($2::text[])", [userId, sessionIds]);
  await pool.query("UPDATE claims SET user_id = $1 WHERE session_id = ANY($2::text[])", [userId, sessionIds]);
  await pool.query("UPDATE interventions SET user_id = $1 WHERE session_id = ANY($2::text[])", [userId, sessionIds]);
  await pool.query("UPDATE session_scores SET user_id = $1 WHERE session_id = ANY($2::text[])", [userId, sessionIds]);
  await pool.query("UPDATE session_topics SET user_id = $1 WHERE session_id = ANY($2::text[])", [userId, sessionIds]);
  await pool.query("UPDATE claim_topics SET user_id = $1 WHERE session_id = ANY($2::text[])", [userId, sessionIds]);
}

async function bootstrap() {
  const pool = new Pool({
    connectionString: env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false }
  });
  await bootstrapIdentitySchema(pool);

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "identity"
    });
  });

  app.post(`${env.API_PREFIX}/auth/magic-link/start`, async (request, response) => {
    const payload = magicLinkStartRequestSchema.parse(request.body);
    const token = uuidv4().replace(/-/g, "").slice(0, 8).toUpperCase();
    const expiresAt = new Date(Date.now() + env.MAGIC_LINK_TTL_MINUTES * 60_000);

    await pool.query(
      `
        INSERT INTO auth_magic_links (magic_link_id, email, token, device_id, expires_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [uuidv4(), payload.email, token, payload.deviceId, expiresAt.toISOString()]
    );

    logger.info({ email: payload.email, token }, "Generated development magic link token");

    response.json(magicLinkStartResponseSchema.parse({
      ok: true,
      expiresInMinutes: env.MAGIC_LINK_TTL_MINUTES,
      previewCode: env.NODE_ENV === "production" ? undefined : token
    }));
  });

  app.post(`${env.API_PREFIX}/auth/magic-link/verify`, async (request, response) => {
    const payload = magicLinkVerifyRequestSchema.parse(request.body);
    const linkResult = await pool.query(
      `
        SELECT magic_link_id
        FROM auth_magic_links
        WHERE email = $1
          AND token = $2
          AND device_id = $3
          AND consumed_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [payload.email, payload.token, payload.deviceId]
    );

    if (linkResult.rowCount === 0 || !linkResult.rows[0]) {
      response.status(401).json({ message: "Magic link token is invalid or expired." });
      return;
    }

    const accountRow = await ensureUserWithProfile(pool, payload.email);
    const { user, profile } = mapAuthRecord(accountRow);
    const accessToken = uuidv4();
    const expiresAt = new Date(Date.now() + env.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60_000);

    await pool.query(
      "UPDATE auth_magic_links SET consumed_at = NOW() WHERE magic_link_id = $1",
      [String(linkResult.rows[0].magic_link_id)]
    );
    await pool.query(
      `
        INSERT INTO auth_sessions (access_token, user_id, expires_at)
        VALUES ($1, $2, $3)
      `,
      [accessToken, user.userId, expiresAt.toISOString()]
    );

    await attachGuestHistory(pool, user.userId, payload.deviceId);

    response.json(authSessionSchema.parse({
      accessToken,
      user,
      profile
    }));
  });

  app.get(`${env.API_PREFIX}/profile`, async (request, response) => {
    const session = await resolveAuthSession(pool, request.header("authorization"));
    if (!session) {
      response.status(401).json({ message: "Unauthorized" });
      return;
    }

    response.json(session.profile);
  });

  app.put(`${env.API_PREFIX}/profile`, async (request, response) => {
    const session = await resolveAuthSession(pool, request.header("authorization"));
    if (!session) {
      response.status(401).json({ message: "Unauthorized" });
      return;
    }

    const payload = profileUpdateRequestSchema.parse(request.body);
    await pool.query(
      `
        UPDATE profiles
        SET
          display_name = $2,
          avatar = $3,
          school = $4,
          major = $5,
          country = $6,
          bio = $7,
          leaderboard_visibility = $8,
          updated_at = NOW()
        WHERE user_id = $1
      `,
      [
        session.user.userId,
        payload.displayName.trim(),
        normalizeOptionalText(payload.avatar),
        normalizeOptionalText(payload.school),
        normalizeOptionalText(payload.major),
        normalizeOptionalText(payload.country),
        normalizeOptionalText(payload.bio),
        payload.leaderboardVisibility
      ]
    );

    const updated = await resolveAuthSession(pool, request.header("authorization"));
    response.json(updated?.profile ?? session.profile);
  });

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Identity service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Identity service failed to start");
  process.exit(1);
});
