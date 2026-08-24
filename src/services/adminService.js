import crypto from 'crypto';
import { query } from '../config/connection.js';
import { toTrimmedLower } from '../utils/normalize.js';

function mapAdminRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    password: row.password_hash,
    role: 'admin',
    active: row.is_active,
    passwordSet: Boolean(row.password_hash),
    invitedBy: row.invited_by,
    createdAt: row.created_at
  };
}

const SELECT_COLS = `id, first_name, last_name, email, password_hash, is_active, invited_by, created_at`;

export async function listAdmins() {
  const result = await query(
    `SELECT ${SELECT_COLS} FROM admins ORDER BY created_at DESC`
  );
  return result.rows.map(mapAdminRow);
}

export async function findAdminByEmail(email) {
  const result = await query(
    `SELECT ${SELECT_COLS} FROM admins WHERE LOWER(email) = $1 LIMIT 1`,
    [toTrimmedLower(email)]
  );
  return mapAdminRow(result.rows[0]);
}

export async function findAdminById(id) {
  const result = await query(
    `SELECT ${SELECT_COLS} FROM admins WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapAdminRow(result.rows[0]);
}

export async function createAdminInvite({ email, firstName, lastName, invitedBy, inviteTokenHash, inviteTokenExpiresAt }) {
  const id = Date.now().toString();
  const result = await query(
    `INSERT INTO admins (id, first_name, last_name, email, invited_by, invite_token_hash, invite_token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT_COLS}`,
    [id, firstName || null, lastName || null, toTrimmedLower(email), invitedBy || null, inviteTokenHash, inviteTokenExpiresAt]
  );
  return mapAdminRow(result.rows[0]);
}

export async function findAdminByInviteToken(token) {
  const tokenHash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const result = await query(
    `SELECT ${SELECT_COLS} FROM admins
     WHERE invite_token_hash = $1
       AND invite_token_expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return mapAdminRow(result.rows[0]);
}

export async function setAdminPassword(id, passwordHash) {
  const result = await query(
    `UPDATE admins
     SET password_hash = $2,
         invite_token_hash = NULL,
         invite_token_expires_at = NULL,
         password_set_at = NOW()
     WHERE id = $1
     RETURNING ${SELECT_COLS}`,
    [id, passwordHash]
  );
  return mapAdminRow(result.rows[0]);
}

export async function deleteAdminById(id) {
  const result = await query(
    `DELETE FROM admins WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.rowCount;
}
