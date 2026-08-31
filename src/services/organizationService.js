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

// ─── CONTRIBUTOR ORG CONTEXT (spec §19) ───────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * userBelongsToOrganization — true when this user is actually attached to
 * this org, via either their primary users.organization_id or a row in
 * organization_memberships (a contributor can belong to several).
 */
export async function userBelongsToOrganization(userId, orgId) {
  if (!userId || !UUID_PATTERN.test(orgId || '')) return false;
  const { rows } = await query(
    `SELECT 1 FROM users WHERE id = $1 AND organization_id = $2
     UNION
     SELECT 1 FROM organization_memberships WHERE user_id = $1 AND organization_id = $2
     LIMIT 1`,
    [userId, orgId]
  );
  return rows.length > 0;
}

/**
 * addOrganizationMembership — attaches a user to an org. Idempotent via the
 * table's own (user_id, organization_id) unique constraint. Best-effort:
 * used on the "create an org from the submit form" path, where failing to
 * record the membership must not fail the org creation itself.
 */
export async function addOrganizationMembership(userId, orgId, role = 'member') {
  if (!userId || !UUID_PATTERN.test(orgId || '')) return;
  try {
    await query(
      `INSERT INTO organization_memberships (user_id, organization_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [userId, orgId, role]
    );
  } catch (err) {
    console.error('[organizationService] failed to add membership:', err.message);
  }
}

/**
 * resolveContributorOrganization — decides which organization a submission
 * is filed under (spec §19: "Once authenticated, Blue Mind already knows
 * what organization you're associated with... ask again only when context
 * actually changes").
 *
 * Three distinct cases, which is why this can neither just read the
 * request nor just read the user:
 *
 *   omitted (undefined) → fall back to the contributor's own org. This is
 *                         the "don't make them re-enter it" case.
 *   explicitly empty    → honor it. Choosing "Individual" is a real choice
 *                         a contributor is allowed to make even when they
 *                         do belong to an org, so an empty value must
 *                         never be overwritten with their org.
 *   a specific org      → accepted only if they actually belong to it.
 *                         Without this check any caller could attribute a
 *                         submission to any organization on the platform,
 *                         quietly crediting their work to a reputable NGO.
 *
 * Returns { organizationId } on success or { error } for the caller to turn
 * into a 403. Never silently downgrades a claimed organization to null — a
 * submission the contributor believes is filed under their org must not
 * quietly become an individual one.
 */
export async function resolveContributorOrganization(userId, requestedOrganizationId) {
  if (requestedOrganizationId === undefined) {
    const { rows } = await query(`SELECT organization_id FROM users WHERE id = $1`, [userId]);
    return { organizationId: rows[0]?.organization_id || null };
  }

  if (requestedOrganizationId === null || requestedOrganizationId === '') {
    return { organizationId: null };
  }

  if (!UUID_PATTERN.test(requestedOrganizationId)) {
    return { error: 'organizationId is not a valid organization reference' };
  }

  if (!(await userBelongsToOrganization(userId, requestedOrganizationId))) {
    return { error: 'You are not a member of that organization' };
  }

  return { organizationId: requestedOrganizationId };
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
