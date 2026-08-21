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

  // Normalise image arrays: DB returns TEXT[] but may be null or legacy string
  const toArray = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    return [val]; // legacy single-string coercion
  };

  return {
    id: row.id,
    category: row.category,
    location: row.location,
    quantity: row.quantity,
    volunteers: row.volunteers,
    evidenceHash: row.evidence_hash,
    contributorId: row.contributor_id,
    organizationId: row.organization_id,
    imageCid: toArray(row.image_cid),
    imageIpfsUrl: toArray(row.image_ipfs_url),
    imageGatewayUrl: toArray(row.image_gateway_url),
    lat: row.lat,
    lon: row.lon,
    gps: row.gps,
    notes: row.notes,
    timestamp: row.submitted_at,
    status: row.status,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    shorelineType: row.shoreline_type,
    tideState: row.tide_state,
    cleanedBefore: row.cleaned_before,
    debrisLog: {
      'Cigarette butts': row.debris_cigarette_butts,
      'Food wrappers': row.debris_food_wrappers,
      'Bottle caps': row.debris_bottle_caps,
      'Fishing line and nets': row.debris_fishing_line,
      'Straws and bags': row.debris_straws,
      'Bottles and containers': row.debris_bottles
    },
    microplastics: row.microplastics,
    bulkItems: row.bulk_items,
    speciesSighted: row.species_sighted,
    condition: row.condition,
    habitatStress: row.habitat_stress,
    hazards: {
      medical: row.hazards_medical,
      chemical: row.hazards_chemical,
      unstable: row.hazards_unstable
    },
    instrument: row.instrument,
    timeSpent: row.time_spent,
    secondVerifier: row.second_verifier,
    disposalMethod: row.disposal_method,
    followUp: row.follow_up,
    reward: mapReward(row)
  };
}

function makeActivityId() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function getActivitySelectColumns() {
  return `id, category, location, quantity, volunteers, evidence_hash, contributor_id, organization_id,
          image_cid, image_ipfs_url, image_gateway_url, lat, lon, gps, notes,
          submitted_at, status, review_note, reviewed_at, reviewed_by,
          reward_id, reward_tx_hash, reward_amount, reward_token_type, reward_minted_at,
          shoreline_type, tide_state, cleaned_before, debris_cigarette_butts, debris_food_wrappers, debris_bottle_caps,
          debris_fishing_line, debris_straws, debris_bottles, microplastics, bulk_items, species_sighted, condition,
          habitat_stress, hazards_medical, hazards_chemical, hazards_unstable, instrument, time_spent, second_verifier,
          disposal_method, follow_up`;
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
      image_cid, image_ipfs_url, image_gateway_url, lat, lon, gps, notes, submitted_at, status,
      shoreline_type, tide_state, cleaned_before, debris_cigarette_butts, debris_food_wrappers, debris_bottle_caps,
      debris_fishing_line, debris_straws, debris_bottles, microplastics, bulk_items, species_sighted, condition,
      habitat_stress, hazards_medical, hazards_chemical, hazards_unstable, instrument, time_spent, second_verifier,
      disposal_method, follow_up
     ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16, 'pending',
      $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38
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
      payload.imageCids && payload.imageCids.length > 0 ? payload.imageCids : null,
      payload.imageIpfsUrls && payload.imageIpfsUrls.length > 0 ? payload.imageIpfsUrls : null,
      payload.imageGatewayUrls && payload.imageGatewayUrls.length > 0 ? payload.imageGatewayUrls : null,
      normalizeNumber(payload.lat),
      normalizeNumber(payload.lon),
      payload.gps || null,
      payload.notes || '',
      submittedAt,
      payload.shorelineType, payload.tideState, Boolean(payload.cleanedBefore),
      normalizeNumber(payload.debrisCigaretteButts), normalizeNumber(payload.debrisFoodWrappers), normalizeNumber(payload.debrisBottleCaps),
      normalizeNumber(payload.debrisFishingLine), normalizeNumber(payload.debrisStraws), normalizeNumber(payload.debrisBottles),
      payload.microplastics, payload.bulkItems, payload.speciesSighted, payload.condition, payload.habitatStress,
      Boolean(payload.hazardsMedical), Boolean(payload.hazardsChemical), Boolean(payload.hazardsUnstable),
      payload.instrument, normalizeNumber(payload.timeSpent), payload.secondVerifier, payload.disposalMethod, Boolean(payload.followUp)
    ]
  );

  return mapActivityRow(result.rows[0]);
}

