import { query } from '../config/connection.js';
import { toNumber } from '../utils/normalize.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_EVENT_STATES = new Set([
  'observed', 'corroborated', 'needs_attention', 'action_planned',
  'action_underway', 'addressed', 'reassessed', 'recurring',
  'disputed', 'unable_to_verify'
]);
const LIST_VERIFICATION_STATES = new Set(['unverified', 'supported', 'corroborated', 'verified']);
const LIST_SUBJECT_FAMILIES = new Set(['pollution_waste', 'water', 'life', 'habitat', 'conditions', 'human_action']);

// category (free text on activities) → subject code (see db/schema.sql's
// pollution_waste seed rows). Anything unmapped falls back to
// 'mixed_waste' rather than blocking event creation.
export const CATEGORY_TO_SUBJECT_CODE = {
  plastic: 'plastic',
  glass: 'glass',
  metal: 'metal',
  organic: 'mixed_waste',
  mixed: 'mixed_waste',
  other: 'mixed_waste'
};

export const EVENT_STATE_BY_STATUS = {
  pending: 'observed',
  approved: 'addressed',
  rejected: 'disputed'
};

// verification_state has no rejection-specific value (see db/schema.sql) —
// a rejected activity is still simply unverified, not a distinct enum
// member. The 'unable_to_verify' outcome lives on the verifications table
// instead (a TEXT-checked column, not this enum) and is recorded there by
// recordReviewOnEvent below.
export const VERIFICATION_STATE_BY_STATUS = {
  pending: 'unverified',
  approved: 'verified',
  rejected: 'unverified'
};

function imageArrays(activity) {
  const cids = activity.imageCid || [];
  const storageUrls = activity.imageIpfsUrl || [];
  const gatewayUrls = activity.imageGatewayUrl || [];
  const count = Math.max(cids.length, storageUrls.length, gatewayUrls.length);
  return Array.from({ length: count }, (_, i) => ({
    cid: cids[i] || null,
    storageUrl: storageUrls[i] || null,
    gatewayUrl: gatewayUrls[i] || null
  }));
}

/**
 * createEventForActivity — mirrors scripts/backfillEnvironmentalEvents.js
 * for a freshly-submitted activity: a contribution, an environmental_event,
 * its subject, and one evidence row per attached image, linked back via
 * activities.environmental_event_id. Runs on the same request as
 * activity creation so the two never drift, but callers must treat this
 * as best-effort — catch, log, and continue on failure, never let it
 * block or fail activity submission.
 */
export async function createEventForActivity(activity, options = {}) {
  const { aiSubjects, rawText, captureSource, intakeMethod, evidenceType } = options;

  // AI-inferred subjects (spec §16-17: multi-subject, provenance-tagged)
  // take priority when present. Falls back to the single category-derived
  // subject for submissions that didn't go through AI classification, so
  // this stays backward compatible with the original wizard-based intake.
  let subjectsToInsert;
  if (Array.isArray(aiSubjects) && aiSubjects.length > 0) {
    const { rows } = await query(
      `SELECT subject_id, family, code FROM subjects
       WHERE (family, code) IN (${aiSubjects.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')})`,
      aiSubjects.flatMap((s) => [s.family, s.code])
    );
    subjectsToInsert = rows.map((row) => {
      const match = aiSubjects.find((s) => s.family === row.family && s.code === row.code);
      // Callers that build subjects directly (e.g. the measurement intake,
      // which knows its own provenance — instrument reading vs. informal
      // observation) can override source/attributes per subject; AI intake
      // leaves both unset and gets the historical defaults.
      return {
        subjectId: row.subject_id,
        confidence: match?.confidence ?? null,
        source: match?.source || 'ai_inferred',
        attributes: match?.attributes || { quantity_kg: Number(activity.quantity) || 0 }
      };
    });
  } else {
    const subjectCode = CATEGORY_TO_SUBJECT_CODE[activity.category] || 'mixed_waste';
    const { rows } = await query(
      `SELECT subject_id FROM subjects WHERE family = 'pollution_waste' AND code = $1`,
      [subjectCode]
    );
    subjectsToInsert = rows.map((row) => ({
      subjectId: row.subject_id, confidence: null, source: 'user_provided',
      attributes: { quantity_kg: Number(activity.quantity) || 0 }
    }));
  }
  if (subjectsToInsert.length === 0) return null;

  // activities.contributor_id has never been FK-constrained; contributions
  // is (correctly, going forward), so guard against a stale reference the
  // same way the backfill script does rather than let the insert fail.
  let contributorId = activity.contributorId || null;
  if (contributorId) {
    const { rows: userRows } = await query(`SELECT id FROM users WHERE id = $1`, [contributorId]);
    if (userRows.length === 0) contributorId = null;
  }

  const contribution = await query(
    `INSERT INTO contributions (contributor_id, organization_id, intake_method, raw_text, submitted_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING contribution_id`,
    [contributorId, activity.organizationId || null, intakeMethod || 'upload', rawText || null, activity.timestamp]
  );
  const contributionId = contribution.rows[0].contribution_id;

  const event = await query(
    `INSERT INTO environmental_events
       (contribution_id, legacy_activity_id, event_state, verification_state,
        occurred_at, lat, lon, location_label, location_source)
     VALUES ($1, $2, 'observed', 'unverified', $3, $4, $5, $6, 'user_provided')
     RETURNING event_id`,
    [contributionId, activity.id, activity.timestamp, activity.lat, activity.lon, activity.location]
  );
  const eventId = event.rows[0].event_id;

  for (const subject of subjectsToInsert) {
    await query(
      `INSERT INTO event_subjects (event_id, subject_id, attributes, source, confidence)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, subject.subjectId, JSON.stringify(subject.attributes), subject.source, subject.confidence]
    );
  }

  for (const image of imageArrays(activity)) {
    await query(
      `INSERT INTO evidence (event_id, contribution_id, evidence_type, storage_url, gateway_url, cid, capture_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventId, contributionId, evidenceType || 'photo', image.storageUrl, image.gatewayUrl, image.cid, captureSource || 'unknown']
    );
  }

  if (rawText) {
    await query(
      `INSERT INTO evidence (event_id, contribution_id, evidence_type, capture_source, metadata)
       VALUES ($1, $2, 'contributor_statement', 'unknown', $3)`,
      [eventId, contributionId, JSON.stringify({ text: rawText })]
    );
  }

  await query(`UPDATE activities SET environmental_event_id = $1 WHERE id = $2`, [eventId, activity.id]);
  return eventId;
}

