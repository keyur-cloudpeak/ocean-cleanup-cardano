import { query } from '../config/connection.js';

const ALLOWED_STATUSES = new Set(['pending', 'rejected', 'approved']);

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStatusFilter(value) {
  const normalized = normalizeStatus(value);
  return ALLOWED_STATUSES.has(normalized) ? normalized : null;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function mapReward(row) {
  if (!row?.reward_id && !row?.reward_tx_hash && row?.reward_amount == null && !row?.reward_token_type && !row?.reward_minted_at) {
    return null;
  }

  return {
    id: row.reward_id,
    txHash: row.reward_tx_hash,
    amount: row.reward_amount,
    tokenType: row.reward_token_type,
    mintedAt: row.reward_minted_at
  };
}

function mapActivityRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    category: row.category,
    location: row.location,
    quantity: row.quantity,
    volunteers: row.volunteers,
    evidenceHash: row.evidence_hash,
    contributorId: row.contributor_id,
    organizationId: row.organization_id,
    imageCid: row.image_cid,
    imageIpfsUrl: row.image_ipfs_url,
    imageGatewayUrl: row.image_gateway_url,
    lat: row.lat,
    lon: row.lon,
    gps: row.gps,
    notes: row.notes,
    timestamp: row.submitted_at,
    status: row.status,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    reward: mapReward(row)
  };
}

function makeActivityId() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function makeRewardId(activityId) {
  return `reward-${activityId}`;
}

function getActivitySelectColumns() {
  return `id, category, location, quantity, volunteers, evidence_hash, contributor_id, organization_id,
          image_cid, image_ipfs_url, image_gateway_url, lat, lon, gps, notes,
          submitted_at, status, review_note, reviewed_at,
          reward_id, reward_tx_hash, reward_amount, reward_token_type, reward_minted_at`;
}

export async function listActivities(statusFilter = null) {
  const normalizedStatus = normalizeStatusFilter(statusFilter);
  const params = [];
  let whereClause = '';

  if (normalizedStatus) {
    params.push(normalizedStatus);
    whereClause = 'WHERE status = $1';
  }

  const result = await query(
    `SELECT ${getActivitySelectColumns()}
     FROM activities
     ${whereClause}
     ORDER BY
       CASE status
         WHEN 'pending' THEN 0
         WHEN 'rejected' THEN 1
         WHEN 'approved' THEN 2
         ELSE 99
       END ASC,
       submitted_at DESC`,
    params
  );

  return {
    activities: result.rows.map(mapActivityRow),
    filters: {
      status: normalizedStatus,
      availableStatuses: ['pending', 'rejected', 'approved']
    }
  };
}

