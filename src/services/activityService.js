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

function normalizeBrandsIdentified(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
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
    brandsIdentified: row.brands_identified || {},
    surveyLengthM: row.survey_length_m,
    surveyAreaSqm: row.survey_area_sqm,
    surveyMethod: row.survey_method,
    debrisSource: row.debris_source,
    weatherConditions: row.weather_conditions,
    daysSinceRain: row.days_since_rain,
    windSpeedKmh: row.wind_speed_kmh,
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
          disposal_method, follow_up, brands_identified, survey_length_m, survey_area_sqm, survey_method,
          debris_source, weather_conditions, days_since_rain, wind_speed_kmh`;
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
      disposal_method, follow_up, brands_identified, survey_length_m, survey_area_sqm, survey_method, debris_source
     ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16, 'pending',
      $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39,
      $40, $41, $42, $43
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
      payload.instrument, normalizeNumber(payload.timeSpent), payload.secondVerifier, payload.disposalMethod, Boolean(payload.followUp),
      normalizeBrandsIdentified(payload.brandsIdentified),
      normalizeNumber(payload.surveyLengthM), normalizeNumber(payload.surveyAreaSqm), payload.surveyMethod, payload.debrisSource
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
  addField('brands_identified', payload.brandsIdentified !== undefined ? normalizeBrandsIdentified(payload.brandsIdentified) : undefined);
  addField('survey_length_m', payload.surveyLengthM !== undefined ? normalizeNumber(payload.surveyLengthM) : undefined);
  addField('survey_area_sqm', payload.surveyAreaSqm !== undefined ? normalizeNumber(payload.surveyAreaSqm) : undefined);
  addField('survey_method', payload.surveyMethod);
  addField('debris_source', payload.debrisSource);
  // Weather fields are system-populated (see weatherService.js) and are never
  // taken from a contributor-facing request body — only internal callers
  // (the post-create background fetch, the backfill script) pass these.
  addField('weather_conditions', payload.weatherConditions);
  addField('days_since_rain', payload.daysSinceRain !== undefined ? normalizeNumber(payload.daysSinceRain) : undefined);
  addField('wind_speed_kmh', payload.windSpeedKmh !== undefined ? normalizeNumber(payload.windSpeedKmh) : undefined);

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

const DEBRIS_ITEMS = [
  { key: 'cigaretteButts', label: 'Cigarette butts', column: 'cigarette_butts' },
  { key: 'foodWrappers', label: 'Food wrappers', column: 'food_wrappers' },
  { key: 'bottleCaps', label: 'Bottle caps', column: 'bottle_caps' },
  { key: 'fishingLine', label: 'Fishing line and nets', column: 'fishing_line' },
  { key: 'straws', label: 'Straws and bags', column: 'straws' },
  { key: 'bottles', label: 'Bottles and containers', column: 'bottles' },
];

/**
 * computeTrend — for monitoredSites, compares total kg collected in the most
 * recent half of visits to a location against the earlier half. A drop of
 * more than 10% reads as the site getting cleaner ("improving"); a rise of
 * more than 10% reads as it re-accumulating waste ("worsening").
 */
function computeTrend(earlierTotal, recentTotal) {
  if (earlierTotal === 0) return recentTotal > 0 ? 'worsening' : 'stable';
  const ratio = recentTotal / earlierTotal;
  if (ratio <= 0.9) return 'improving';
  if (ratio >= 1.1) return 'worsening';
  return 'stable';
}

/**
 * getContributorInsights — backs the "Top Locations / Disposal Method /
 * Wildlife & Environmental Impact" panel on the contributor overview page,
 * plus the site-condition, hazard, debris, pollution, habitat, field-
 * efficiency, data-quality, and monitored-site cards that surface the rest
 * of the fields captured on the submission form but otherwise unused.
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

  const siteConditionsResult = await query(
    `SELECT COALESCE(NULLIF(TRIM(shoreline_type), ''), 'Unspecified') AS shoreline_type,
            COALESCE(NULLIF(TRIM(tide_state), ''), 'Unspecified') AS tide_state,
            COUNT(*)::int AS count
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
     GROUP BY 1, 2
     ORDER BY count DESC`,
    [contributorId]
  );

  const hazardRowsResult = await query(
    `SELECT location, submitted_at, hazards_medical, hazards_chemical, hazards_unstable
     FROM activities
     WHERE contributor_id = $1 AND (hazards_medical OR hazards_chemical OR hazards_unstable)
     ORDER BY submitted_at DESC`,
    [contributorId]
  );

  const debrisResult = await query(
    `SELECT COALESCE(SUM(debris_cigarette_butts), 0) AS cigarette_butts,
            COALESCE(SUM(debris_food_wrappers), 0)   AS food_wrappers,
            COALESCE(SUM(debris_bottle_caps), 0)     AS bottle_caps,
            COALESCE(SUM(debris_fishing_line), 0)    AS fishing_line,
            COALESCE(SUM(debris_straws), 0)          AS straws,
            COALESCE(SUM(debris_bottles), 0)         AS bottles
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'`,
    [contributorId]
  );

  const microplasticsResult = await query(
    `SELECT TRIM(LOWER(microplastics)) AS key, COUNT(*)::int AS count
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
       AND microplastics IS NOT NULL AND TRIM(microplastics) != ''
       AND TRIM(LOWER(microplastics)) != 'none observed'
     GROUP BY 1
     ORDER BY count DESC`,
    [contributorId]
  );

  const bulkItemsResult = await query(
    `SELECT bulk_items, location, submitted_at
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
       AND bulk_items IS NOT NULL AND TRIM(bulk_items) != ''
     ORDER BY submitted_at DESC
     LIMIT 10`,
    [contributorId]
  );

  const habitatStressResult = await query(
    `SELECT LOWER(TRIM(habitat_stress)) AS key, MIN(TRIM(habitat_stress)) AS label, COUNT(*)::int AS count
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
       AND habitat_stress IS NOT NULL AND TRIM(habitat_stress) != ''
     GROUP BY 1
     ORDER BY count DESC
     LIMIT 8`,
    [contributorId]
  );

  const speciesObservationsResult = await query(
    `SELECT LOWER(TRIM(species_sighted)) AS key, MIN(TRIM(species_sighted)) AS label, COUNT(*)::int AS count
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
       AND species_sighted IS NOT NULL AND TRIM(species_sighted) != ''
     GROUP BY 1
     ORDER BY count DESC
     LIMIT 8`,
    [contributorId]
  );

  const fieldTimeResult = await query(
    `SELECT COALESCE(SUM(time_spent), 0) AS total_hours,
            COALESCE(SUM(quantity), 0)   AS total_kg
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved' AND time_spent IS NOT NULL`,
    [contributorId]
  );

  const instrumentsResult = await query(
    `SELECT LOWER(TRIM(instrument)) AS key, MIN(TRIM(instrument)) AS label, COUNT(*)::int AS count
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
       AND instrument IS NOT NULL AND TRIM(instrument) != ''
     GROUP BY 1
     ORDER BY count DESC`,
    [contributorId]
  );

  const dataQualityResult = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'approved' AND second_verifier IS NOT NULL)::int AS dual_verified_count,
            COUNT(*) FILTER (WHERE follow_up = true)::int                                    AS follow_up_count
     FROM activities
     WHERE contributor_id = $1`,
    [contributorId]
  );

  const followUpListResult = await query(
    `SELECT location, submitted_at
     FROM activities
     WHERE contributor_id = $1 AND follow_up = true
     ORDER BY submitted_at DESC
     LIMIT 10`,
    [contributorId]
  );

  const siteVisitsResult = await query(
    `SELECT split_part(location, ',', 1) AS location, quantity, submitted_at, cleaned_before
     FROM activities
     WHERE contributor_id = $1 AND status = 'approved'
     ORDER BY submitted_at ASC`,
    [contributorId]
  );

  const brandFrequency = await getBrandFrequency(contributorId);

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

  const siteConditions = siteConditionsResult.rows.map(r => ({
    shorelineType: r.shoreline_type,
    tideState: r.tide_state,
    count: Number(r.count) || 0,
  }));

  const hazardTypes = ['medical', 'chemical', 'unstable'];
  const hazardCounts = hazardTypes.reduce((acc, type) => {
    const flagged = hazardRowsResult.rows.filter(r => r[`hazards_${type}`]);
    acc[type] = {
      count: flagged.length,
      lastLocation: flagged[0]?.location || null,
      lastSubmittedAt: flagged[0]?.submitted_at || null,
    };
    return acc;
  }, {});

  const debrisRow = debrisResult.rows[0] || {};
  const debrisTotals = DEBRIS_ITEMS.map(({ key, label, column }) => ({
    key,
    item: label,
    total: Number(debrisRow[column]) || 0,
  }));
  const debrisSum = debrisTotals.reduce((s, d) => s + d.total, 0) || 1;
  const debrisBreakdown = debrisTotals
    .map(d => ({ ...d, pct: Math.round((d.total / debrisSum) * 100) }))
    .sort((a, b) => b.total - a.total);

  const microplastics = microplasticsResult.rows.map(r => ({ key: r.key, count: Number(r.count) || 0 }));

  const bulkItemsLog = bulkItemsResult.rows.map(r => ({
    items: r.bulk_items,
    location: r.location,
    submittedAt: r.submitted_at,
  }));

  const habitatStress = habitatStressResult.rows.map(r => ({ key: r.key, label: r.label, count: Number(r.count) || 0 }));
  const speciesSighted = speciesObservationsResult.rows.map(r => ({ key: r.key, label: r.label, count: Number(r.count) || 0 }));

  const totalHours = Number(fieldTimeResult.rows[0]?.total_hours) || 0;
  const fieldKg = Number(fieldTimeResult.rows[0]?.total_kg) || 0;
  const instruments = instrumentsResult.rows.map(r => ({ key: r.key, label: r.label, count: Number(r.count) || 0 }));

  const dataQualityRow = dataQualityResult.rows[0] || {};
  const followUpList = followUpListResult.rows.map(r => ({ location: r.location, submittedAt: r.submitted_at }));

  const siteVisitGroups = new Map();
  siteVisitsResult.rows.forEach((r) => {
    const location = r.location?.trim() || 'Unspecified';
    if (!siteVisitGroups.has(location)) siteVisitGroups.set(location, []);
    siteVisitGroups.get(location).push({
      quantity: Number(r.quantity) || 0,
      submittedAt: r.submitted_at,
      cleanedBefore: Boolean(r.cleaned_before),
    });
  });
  const monitoredSites = [...siteVisitGroups.entries()]
    .filter(([, visits]) => visits.length >= 2)
    .map(([location, visits]) => {
      const mid = Math.floor(visits.length / 2);
      const earlierTotal = visits.slice(0, mid).reduce((s, v) => s + v.quantity, 0);
      const recentTotal = visits.slice(mid).reduce((s, v) => s + v.quantity, 0);
      return {
        location,
        visitCount: visits.length,
        firstVisitAt: visits[0].submittedAt,
        lastVisitAt: visits[visits.length - 1].submittedAt,
        cleanedBeforeCount: visits.filter(v => v.cleanedBefore).length,
        trend: computeTrend(earlierTotal, recentTotal),
      };
    })
    .sort((a, b) => b.visitCount - a.visitCount || new Date(b.lastVisitAt) - new Date(a.lastVisitAt));

  return {
    topLocations,
    disposalStats,
    wildlife: {
      total: totalSightings,
      pctOfCleanups: totalActivities ? Math.round((totalSightings / totalActivities) * 100) : 0,
      breakdown: wildlifeBreakdown,
    },
    siteConditions,
    hazardCounts,
    debrisBreakdown,
    pollutionSeverity: {
      microplastics,
      bulkItemsLog,
    },
    habitatObservations: {
      habitatStress,
      speciesSighted,
    },
    fieldEfficiency: {
      totalHours,
      avgKgPerHour: totalHours > 0 ? Number((fieldKg / totalHours).toFixed(1)) : 0,
      instruments,
    },
    dataQuality: {
      dualVerifiedCount: Number(dataQualityRow.dual_verified_count) || 0,
      followUpCount: Number(dataQualityRow.follow_up_count) || 0,
      followUpList,
    },
    monitoredSites,
    brandFrequency,
  };
}

/**
 * getBrandFrequency — backs the "top brands" section of the debris density
 * card on the contributor overview page. Walks brands_identified (keyed by
 * debris material, each value an array of {name, count} entries) with
 * jsonb_each + jsonb_array_elements to flatten it into one row per
 * material/brand pair, then rolls that up in JS into an overall ranking
 * (brand name trimmed/lowercased for grouping, summed across materials) and
 * a per-material breakdown, in case the dashboard wants to show which
 * brands show up in a specific debris category (e.g. fishing line/nets).
 * Scoped to this contributor's approved activities only.
 */
export async function getBrandFrequency(contributorId) {
  const result = await query(
    `SELECT
       material.key AS material,
       TRIM(LOWER(brand->>'name')) AS brand_key,
       MIN(NULLIF(TRIM(brand->>'name'), '')) AS brand_label,
       COALESCE(SUM(
         CASE WHEN (brand->>'count') ~ '^\\d+(\\.\\d+)?$' THEN (brand->>'count')::numeric ELSE 0 END
       ), 0) AS total_count
     FROM activities a
     CROSS JOIN LATERAL jsonb_each(COALESCE(a.brands_identified, '{}'::jsonb)) AS material(key, value)
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(material.value) = 'array' THEN material.value ELSE '[]'::jsonb END
     ) AS brand
     WHERE a.contributor_id = $1
       AND a.status = 'approved'
       AND jsonb_typeof(a.brands_identified) = 'object'
       AND brand ? 'name'
       AND NULLIF(TRIM(brand->>'name'), '') IS NOT NULL
     GROUP BY material.key, TRIM(LOWER(brand->>'name'))
     ORDER BY material.key, total_count DESC`,
    [contributorId]
  );

  const rows = result.rows.map((r) => ({
    material: r.material,
    key: r.brand_key,
    label: r.brand_label,
    count: Number(r.total_count) || 0,
  }));

  const overallMap = new Map();
  rows.forEach(({ key, label, count }) => {
    const existing = overallMap.get(key);
    if (existing) {
      existing.count += count;
    } else {
      overallMap.set(key, { key, label, count });
    }
  });
  const topBrands = [...overallMap.values()].sort((a, b) => b.count - a.count);

  const byCategoryMap = new Map();
  rows.forEach(({ material, key, label, count }) => {
    if (!byCategoryMap.has(material)) byCategoryMap.set(material, []);
    byCategoryMap.get(material).push({ key, label, count });
  });
  const byCategory = [...byCategoryMap.entries()].map(([material, brands]) => ({
    material,
    brands: brands.sort((a, b) => b.count - a.count),
  }));

  return { topBrands, byCategory };
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