/**
 * recordReviewOnEvent — after a review flips activities.status, mirrors
 * that onto the linked environmental_event: appends both state fields to
 * event_state_history, updates the event's current state columns, and
 * logs a verifications row on approve/reject. A no-op if the activity was
 * never linked to an event (e.g. createEventForActivity failed at submit
 * time) — review of the legacy activity must still succeed either way.
 */
export async function recordReviewOnEvent(activity, reviewerId) {
  const { rows } = await query(
    `SELECT event_id, event_state, verification_state
     FROM environmental_events
     WHERE legacy_activity_id = $1`,
    [activity.id]
  );
  const current = rows[0];
  if (!current) return;

  const nextEventState = EVENT_STATE_BY_STATUS[activity.status] || current.event_state;
  const nextVerificationState = VERIFICATION_STATE_BY_STATUS[activity.status] || current.verification_state;

  await query(
    `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
     VALUES ($1, 'event_state', $2, $3, $4, $5),
            ($1, 'verification_state', $6, $7, $4, $5)`,
    [
      current.event_id,
      current.event_state, nextEventState,
      reviewerId, activity.reviewNote || null,
      current.verification_state, nextVerificationState
    ]
  );

  await query(
    `UPDATE environmental_events
     SET event_state = $2, verification_state = $3, updated_at = NOW()
     WHERE event_id = $1`,
    [current.event_id, nextEventState, nextVerificationState]
  );

  if (activity.status === 'approved' || activity.status === 'rejected') {
    await query(
      `INSERT INTO verifications (event_id, verifier_id, outcome, notes)
       VALUES ($1, $2, $3, $4)`,
      [
        current.event_id,
        reviewerId,
        activity.status === 'approved' ? 'verified' : 'unable_to_verify',
        activity.reviewNote || null
      ]
    );
  }
}

const CORROBORATION_RADIUS_METERS = 300;
const CORROBORATION_WINDOW_DAYS = 7;
const VERIFICATION_STATE_RANK = { unverified: 0, supported: 1, corroborated: 2, verified: 3 };

/**
 * detectAndLinkCorroboration — looks for prior events within ~300m and 7
 * days that share a subject family with this one, links them via a
 * 'corroborates' relationship, and nudges both events' state forward
 * (spec §9-10, §20: "three citizens report the same net" should become
 * one corroborated event, not three unrelated rows).
 *
 * Deliberately conservative: never downgrades a state, never touches an
 * event that's already 'verified' — that stays a human verifier's call,
 * not this heuristic's — and corroboration alone can only reach
 * 'corroborated', never 'verified'.
 */