export async function getActivityById(id) {
  const result = await query(
    `SELECT ${getActivitySelectColumns()}
     FROM activities
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  return mapActivityRow(result.rows[0]);
}

export async function createActivity(payload) {
  const activityId = makeActivityId();
  const submittedAt = payload.timestamp ? new Date(payload.timestamp) : new Date();

  const result = await query(
    `INSERT INTO activities (
      id, category, location, quantity, volunteers, evidence_hash, contributor_id, organization_id,
      image_cid, image_ipfs_url, image_gateway_url, lat, lon, gps, notes, submitted_at, status
     ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16, 'pending'
     )
     RETURNING ${getActivitySelectColumns()}`,
    [
      activityId,
      payload.category,
      payload.location,
      normalizeNumber(payload.quantity),
      normalizeNumber(payload.volunteers) ?? 0,
      payload.evidenceHash || null,
      payload.contributorId || null,
      payload.organizationId || null,
      payload.imageCid || null,
      payload.imageIpfsUrl || null,
      payload.imageGatewayUrl || null,
      normalizeNumber(payload.lat),
      normalizeNumber(payload.lon),
      payload.gps || null,
      payload.notes || '',
      submittedAt
    ]
  );

  return mapActivityRow(result.rows[0]);
}

export async function reviewActivity(id, status, reviewNote = '') {
  const normalizedStatus = ALLOWED_STATUSES.has(normalizeStatus(status)) ? normalizeStatus(status) : 'approved';
  const result = await query(
    `UPDATE activities
     SET status = $2,
         review_note = $3,
         reviewed_at = NOW()
     WHERE id = $1
     RETURNING ${getActivitySelectColumns()}`,
    [id, normalizedStatus, reviewNote || '']
  );

  return mapActivityRow(result.rows[0]);
}

export async function mintReward(id, amount = 10, tokenType = 'OCEAN', txHash) {
  if (!txHash) {
    throw new Error('mintReward requires a txHash from a completed on-chain mint');
  }

  const result = await query(
    `UPDATE activities
     SET reward_id = COALESCE(reward_id, $2),
         reward_tx_hash = $3,
         reward_amount = $4,
         reward_token_type = $5,
         reward_minted_at = NOW()
     WHERE id = $1
     RETURNING ${getActivitySelectColumns()}`,
    [
      id,
      makeRewardId(id),
      txHash,
      normalizeNumber(amount) ?? 10,
      tokenType || 'OCEAN'
    ]
  );

  return mapActivityRow(result.rows[0]);
}

export async function deleteActivity(id) {
  const result = await query(
    `DELETE FROM activities
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rowCount > 0;
}

export async function getDashboardStats() {
  const result = await query(
    `SELECT
       COUNT(*)::int AS total_activities,
       COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_activities,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_activities,
       COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_activities,
       COALESCE(SUM(quantity), 0) AS total_kg_collected,
       COALESCE(SUM(quantity) FILTER (WHERE status = 'approved'), 0) AS approved_kg_collected,
       COALESCE(SUM(volunteers), 0)::int AS total_volunteers,
       COUNT(DISTINCT organization_id)::int AS partner_orgs,
       COUNT(*) FILTER (WHERE submitted_at >= NOW() - INTERVAL '30 days')::int AS recent_activities,
       MAX(submitted_at) AS latest_activity_at,
       (SELECT COUNT(*) FROM users WHERE role = 'verifier')::int AS verifier_count,
       (SELECT COUNT(*) FROM users WHERE role = 'contributor')::int AS contributor_count
     FROM activities`
  );

  const row = result.rows[0] || {};
  const totalActivities = Number(row.total_activities) || 0;
  const approvedActivities = Number(row.approved_activities) || 0;
  const pendingActivities = Number(row.pending_activities) || 0;
  const rejectedActivities = Number(row.rejected_activities) || 0;
  const totalKgCollected = Number(row.total_kg_collected) || 0;
  const approvedKgCollected = Number(row.approved_kg_collected) || 0;
  const totalVolunteers = Number(row.total_volunteers) || 0;
  const partnerOrgs = Number(row.partner_orgs) || 0;
  const recentActivities = Number(row.recent_activities) || 0;
  const latestActivityAt = row.latest_activity_at ? new Date(row.latest_activity_at).toISOString() : null;
  const impactCredits = approvedActivities * 10;
  const approvalRate = totalActivities > 0 ? Math.round((approvedActivities / totalActivities) * 100) : 0;
  const averageKgPerApprovedActivity = approvedActivities > 0
    ? Number((approvedKgCollected / approvedActivities).toFixed(1))
    : 0;
  const verifierCount = Number(row.verifier_count) || 0;
  const contributorCount = Number(row.contributor_count) || 0;

  return {
    totalActivities,
    approvedActivities,
    pendingActivities,
    rejectedActivities,
    totalKgCollected,
    approvedKgCollected,
    totalVolunteers,
    partnerOrgs,
    impactCredits,
    approvalRate,
    averageKgPerApprovedActivity,
    recentActivities,
    latestActivityAt,
    verifierCount,
    contributorCount
  };
}