export async function updateActivity(id, payload) {
  const updates = [];
  const values = [];
  let index = 1;

  const addField = (field, value) => {
    if (value !== undefined) {
      updates.push(`${field} = $${index++}`);
      values.push(value);
    }
  };

  addField('category', payload.category);
  addField('location', payload.location);
  addField('quantity', payload.quantity != null ? normalizeNumber(payload.quantity) : undefined);
  addField('volunteers', payload.volunteers != null ? normalizeNumber(payload.volunteers) : undefined);
  addField('evidence_hash', payload.evidenceHash);
  addField('organization_id', payload.organizationId);
  addField('image_cid', payload.imageCids !== undefined ? (payload.imageCids.length > 0 ? payload.imageCids : null) : undefined);
  addField('image_ipfs_url', payload.imageIpfsUrls !== undefined ? (payload.imageIpfsUrls.length > 0 ? payload.imageIpfsUrls : null) : undefined);
  addField('image_gateway_url', payload.imageGatewayUrls !== undefined ? (payload.imageGatewayUrls.length > 0 ? payload.imageGatewayUrls : null) : undefined);
  addField('lat', payload.lat != null ? normalizeNumber(payload.lat) : undefined);
  addField('lon', payload.lon != null ? normalizeNumber(payload.lon) : undefined);
  addField('gps', payload.gps);
  addField('notes', payload.notes);
  
  addField('shoreline_type', payload.shorelineType);
  addField('tide_state', payload.tideState);
  addField('cleaned_before', payload.cleanedBefore !== undefined ? Boolean(payload.cleanedBefore) : undefined);
  addField('debris_cigarette_butts', payload.debrisCigaretteButts !== undefined ? normalizeNumber(payload.debrisCigaretteButts) : undefined);
  addField('debris_food_wrappers', payload.debrisFoodWrappers !== undefined ? normalizeNumber(payload.debrisFoodWrappers) : undefined);
  addField('debris_bottle_caps', payload.debrisBottleCaps !== undefined ? normalizeNumber(payload.debrisBottleCaps) : undefined);
  addField('debris_fishing_line', payload.debrisFishingLine !== undefined ? normalizeNumber(payload.debrisFishingLine) : undefined);
  addField('debris_straws', payload.debrisStraws !== undefined ? normalizeNumber(payload.debrisStraws) : undefined);
  addField('debris_bottles', payload.debrisBottles !== undefined ? normalizeNumber(payload.debrisBottles) : undefined);
  addField('microplastics', payload.microplastics);
  addField('bulk_items', payload.bulkItems);
  addField('species_sighted', payload.speciesSighted);
  addField('condition', payload.condition);
  addField('habitat_stress', payload.habitatStress);
  addField('hazards_medical', payload.hazardsMedical !== undefined ? Boolean(payload.hazardsMedical) : undefined);
  addField('hazards_chemical', payload.hazardsChemical !== undefined ? Boolean(payload.hazardsChemical) : undefined);
  addField('hazards_unstable', payload.hazardsUnstable !== undefined ? Boolean(payload.hazardsUnstable) : undefined);
  addField('instrument', payload.instrument);
  addField('time_spent', payload.timeSpent !== undefined ? normalizeNumber(payload.timeSpent) : undefined);
  addField('second_verifier', payload.secondVerifier);
  addField('disposal_method', payload.disposalMethod);
  addField('follow_up', payload.followUp !== undefined ? Boolean(payload.followUp) : undefined);

  if (updates.length === 0) {
    return getActivityById(id);
  }

  const result = await query(
    `UPDATE activities
     SET ${updates.join(', ')}
     WHERE id = $${index}
     RETURNING ${getActivitySelectColumns()}`,
    [...values, id]
  );

  return mapActivityRow(result.rows[0]);
}