export async function detectAndLinkCorroboration(eventId) {
  const { rows: selfRows } = await query(
    `SELECT event_id, lat, lon, occurred_at, event_state, verification_state
     FROM environmental_events WHERE event_id = $1`,
    [eventId]
  );
  const self = selfRows[0];
  if (!self || self.lat == null || self.lon == null || !self.occurred_at) {
    return { matchCount: 0, matchedEventIds: [] };
  }

  const { rows: matches } = await query(
    `SELECT DISTINCT e.event_id, e.event_state, e.verification_state
     FROM environmental_events e
     JOIN event_subjects es ON es.event_id = e.event_id
     JOIN subjects s ON s.subject_id = es.subject_id
     WHERE e.event_id <> $1
       AND e.lat IS NOT NULL AND e.lon IS NOT NULL
       AND e.occurred_at IS NOT NULL
       AND ABS(EXTRACT(EPOCH FROM (e.occurred_at - $2::timestamptz))) <= $3
       AND (
         6371000 * acos(LEAST(1, GREATEST(-1,
           cos(radians($4::double precision)) * cos(radians(e.lat::double precision))
             * cos(radians(e.lon::double precision) - radians($5::double precision))
           + sin(radians($4::double precision)) * sin(radians(e.lat::double precision))
         )))
       ) <= $6
       AND s.code IN (
         -- Matching on the specific subject code, not just its family —
         -- family alone (e.g. pollution_waste) is too coarse and was
         -- linking unrelated reports as if they corroborated each other
         -- (an oil slick and a plastic pile both being "pollution_waste"
         -- doesn't mean they're the same incident).
         SELECT s2.code FROM event_subjects es2
         JOIN subjects s2 ON s2.subject_id = es2.subject_id
         WHERE es2.event_id = $1
       )`,
    [
      eventId, self.occurred_at, CORROBORATION_WINDOW_DAYS * 86400,
      self.lat, self.lon, CORROBORATION_RADIUS_METERS
    ]
  );

  if (matches.length === 0) return { matchCount: 0, matchedEventIds: [] };

  for (const match of matches) {
    await query(
      `INSERT INTO event_relationships (from_event_id, to_event_id, relationship_type, created_by)
       VALUES ($1, $2, 'corroborates', 'system:corroboration-detector')
       ON CONFLICT (from_event_id, to_event_id, relationship_type) DO NOTHING`,
      [eventId, match.event_id]
    );
  }

  await bumpTowardCorroborated(self, matches.length);
  for (const match of matches) {
    await bumpTowardCorroborated(match, 1);
  }

  return { matchCount: matches.length, matchedEventIds: matches.map((m) => m.event_id) };
}

async function bumpTowardCorroborated(current, corroboratingCount) {
  if (current.verification_state === 'verified') return;

  const candidateVerificationState = corroboratingCount >= 2 ? 'corroborated' : 'supported';
  const nextVerificationState =
    VERIFICATION_STATE_RANK[candidateVerificationState] > VERIFICATION_STATE_RANK[current.verification_state]
      ? candidateVerificationState
      : current.verification_state;
  const nextEventState = current.event_state === 'observed' ? 'corroborated' : current.event_state;

  if (nextEventState === current.event_state && nextVerificationState === current.verification_state) {
    return;
  }

  const note = `Corroborated by ${corroboratingCount} nearby event(s) within ${CORROBORATION_RADIUS_METERS}m / ${CORROBORATION_WINDOW_DAYS}d`;
  const historyRows = [];
  if (nextEventState !== current.event_state) {
    historyRows.push(['event_state', current.event_state, nextEventState]);
  }
  if (nextVerificationState !== current.verification_state) {
    historyRows.push(['verification_state', current.verification_state, nextVerificationState]);
  }

  for (const [field, oldValue, newValue] of historyRows) {
    await query(
      `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
       VALUES ($1, $2, $3, $4, 'system:corroboration-detector', $5)`,
      [current.event_id, field, oldValue, newValue, note]
    );
  }

  await query(
    `UPDATE environmental_events SET event_state = $2, verification_state = $3, updated_at = NOW() WHERE event_id = $1`,
    [current.event_id, nextEventState, nextVerificationState]
  );
}

function mapEventSummaryRow(row) {
  return {
    eventId: row.event_id,
    legacyActivityId: row.legacy_activity_id,
    title: row.title,
    description: row.description,
    eventState: row.event_state,
    verificationState: row.verification_state,
    occurredAt: row.occurred_at,
    lat: row.lat,
    lon: row.lon,
    locationLabel: row.location_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subjects: row.subjects || []
  };
}

/**
 * listEvents — a page of events with their subjects rolled up, newest
 * first. Filters are optional and silently ignored if the value isn't a
 * real enum/family member, rather than erroring on a typo'd query param.
 */
