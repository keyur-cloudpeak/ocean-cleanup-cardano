import { query } from '../config/connection.js';

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
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
    organizationId: row.organization_id || null,
    jobTitle: row.job_title || null,
    yearsExperience: row.years_experience || null,
    walletAddress: row.wallet_address || null,
    createdAt: row.created_at
  };
}

export async function getUsers() {
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, organization_id, job_title, years_experience, wallet_address, created_at
     FROM users
     ORDER BY created_at DESC`
  );
  return result.rows.map(mapUserRow);
}

export async function saveUsers() {
  throw new Error('saveUsers is not supported when using PostgreSQL');
}

export async function findUserByUsername(username) {
  const normalizedUsername = normalizeUsername(username);
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, organization_id, job_title, years_experience, wallet_address, created_at
     FROM users
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [normalizedUsername]
  );

  return mapUserRow(result.rows[0]);
}

export async function findUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, organization_id, job_title, years_experience, wallet_address, created_at
     FROM users
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [normalizedEmail]
  );

  return mapUserRow(result.rows[0]);
}

export async function createUser(userData) {
  const id = Date.now().toString();
  const username = normalizeUsername(userData.username);
  const email = normalizeEmail(userData.email);

  const result = await query(
    `INSERT INTO users (id, first_name, last_name, email, username, password_hash, role, is_active, organization_id, job_title, years_experience, wallet_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, first_name, last_name, email, username, password_hash, role, is_active, organization_id, job_title, years_experience, wallet_address, created_at`,
    [
      id,
      userData.firstName,
      userData.lastName,
      email,
      username,
      userData.password,
      userData.role,
      userData.active !== false,
      userData.organizationId || null,
      userData.jobTitle || null,
      userData.yearsExperience || null,
      userData.walletAddress || null
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
  const result = await query(
    `SELECT id, first_name, last_name, email, username, password_hash, role, is_active, organization_id, job_title, years_experience, wallet_address, created_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  return mapUserRow(result.rows[0]);
}

export async function setUserWalletAddress(id, walletAddress) {
  const result = await query(
    `UPDATE users
     SET wallet_address = $2
     WHERE id = $1
     RETURNING id, first_name, last_name, email, username, password_hash, role, is_active, organization_id, job_title, years_experience, wallet_address, created_at`,
    [id, walletAddress || null]
  );

  return mapUserRow(result.rows[0]);
}

export async function setUserActiveStatus(id, isActive) {
  const result = await query(
    `UPDATE users
     SET is_active = $2
     WHERE id = $1
     RETURNING id, first_name, last_name, email, username, password_hash, role, is_active, organization_id, wallet_address, created_at`,
    [id, Boolean(isActive)]
  );

  return mapUserRow(result.rows[0]);
}