export async function reviewActivity(id, status, reviewNote = '', reviewerId = null) {
  const normalizedStatus = ALLOWED_STATUSES.has(normalizeStatus(status)) ? normalizeStatus(status) : 'approved';
  const result = await query(
    `UPDATE activities
     SET status = $2,
         review_note = $3,
         reviewed_at = NOW(),
         reviewed_by = $4
     WHERE id = $1
     RETURNING ${getActivitySelectColumns()}`,
    [id, normalizedStatus, reviewNote || '', reviewerId]
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

export async function getContributorStats(contributorId) {
  // Per-contributor aggregates + monthly deltas in one query
  const result = await query(
    `SELECT
       COUNT(*)::int                                                             AS total_activities,
       COUNT(*) FILTER (WHERE status = 'approved')::int                         AS approved_activities,
       COUNT(*) FILTER (WHERE status = 'pending')::int                          AS pending_activities,
       COUNT(*) FILTER (WHERE status = 'rejected')::int                         AS rejected_activities,
       COALESCE(SUM(quantity) FILTER (WHERE status = 'approved'), 0)            AS total_kg,
       COALESCE(SUM(volunteers) FILTER (WHERE status = 'approved'), 0)::int     AS total_volunteers,
       COALESCE((SELECT SUM(amount) FROM reward_ledger WHERE user_id = $1), 0)  AS total_points,
       -- This month
       COUNT(*) FILTER (WHERE submitted_at >= date_trunc('month', NOW()))::int              AS month_activities,
       COALESCE(SUM(quantity) FILTER (WHERE status = 'approved'
         AND submitted_at >= date_trunc('month', NOW())), 0)                    AS month_kg,
       COALESCE(SUM(volunteers) FILTER (WHERE status = 'approved'
         AND submitted_at >= date_trunc('month', NOW())), 0)::int               AS month_volunteers,
       -- Last month (for deltas)
       COALESCE(SUM(quantity) FILTER (WHERE status = 'approved'
         AND submitted_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
         AND submitted_at <  date_trunc('month', NOW())), 0)                    AS last_month_kg,
       COALESCE(SUM(volunteers) FILTER (WHERE status = 'approved'
         AND submitted_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
         AND submitted_at <  date_trunc('month', NOW())), 0)::int               AS last_month_volunteers
     FROM activities
     WHERE contributor_id = $1`,
    [contributorId]
  );

  // Rank: position of this contributor among all contributors by total approved kg (higher = better)
  const rankResult = await query(
    `SELECT rank
     FROM (
       SELECT contributor_id,
              RANK() OVER (ORDER BY COALESCE(SUM(quantity) FILTER (WHERE status = 'approved'), 0) DESC) AS rank
       FROM activities
       WHERE contributor_id IS NOT NULL
       GROUP BY contributor_id
     ) ranked
     WHERE contributor_id = $1`,
    [contributorId]
  );

  // Total contributor count (for "top X%" calculation)
  const countResult = await query(
    `SELECT COUNT(DISTINCT contributor_id)::int AS total
     FROM activities
     WHERE contributor_id IS NOT NULL`
  );

  const row = result.rows[0] || {};
  const rank = Number(rankResult.rows[0]?.rank) || null;
  const totalContributors = Number(countResult.rows[0]?.total) || 1;
  const topPercent = rank ? Math.round((rank / totalContributors) * 100) : null;

  return {
    totalActivities:   Number(row.total_activities)  || 0,
    approvedActivities:Number(row.approved_activities)|| 0,
    pendingActivities: Number(row.pending_activities) || 0,
    rejectedActivities:Number(row.rejected_activities)|| 0,
    totalKg:           Number(row.total_kg)           || 0,
    totalVolunteers:   Number(row.total_volunteers)   || 0,
    totalPoints:       Number(row.total_points)       || 0,
    totalTokens:       Number(row.total_points)       || 0,
    monthActivities:   Number(row.month_activities)   || 0,
    monthKg:           Number(row.month_kg)           || 0,
    monthVolunteers:   Number(row.month_volunteers)   || 0,
    lastMonthKg:       Number(row.last_month_kg)      || 0,
    lastMonthVolunteers:Number(row.last_month_volunteers)||0,
    rank,
    totalContributors,
    topPercent,
    approvalRate: (Number(row.total_activities) || 0) > 0
      ? Math.round((Number(row.approved_activities) / Number(row.total_activities)) * 100)
      : 0,
  };
}

/**
 * getContributorInsights — backs the "Top Locations / Disposal Method /
 * Wildlife & Environmental Impact" panel on the contributor overview page.
 * Location rows are grouped on the first comma-separated segment of the
 * address (the landmark) so nearby cleanups at the same site roll up
 * together instead of fragmenting into near-duplicate rows.
 */
export async function getContributorInsights(contributorId) {
  const locationsResult = await query(
    `SELECT split_part(location, ',', 1) AS location,
            COALESCE(SUM(quantity), 0) AS kg,
            COUNT(*)::int AS count
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
     GROUP BY split_part(location, ',', 1)
     ORDER BY kg DESC
     LIMIT 5`,
    [contributorId]
  );

  const disposalResult = await query(
    `SELECT LOWER(COALESCE(NULLIF(TRIM(disposal_method), ''), 'not specified')) AS key,
            COALESCE(SUM(quantity), 0) AS kg
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
     GROUP BY 1
     ORDER BY kg DESC`,
    [contributorId]
  );

  const wildlifeResult = await query(
    `SELECT LOWER(COALESCE(NULLIF(TRIM(condition), ''), 'not specified')) AS key,
            COUNT(*)::int AS count
     FROM activities
     WHERE contributor_id = $1 AND species_sighted IS NOT NULL AND TRIM(species_sighted) != ''
     GROUP BY 1
     ORDER BY count DESC`,
    [contributorId]
  );

  const totalResult = await query(
    `SELECT COUNT(*)::int AS total FROM activities WHERE contributor_id = $1`,
    [contributorId]
  );

  const locRows = locationsResult.rows.map(r => ({
    location: r.location?.trim() || 'Unspecified',
    kg: Number(r.kg) || 0,
    count: Number(r.count) || 0,
  }));
  const maxLocKg = locRows[0]?.kg || 1;
  const topLocations = locRows.map(r => ({ ...r, pct: Math.round((r.kg / maxLocKg) * 100) }));

  const dispRows = disposalResult.rows.map(r => ({ key: r.key, kg: Number(r.kg) || 0 }));
  const totalDisposalKg = dispRows.reduce((s, r) => s + r.kg, 0) || 1;
  const disposalStats = dispRows.map(r => ({ ...r, pct: Math.round((r.kg / totalDisposalKg) * 100) }));

  const wildlifeRows = wildlifeResult.rows.map(r => ({ key: r.key, count: Number(r.count) || 0 }));
  const totalSightings = wildlifeRows.reduce((s, r) => s + r.count, 0);
  const totalActivities = Number(totalResult.rows[0]?.total) || 0;
  const wildlifeBreakdown = wildlifeRows.map(r => ({
    ...r,
    pct: Math.round((r.count / (totalSightings || 1)) * 100),
  }));

  return {
    topLocations,
    disposalStats,
    wildlife: {
      total: totalSightings,
      pctOfCleanups: totalActivities ? Math.round((totalSightings / totalActivities) * 100) : 0,
      breakdown: wildlifeBreakdown,
    },
  };
}

/**
 * getContributorExportSummary — total submitted vs. approved counts for a
 * contributor within a date range, used to compute the approval rate shown
 * on the field report PDF (the export itself only lists approved rows).
 */
export async function getContributorExportSummary(contributorId, from, to) {
  const result = await query(
    `SELECT
       COUNT(*)::int                                       AS total_submitted,
       COUNT(*) FILTER (WHERE status = 'approved')::int     AS total_approved
     FROM activities
     WHERE contributor_id = $1
       AND submitted_at::date BETWEEN $2::date AND $3::date`,
    [contributorId, from, to]
  );

  const row = result.rows[0] || {};
  return {
    totalSubmitted: Number(row.total_submitted) || 0,
    totalApproved: Number(row.total_approved) || 0,
  };
}

/**
 * getContributorExportActivities — approved activities for the contributor
 * field report PDF, scoped to a submitted_at date range.
 */
export async function getContributorExportActivities(contributorId, from, to) {
  const result = await query(
    `SELECT location, category, quantity, disposal_method, shoreline_type, tide_state,
            hazards_medical, hazards_chemical, hazards_unstable, species_sighted,
            habitat_stress, condition, submitted_at, onchain_tx_hash, onchain_status
     FROM activities
     WHERE contributor_id = $1
       AND status = 'approved'
       AND submitted_at::date BETWEEN $2::date AND $3::date
     ORDER BY submitted_at DESC`,
    [contributorId, from, to]
  );

  return result.rows.map((row) => ({
    location: row.location,
    category: row.category,
    quantity: Number(row.quantity) || 0,
    disposalMethod: row.disposal_method,
    shorelineType: row.shoreline_type,
    tideState: row.tide_state,
    hazards: {
      medical: row.hazards_medical,
      chemical: row.hazards_chemical,
      unstable: row.hazards_unstable,
    },
    speciesSighted: row.species_sighted,
    habitatStress: row.habitat_stress,
    condition: row.condition,
    submittedAt: row.submitted_at,
    onchainTxHash: row.onchain_tx_hash,
    onchainStatus: row.onchain_status,
  }));
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
       (select count(*) from organizations) as partner_orgs,
       COUNT(*) FILTER (WHERE submitted_at >= NOW() - INTERVAL '30 days')::int AS recent_activities,
       MAX(submitted_at) AS latest_activity_at,
       (SELECT COUNT(*) FROM users WHERE role = 'verifier')::int AS verifier_count,
       (SELECT COUNT(*) FROM users WHERE role = 'contributor')::int AS contributor_count,
       (SELECT COALESCE(SUM(amount), 0) FROM reward_ledger) AS impact_credits
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
  const impactCredits = Number(row.impact_credits) || 0;
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