export async function listEvents({ eventState, verificationState, subjectFamily, contributorId, limit, offset } = {}) {
  const conditions = [];
  const params = [];

  if (contributorId) {
    params.push(contributorId);
    conditions.push(`EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.contribution_id = e.contribution_id AND c.contributor_id = $${params.length}
    )`);
  }
  if (LIST_EVENT_STATES.has(eventState)) {
    params.push(eventState);
    conditions.push(`e.event_state = $${params.length}`);
  }
  if (LIST_VERIFICATION_STATES.has(verificationState)) {
    params.push(verificationState);
    conditions.push(`e.verification_state = $${params.length}`);
  }
  if (LIST_SUBJECT_FAMILIES.has(subjectFamily)) {
    params.push(subjectFamily);
    conditions.push(`EXISTS (
      SELECT 1 FROM event_subjects es2
      JOIN subjects s2 ON s2.subject_id = es2.subject_id
      WHERE es2.event_id = e.event_id AND s2.family = $${params.length}
    )`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(toNumber(limit) || 50, 1), 200);
  const safeOffset = Math.max(toNumber(offset) || 0, 0);
  params.push(safeLimit, safeOffset);

  const result = await query(
    `SELECT e.event_id, e.legacy_activity_id, e.title, e.description, e.event_state, e.verification_state,
            e.occurred_at, e.lat, e.lon, e.location_label, e.created_at, e.updated_at,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object(
                'subjectId', s.subject_id, 'family', s.family, 'code', s.code, 'label', s.label
              )) FILTER (WHERE s.subject_id IS NOT NULL),
              '[]'
            ) AS subjects
     FROM environmental_events e
     LEFT JOIN event_subjects es ON es.event_id = e.event_id
     LEFT JOIN subjects s ON s.subject_id = es.subject_id
     ${whereClause}
     GROUP BY e.event_id
     ORDER BY e.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return result.rows.map(mapEventSummaryRow);
}

/**
 * getEventDetail — the full picture for one event: subjects, evidence,
 * relationships in both directions, the state-transition history, and any
 * verification passes and recorded impact. One query per related table
 * (matches the composition style already used by getContributorInsights
 * above) rather than a single wide join, so each result set stays easy to
 * reason about independently.
 */
export async function getEventDetail(eventId) {
  if (!UUID_PATTERN.test(eventId || '')) return null;

  const { rows: eventRows } = await query(
    `SELECT event_id, legacy_activity_id, title, description, event_state, verification_state,
            occurred_at, lat, lon, location_label, location_source, created_at, updated_at
     FROM environmental_events
     WHERE event_id = $1`,
    [eventId]
  );
  const eventRow = eventRows[0];
  if (!eventRow) return null;

  const [subjects, evidence, relationshipsFrom, relationshipsTo, stateHistory, verifications, impact] =
    await Promise.all([
      query(
        `SELECT es.event_subject_id, es.subject_id, s.family, s.code, s.label,
                es.attributes, es.source, es.confidence, es.created_at
         FROM event_subjects es
         JOIN subjects s ON s.subject_id = es.subject_id
         WHERE es.event_id = $1
         ORDER BY es.created_at ASC`,
        [eventId]
      ),
      query(
        `SELECT evidence_id, evidence_type, storage_url, gateway_url, cid, capture_source,
                captured_at, exif_lat, exif_lon, file_hash, metadata, created_at
         FROM evidence
         WHERE event_id = $1
         ORDER BY created_at ASC`,
        [eventId]
      ),
      query(
        `SELECT r.relationship_id, r.relationship_type, r.to_event_id, r.created_by, r.created_at,
                e.title AS to_title, e.event_state AS to_event_state
         FROM event_relationships r
         JOIN environmental_events e ON e.event_id = r.to_event_id
         WHERE r.from_event_id = $1
         ORDER BY r.created_at ASC`,
        [eventId]
      ),
      query(
        `SELECT r.relationship_id, r.relationship_type, r.from_event_id, r.created_by, r.created_at,
                e.title AS from_title, e.event_state AS from_event_state
         FROM event_relationships r
         JOIN environmental_events e ON e.event_id = r.from_event_id
         WHERE r.to_event_id = $1
         ORDER BY r.created_at ASC`,
        [eventId]
      ),
      query(
        `SELECT history_id, field, old_value, new_value, changed_by, note, changed_at
         FROM event_state_history
         WHERE event_id = $1
         ORDER BY changed_at ASC`,
        [eventId]
      ),
      query(
        `SELECT verification_id, verifier_id, outcome, notes, onchain_tx_hash, onchain_hash, created_at
         FROM verifications
         WHERE event_id = $1
         ORDER BY created_at ASC`,
        [eventId]
      ),
      query(
        `SELECT impact_id, metric, value, unit, recorded_at
         FROM event_impact
         WHERE event_id = $1
         ORDER BY recorded_at ASC`,
        [eventId]
      )
    ]);

  return {
    ...mapEventSummaryRow({ ...eventRow, subjects: undefined }),
    locationSource: eventRow.location_source,
    subjects: subjects.rows.map((r) => ({
      eventSubjectId: r.event_subject_id,
      subjectId: r.subject_id,
      family: r.family,
      code: r.code,
      label: r.label,
      attributes: r.attributes || {},
      source: r.source,
      confidence: r.confidence,
      createdAt: r.created_at
    })),
    evidence: evidence.rows.map((r) => ({
      evidenceId: r.evidence_id,
      evidenceType: r.evidence_type,
      storageUrl: r.storage_url,
      gatewayUrl: r.gateway_url,
      cid: r.cid,
      captureSource: r.capture_source,
      capturedAt: r.captured_at,
      exifLat: r.exif_lat,
      exifLon: r.exif_lon,
      fileHash: r.file_hash,
      metadata: r.metadata || {},
      createdAt: r.created_at
    })),
    relationships: [
      ...relationshipsFrom.rows.map((r) => ({
        relationshipId: r.relationship_id,
        direction: 'outgoing',
        relationshipType: r.relationship_type,
        otherEventId: r.to_event_id,
        otherEventTitle: r.to_title,
        otherEventState: r.to_event_state,
        createdBy: r.created_by,
        createdAt: r.created_at
      })),
      ...relationshipsTo.rows.map((r) => ({
        relationshipId: r.relationship_id,
        direction: 'incoming',
        relationshipType: r.relationship_type,
        otherEventId: r.from_event_id,
        otherEventTitle: r.from_title,
        otherEventState: r.from_event_state,
        createdBy: r.created_by,
        createdAt: r.created_at
      }))
    ],
    stateHistory: stateHistory.rows.map((r) => ({
      historyId: r.history_id,
      field: r.field,
      oldValue: r.old_value,
      newValue: r.new_value,
      changedBy: r.changed_by,
      note: r.note,
      changedAt: r.changed_at
    })),
    verifications: verifications.rows.map((r) => ({
      verificationId: r.verification_id,
      verifierId: r.verifier_id,
      outcome: r.outcome,
      notes: r.notes,
      onchainTxHash: r.onchain_tx_hash,
      onchainHash: r.onchain_hash,
      createdAt: r.created_at
    })),
    impact: impact.rows.map((r) => ({
      impactId: r.impact_id,
      metric: r.metric,
      value: Number(r.value),
      unit: r.unit,
      recordedAt: r.recorded_at
    }))
  };
}

// Trailing 30-day windows rather than calendar months — "vs last month"
// read as a rolling comparison avoids the partial-month skew a
// month-to-date vs. same-days-last-month comparison would have on the
// 1st-2nd of a month, and needs no day-of-month clamping logic.
function pctChange(curRaw, prevRaw) {
  const cur = Number(curRaw) || 0;
  const prev = Number(prevRaw) || 0;
  // A zero-row prior period makes the percentage undefined (division by
  // zero) rather than "infinite growth" — the UI omits the trend pill
  // instead of showing a fabricated number.
  if (prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/**
 * getContributorImpactSummary — the five numbers the spec's "Your Impact"
 * example calls out directly (spec §22): contributions made, how many
 * were verified, how many resulted in a completed action, total kg
 * removed, and how many distinct locations were touched. Deliberately a
 * different shape from getContributorStats (activityService.js), which
 * reports on the legacy activities table — this reports on the event
 * model, so a contribution and its resulting event are counted once
 * each, not conflated with a raw activity row count.
 *
 * Also returns `trends` — each metric's percent change between the
 * trailing 30-day window and the 30 days before that — for the "vs last
 * month" pills on the contributor dashboard's impact cards. verified/
 * actions-completed trends key off event_state_history (the record of
 * *when* an event crossed into that state), not the events table's
 * current state, since the latter has no reliable per-transition
 * timestamp of its own.
 */
export async function getContributorImpactSummary(contributorId) {
  const { rows } = await query(
    `WITH bounds AS (
       SELECT NOW() - INTERVAL '30 days' AS cur_start, NOW() - INTERVAL '60 days' AS prev_start
     ),
     contribution_counts AS (
       SELECT
         COUNT(*) FILTER (WHERE submitted_at >= (SELECT cur_start FROM bounds)) AS cur,
         COUNT(*) FILTER (WHERE submitted_at >= (SELECT prev_start FROM bounds) AND submitted_at < (SELECT cur_start FROM bounds)) AS prev
       FROM contributions
       WHERE contributor_id = $1
     ),
     verified_counts AS (
       SELECT
         COUNT(DISTINCT h.event_id) FILTER (WHERE h.changed_at >= (SELECT cur_start FROM bounds)) AS cur,
         COUNT(DISTINCT h.event_id) FILTER (WHERE h.changed_at >= (SELECT prev_start FROM bounds) AND h.changed_at < (SELECT cur_start FROM bounds)) AS prev
       FROM event_state_history h
       JOIN environmental_events e ON e.event_id = h.event_id
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.contributor_id = $1 AND h.field = 'verification_state' AND h.new_value = 'verified'
     ),
     action_counts AS (
       SELECT
         COUNT(DISTINCT h.event_id) FILTER (WHERE h.changed_at >= (SELECT cur_start FROM bounds)) AS cur,
         COUNT(DISTINCT h.event_id) FILTER (WHERE h.changed_at >= (SELECT prev_start FROM bounds) AND h.changed_at < (SELECT cur_start FROM bounds)) AS prev
       FROM event_state_history h
       JOIN environmental_events e ON e.event_id = h.event_id
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.contributor_id = $1 AND h.field = 'event_state' AND h.new_value = 'addressed'
     ),
     kg_from_impact AS (
       SELECT
         COALESCE(SUM(ei.value) FILTER (WHERE ei.recorded_at >= (SELECT cur_start FROM bounds)), 0) AS cur,
         COALESCE(SUM(ei.value) FILTER (WHERE ei.recorded_at >= (SELECT prev_start FROM bounds) AND ei.recorded_at < (SELECT cur_start FROM bounds)), 0) AS prev
       FROM event_impact ei
       JOIN environmental_events e ON e.event_id = ei.event_id
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.contributor_id = $1 AND ei.metric = 'debris_removed_kg'
     ),
     kg_from_subjects AS (
       -- Same one-per-event dedupe as the totals query below, just
       -- windowed on when that subject row was created.
       SELECT
         COALESCE(SUM(per_event.qty) FILTER (WHERE per_event.created_at >= (SELECT cur_start FROM bounds)), 0) AS cur,
         COALESCE(SUM(per_event.qty) FILTER (WHERE per_event.created_at >= (SELECT prev_start FROM bounds) AND per_event.created_at < (SELECT cur_start FROM bounds)), 0) AS prev
       FROM (
         SELECT DISTINCT ON (es.event_id) (es.attributes->>'quantity_kg')::numeric AS qty, es.created_at
         FROM event_subjects es
         JOIN environmental_events e ON e.event_id = es.event_id
         JOIN contributions c ON c.contribution_id = e.contribution_id
         WHERE c.contributor_id = $1 AND es.attributes ? 'quantity_kg'
         ORDER BY es.event_id, es.created_at ASC
       ) per_event
     ),
     location_counts AS (
       SELECT
         COUNT(DISTINCT COALESCE(NULLIF(TRIM(e.location_label), ''), e.event_id::text)) FILTER (WHERE e.created_at >= (SELECT cur_start FROM bounds)) AS cur,
         COUNT(DISTINCT COALESCE(NULLIF(TRIM(e.location_label), ''), e.event_id::text)) FILTER (WHERE e.created_at >= (SELECT prev_start FROM bounds) AND e.created_at < (SELECT cur_start FROM bounds)) AS prev
       FROM environmental_events e
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.contributor_id = $1
     )
     SELECT
       (SELECT COUNT(*) FROM contributions WHERE contributor_id = $1) AS contributions,
       (SELECT COUNT(*) FROM environmental_events e
          JOIN contributions c ON c.contribution_id = e.contribution_id
          WHERE c.contributor_id = $1 AND e.verification_state = 'verified') AS verified_events,
       (SELECT COUNT(*) FROM environmental_events e
          JOIN contributions c ON c.contribution_id = e.contribution_id
          WHERE c.contributor_id = $1 AND e.event_state = 'addressed') AS actions_completed,
       (
         -- Two sources of "kg removed": event_impact (populated when an
         -- action is formally completed via completeAction) and
         -- event_subjects.attributes.quantity_kg (populated at intake
         -- time for pollution_waste subjects — the AI/photo/measurement
         -- path, which never goes through event_impact at all). Sum both
         -- rather than just one, or most real submissions undercount.
         (SELECT COALESCE(SUM(ei.value), 0) FROM event_impact ei
            JOIN environmental_events e ON e.event_id = ei.event_id
            JOIN contributions c ON c.contribution_id = e.contribution_id
            WHERE c.contributor_id = $1 AND ei.metric = 'debris_removed_kg')
         +
         (SELECT COALESCE(SUM(per_event.qty), 0) FROM (
            -- One quantity_kg per event, not per subject row — the same
            -- value gets stamped onto every subject of a multi-subject
            -- event at intake time, so summing across event_subjects
            -- directly would multiply it by the subject count.
            SELECT DISTINCT ON (es.event_id) (es.attributes->>'quantity_kg')::numeric AS qty
            FROM event_subjects es
            JOIN environmental_events e ON e.event_id = es.event_id
            JOIN contributions c ON c.contribution_id = e.contribution_id
            WHERE c.contributor_id = $1 AND es.attributes ? 'quantity_kg'
            ORDER BY es.event_id, es.created_at ASC
          ) per_event)
       ) AS kg_removed,
       (SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(e.location_label), ''), e.event_id::text))
          FROM environmental_events e
          JOIN contributions c ON c.contribution_id = e.contribution_id
          WHERE c.contributor_id = $1) AS locations_affected,
       cc.cur AS contributions_cur, cc.prev AS contributions_prev,
       vc.cur AS verified_cur, vc.prev AS verified_prev,
       ac.cur AS actions_cur, ac.prev AS actions_prev,
       (ki.cur + ks.cur) AS kg_cur, (ki.prev + ks.prev) AS kg_prev,
       lc.cur AS locations_cur, lc.prev AS locations_prev
     FROM contribution_counts cc, verified_counts vc, action_counts ac,
          kg_from_impact ki, kg_from_subjects ks, location_counts lc`,
    [contributorId]
  );

  const row = rows[0] || {};
  return {
    contributions: Number(row.contributions) || 0,
    verifiedEvents: Number(row.verified_events) || 0,
    actionsCompleted: Number(row.actions_completed) || 0,
    kgRemoved: Number(row.kg_removed) || 0,
    locationsAffected: Number(row.locations_affected) || 0,
    trends: {
      contributions: pctChange(row.contributions_cur, row.contributions_prev),
      verifiedEvents: pctChange(row.verified_cur, row.verified_prev),
      actionsCompleted: pctChange(row.actions_cur, row.actions_prev),
      kgRemoved: pctChange(row.kg_cur, row.kg_prev),
      locationsAffected: pctChange(row.locations_cur, row.locations_prev)
    }
  };
}

/**
 * listSubjects — the taxonomy, optionally filtered to one family. Backs
 * the "Plan Action" subject picker (human_action codes) rather than
 * hardcoding the list client-side, so it never drifts from what's
 * actually seeded in the subjects table.
 */
export async function listSubjects(family) {
  const params = [];
  let whereClause = '';
  if (LIST_SUBJECT_FAMILIES.has(family)) {
    params.push(family);
    whereClause = 'WHERE family = $1 AND is_active = true';
  } else {
    whereClause = 'WHERE is_active = true';
  }

  const { rows } = await query(
    `SELECT subject_id, family, code, label FROM subjects ${whereClause} ORDER BY family, code`,
    params
  );
  return rows.map((r) => ({ subjectId: r.subject_id, family: r.family, code: r.code, label: r.label }));
}

/**
 * planActionForEvent — spec §27's "Plan Action" step: a human (contributor
 * or org) responding to an observation event by starting a linked action
 * event, rather than the response living only as a comment or a status
 * flip on the original. Not tied to a contribution record — this is an
 * organizational act, not a raw evidence submission — provenance instead
 * comes from event_state_history.changed_by and the relationship's
 * created_by.
 */
export async function planActionForEvent(observationEventId, { actorId, subjectCode, title, description }) {
  const { rows: subjectRows } = await query(
    `SELECT subject_id FROM subjects WHERE family = 'human_action' AND code = $1`,
    [subjectCode]
  );
  if (subjectRows.length === 0) {
    throw new Error(`Unknown human_action subject code: ${subjectCode}`);
  }

  const { rows: obsRows } = await query(
    `SELECT event_state, lat, lon, location_label FROM environmental_events WHERE event_id = $1`,
    [observationEventId]
  );
  const observation = obsRows[0];
  if (!observation) {
    throw new Error('Observation event not found');
  }

  const { rows: actionRows } = await query(
    `INSERT INTO environmental_events
       (title, description, event_state, verification_state, occurred_at, lat, lon, location_label, location_source)
     VALUES ($1, $2, 'action_planned', 'unverified', NOW(), $3, $4, $5, 'system_captured')
     RETURNING event_id`,
    [title || null, description || null, observation.lat, observation.lon, observation.location_label]
  );
  const actionEventId = actionRows[0].event_id;

  await query(
    `INSERT INTO event_subjects (event_id, subject_id, source) VALUES ($1, $2, 'user_provided')`,
    [actionEventId, subjectRows[0].subject_id]
  );

  await query(
    `INSERT INTO event_relationships (from_event_id, to_event_id, relationship_type, created_by)
     VALUES ($1, $2, 'responds_to', $3)
     ON CONFLICT (from_event_id, to_event_id, relationship_type) DO NOTHING`,
    [actionEventId, observationEventId, actorId]
  );

  await query(
    `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
     VALUES ($1, 'event_state', NULL, 'action_planned', $2, $3)`,
    [actionEventId, actorId, description || null]
  );

  // Nudge the observation forward if it's still just sitting there —
  // never downgrade, and never override a state a human already pushed
  // further along (e.g. don't stomp 'disputed').
  if (['observed', 'corroborated', 'needs_attention'].includes(observation.event_state)) {
    await query(
      `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
       VALUES ($1, 'event_state', $2, 'action_planned', $3, 'Action planned in response')`,
      [observationEventId, observation.event_state, actorId]
    );
    await query(
      `UPDATE environmental_events SET event_state = 'action_planned', updated_at = NOW() WHERE event_id = $1`,
      [observationEventId]
    );
  }

  return actionEventId;
}

/**
 * completeAction — closes the loop from spec §27: the action event moves
 * to 'addressed', an impact record captures what changed (kg removed),
 * and every observation this action responds to gets a 'removed'
 * relationship plus its own state bumped to 'addressed' — the exact
 * "something you reported changed" moment the Impact Stories feed reads
 * from.
 */
export async function completeAction(actionEventId, { actorId, kgRemoved, note }) {
  const { rows } = await query(
    `SELECT event_state FROM environmental_events WHERE event_id = $1`,
    [actionEventId]
  );
  if (!rows[0]) {
    throw new Error('Action event not found');
  }
  const oldState = rows[0].event_state;

  await query(
    `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
     VALUES ($1, 'event_state', $2, 'addressed', $3, $4)`,
    [actionEventId, oldState, actorId, note || null]
  );
  await query(
    `UPDATE environmental_events SET event_state = 'addressed', updated_at = NOW() WHERE event_id = $1`,
    [actionEventId]
  );

  if (kgRemoved != null && Number(kgRemoved) > 0) {
    await query(
      `INSERT INTO event_impact (event_id, metric, value, unit) VALUES ($1, 'debris_removed_kg', $2, 'kg')`,
      [actionEventId, Number(kgRemoved)]
    );
  }

  const { rows: responded } = await query(
    `SELECT to_event_id FROM event_relationships WHERE from_event_id = $1 AND relationship_type = 'responds_to'`,
    [actionEventId]
  );

  for (const row of responded) {
    await query(
      `INSERT INTO event_relationships (from_event_id, to_event_id, relationship_type, created_by)
       VALUES ($1, $2, 'removed', $3)
       ON CONFLICT (from_event_id, to_event_id, relationship_type) DO NOTHING`,
      [actionEventId, row.to_event_id, actorId]
    );

    const { rows: obsRows } = await query(
      `SELECT event_state FROM environmental_events WHERE event_id = $1`,
      [row.to_event_id]
    );
    const obsOldState = obsRows[0]?.event_state;
    if (obsOldState && obsOldState !== 'addressed') {
      await query(
        `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
         VALUES ($1, 'event_state', $2, 'addressed', $3, 'Closed by linked action')`,
        [row.to_event_id, obsOldState, actorId]
      );
      await query(
        `UPDATE environmental_events SET event_state = 'addressed', updated_at = NOW() WHERE event_id = $1`,
        [row.to_event_id]
      );
    }
  }

  return responded.map((r) => r.to_event_id);
}

const EVENT_RELATIONSHIP_TYPES = new Set([
  'observed_at', 'affects', 'affected_by', 'caused_by', 'possibly_caused_by',
  'corroborates', 'duplicate_of', 'follow_up_to', 'responds_to',
  'removed', 'restored', 'rescued', 'verifies', 'disputes',
  'predicted_to_affect', 'supersedes'
]);

/**
 * linkEvents — a single, deliberately generic way to create any typed
 * relationship between two existing events (spec §9: "the architecture
 * simply needs to permit typed relationships" — not a bespoke workflow
 * per type). `corroborates`/`responds_to`/`removed` already get created
 * automatically elsewhere; this is for the rest of the vocabulary
 * (duplicate_of, disputes, follow_up_to, supersedes, verifies, ...),
 * which otherwise has no way to ever get used. Deliberately does not
 * touch event_state — different relationship types imply different
 * state changes and guessing wrong is worse than leaving state alone
 * for a human to adjust separately.
 */
export async function linkEvents(fromEventId, toEventId, relationshipType, actorId) {
  if (!EVENT_RELATIONSHIP_TYPES.has(relationshipType)) {
    throw new Error(`Unknown relationship type: ${relationshipType}`);
  }
  if (fromEventId === toEventId) {
    throw new Error('An event cannot relate to itself');
  }

  const { rows } = await query(
    `SELECT event_id FROM environmental_events WHERE event_id IN ($1, $2)`,
    [fromEventId, toEventId]
  );
  if (rows.length < 2) {
    throw new Error('One or both events could not be found');
  }

  const { rows: inserted } = await query(
    `INSERT INTO event_relationships (from_event_id, to_event_id, relationship_type, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_event_id, to_event_id, relationship_type) DO NOTHING
     RETURNING relationship_id`,
    [fromEventId, toEventId, relationshipType, actorId]
  );

  return inserted[0]?.relationship_id || null;
}
