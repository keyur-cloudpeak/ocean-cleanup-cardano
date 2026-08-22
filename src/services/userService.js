import crypto from 'crypto';
import { query } from '../config/connection.js';

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function ensureUserVerificationColumns() {
  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT;

    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verification_token_expires_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_users_email_verification_token_hash
      ON users (email_verification_token_hash);
  `);
}

function mapUserRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    username: row.username,
    password: row.password_hash,
    role: row.role,
    active: row.is_active,
    emailVerifiedAt: row.email_verified_at || null,
    organizationId: row.organization_id || null,
    jobTitle: row.job_title || null,
    yearsExperience: row.years_experience || null,
    profileImageUrl: row.profile_image_url || null,
    createdAt: row.created_at
  };
}

export async function getUsers() {
  await ensureUserVerificationColumns();
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at
     FROM users
     ORDER BY created_at DESC`
  );
  return result.rows.map(mapUserRow);
}

export async function saveUsers() {
  throw new Error('saveUsers is not supported when using PostgreSQL');
}

export async function findUserByUsername(username) {
  await ensureUserVerificationColumns();
  const normalizedUsername = normalizeUsername(username);
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at
     FROM users
     WHERE LOWER(username) = $1
     LIMIT 1`,
    [normalizedUsername]
  );

  return mapUserRow(result.rows[0]);
}

export async function findUserByEmail(email) {
  await ensureUserVerificationColumns();
  const normalizedEmail = normalizeEmail(email);
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at
     FROM users
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [normalizedEmail]
  );

  return mapUserRow(result.rows[0]);
}

export async function createUser(userData) {
  await ensureUserVerificationColumns();

  const id = Date.now().toString();
  const username = normalizeUsername(userData.username);
  const email = normalizeEmail(userData.email);
  const emailVerifiedAt = userData.emailVerifiedAt || null;
  const emailVerificationTokenHash = userData.emailVerificationTokenHash || null;
  const emailVerificationTokenExpiresAt = userData.emailVerificationTokenExpiresAt || null;

  const result = await query(
    `INSERT INTO users (id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, email_verification_token_hash, email_verification_token_expires_at, organization_id, job_title, years_experience, profile_image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at`,
    [
      id,
      userData.firstName,
      userData.lastName,
      email,
      username,
      userData.password,
      userData.role,
      userData.active !== false,
      emailVerifiedAt,
      emailVerificationTokenHash,
      emailVerificationTokenExpiresAt,
      userData.organizationId || null,
      userData.jobTitle || null,
      userData.yearsExperience || null,
      userData.profileImageUrl || null
    ]
  );

  return mapUserRow(result.rows[0]);
}

async function ensureUserLoginSocketColumn() {
  await query(`
    ALTER TABLE user_login
    ADD COLUMN IF NOT EXISTS socket_id TEXT;
  `);
}

export async function recordUserLogin({ userId, username, role, ipAddress = null, socketId = null }) {
  await ensureUserLoginSocketColumn();

  const result = await query(
    `INSERT INTO user_login (user_id, username, role, ip_address, socket_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, username, role, ip_address, socket_id, login_at`,
    [userId, username, role, ipAddress, socketId]
  );
  return result.rows[0];
}

export async function deleteUserLoginRecords(userId) {
  const result = await query(
    `DELETE FROM user_login
     WHERE user_id = $1
     RETURNING id`,
    [userId]
  );
  return result.rowCount;
}

export async function findUserById(id) {
  await ensureUserVerificationColumns();
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  return mapUserRow(result.rows[0]);
}

export async function setUserActiveStatus(id, isActive) {
  await ensureUserVerificationColumns();
  const result = await query(
    `UPDATE users
     SET is_active = $2
     WHERE id = $1
     RETURNING id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at`,
    [id, Boolean(isActive)]
  );

  return mapUserRow(result.rows[0]);
}

export async function updateUserProfile(id, profileData) {
  await ensureUserVerificationColumns();
  const result = await query(
    `UPDATE users
     SET first_name = COALESCE($2, first_name),
         last_name = COALESCE($3, last_name),
         job_title = COALESCE($4, job_title),
         years_experience = COALESCE($5, years_experience),
         profile_image_url = COALESCE($6, profile_image_url)
     WHERE id = $1
     RETURNING id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at`,
    [
      id,
      profileData.firstName || null,
      profileData.lastName || null,
      profileData.jobTitle || null,
      profileData.yearsExperience || null,
      profileData.profileImageUrl || null
    ]
  );
  return mapUserRow(result.rows[0]);
}

export async function findUserByEmailVerificationToken(token) {
  await ensureUserVerificationColumns();
  const tokenHash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at
     FROM users
     WHERE email_verification_token_hash = $1
       AND email_verification_token_expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );

  return mapUserRow(result.rows[0]);
}

export async function markUserEmailVerified(id) {
  await ensureUserVerificationColumns();
  const result = await query(
    `UPDATE users
     SET email_verified_at = NOW(),
         email_verification_token_hash = NULL,
         email_verification_token_expires_at = NULL
     WHERE id = $1
     RETURNING id, first_name, last_name, email, username, password_hash, role, is_active, email_verified_at, organization_id, job_title, years_experience, profile_image_url, created_at`,
    [id]
  );

  return mapUserRow(result.rows[0]);
}

export async function deleteUserById(id) {
  await ensureUserVerificationColumns();
  const result = await query(
    `DELETE FROM users
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rowCount;
}
