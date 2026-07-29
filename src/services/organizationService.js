import { query } from '../config/connection.js';

/** Map a raw DB row → camelCase org object */
function mapOrgRow(row) {
  if (!row) return null;
  return {
    orgId:        row.org_id,
    name:         row.name,
    region:       row.region,
    country:      row.country,
    parentOrgId:  row.parent_org_id,
    contactEmail: row.contact_email,
    joinedAt:     row.joined_at,
    isActive:     row.is_active,
  };
}

const SELECT_COLS = `
  org_id, name, region, country, parent_org_id,
  contact_email, joined_at, is_active
`;

// ─── LIST ────────────────────────────────────────────────────────────────────

/**
 * Return all organizations, with optional filter on is_active.
 * @param {boolean|undefined} isActive  – undefined = no filter
 */
export async function listOrganizations(isActive) {
  const conditions = [];
  const params     = [];

  if (isActive !== undefined) {
    params.push(isActive);
    conditions.push(`is_active = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT ${SELECT_COLS} FROM organizations ${where} ORDER BY joined_at DESC`
  , params);

  return result.rows.map(mapOrgRow);
}

// ─── GET BY ID ────────────────────────────────────────────────────────────────

export async function getOrganizationById(orgId) {
  const result = await query(
    `SELECT ${SELECT_COLS} FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId]
  );
  return mapOrgRow(result.rows[0]);
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

export async function createOrganization(data) {
  const { name, region, country, parentOrgId, contactEmail, isActive } = data;

  if (!name) throw new Error('Organization name is required');

  const result = await query(
    `INSERT INTO organizations
       (name, region, country, parent_org_id, contact_email, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLS}`,
    [
      name,
      region   ?? null,
      country  ?? null,
      parentOrgId ?? null,
      contactEmail ?? null,
      isActive !== false   // default true
    ]
  );

  return mapOrgRow(result.rows[0]);
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

export async function updateOrganization(orgId, data) {
  const { name, region, country, parentOrgId, contactEmail, isActive } = data;

  const result = await query(
    `UPDATE organizations
     SET
       name           = COALESCE($2, name),
       region         = COALESCE($3, region),
       country        = COALESCE($4, country),
       parent_org_id  = COALESCE($5, parent_org_id),
       contact_email  = COALESCE($6, contact_email),
       is_active      = COALESCE($7, is_active)
     WHERE org_id = $1
     RETURNING ${SELECT_COLS}`,
    [
      orgId,
      name         ?? null,
      region       ?? null,
      country      ?? null,
      parentOrgId  ?? null,
      contactEmail ?? null,
      isActive !== undefined ? Boolean(isActive) : null
    ]
  );

  return mapOrgRow(result.rows[0]);
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export async function deleteOrganization(orgId) {
  const result = await query(
    `DELETE FROM organizations WHERE org_id = $1 RETURNING org_id`,
    [orgId]
  );
  return result.rows[0] ?? null;
}

// ─── TOGGLE ACTIVE ────────────────────────────────────────────────────────────

export async function setOrganizationActiveStatus(orgId, isActive) {
  const result = await query(
    `UPDATE organizations
     SET is_active = $2
     WHERE org_id = $1
     RETURNING ${SELECT_COLS}`,
    [orgId, Boolean(isActive)]
  );
  return mapOrgRow(result.rows[0]);
}
