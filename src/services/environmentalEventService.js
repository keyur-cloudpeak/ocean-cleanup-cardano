import { query } from '../config/connection.js';
import { toNumber } from '../utils/normalize.js';
import { notifyClosure } from './notificationService.js';
import { findUserById } from './userService.js';
import { sanitizeSubjectAttributes } from '../constants/subjectAttributes.js';
import { recordVerificationOnChain } from './onchainProofService.js';
import { fetchLocationContext } from './locationEnrichmentService.js';
import { logExternalEnrichment } from './externalEnrichmentService.js';
import { computeConfidenceSignals } from './confidenceSignalService.js';
import { awardCorroborationPoints, awardVerificationPoints } from './rewardLedgerService.js';

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
const LOCATION_CAPTURE_METHODS = new Set(['gps', 'manual_pin', 'unknown']);

export async function createEventForActivity(activity, options = {}) {
  const {
    aiSubjects, rawText, captureSource, intakeMethod, evidenceType, quantityProvenance,
    // Location architecture (spec §18) — only the client can know these
    // (device GPS accuracy, or whether the contributor moved the pin off
    // wherever geolocation first placed it), so unlike admin_area/country/
    // water_body below they're taken as given rather than derived here.
    locationAccuracy, locationCaptureMethod
  } = options;

  // Field-level provenance (spec §17): every key in `attributes` gets its
  // own entry in `attributeProvenance` rather than inheriting the
  // subject's single `source` wholesale. Most keys still just take the
  // subject's source (e.g. a measurement's `value`/`unit` really do share
  // one provenance — they came from the same instrument reading in the
  // same submission) — `overrides` is only for a field whose provenance
  // the caller actually knows differs, such as an AI-estimated quantity
  // the contributor then edited by hand.
  function withAttributeProvenance(attributes, source, overrides = {}) {
    const provenance = { ...overrides };
    for (const key of Object.keys(attributes)) {
      if (!(key in provenance)) provenance[key] = source;
    }
    return provenance;
  }

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
    // One taxonomy lookup per distinct (family, code) — but one output row
    // per *input* subject. Iterating aiSubjects (not rows) matters: two
    // entries sharing the same family/code (e.g. two `life:sea_turtle`
    // entries from a report with one entangled and one deceased turtle)
    // must each become their own event_subjects row, not collapse into a
    // single one that silently drops the second individual's attributes.
    const subjectIdByKey = new Map(rows.map((row) => [`${row.family}:${row.code}`, row.subject_id]));
    subjectsToInsert = aiSubjects
      .filter((match) => subjectIdByKey.has(`${match.family}:${match.code}`))
      .map((match) => {
        const subjectId = subjectIdByKey.get(`${match.family}:${match.code}`);
        // Callers that build subjects directly (e.g. the measurement intake,
        // which knows its own provenance — instrument reading vs. informal
        // observation) can override source/attributes per subject; AI intake
        // leaves both unset and gets the historical defaults.
        const source = match.source || 'ai_inferred';
        // The vocabulary (spec §7.3-7.4 condition enums, §7.1 free-text
        // severity/hazard) is re-validated here rather than trusted from the
        // request body — aiInferenceService already applies the same check
        // to what the model returns, but this endpoint accepts client-built
        // `attributes` too (measurement intake, and anything a future
        // manual-edit UI sends), so nothing reaches the DB unsanitized.
        const ontologyAttributes = sanitizeSubjectAttributes(match.family, match.attributes);
        // A measurement-intake subject supplies its own attributes wholesale
        // (e.g. {value, unit}) and isn't part of the ontology's condition/
        // severity vocabulary, so it passes through as-is alongside — not
        // instead of — whatever sanitizeSubjectAttributes recognized.
        const passthroughAttributes = match.attributes && Object.keys(ontologyAttributes).length === 0
          ? match.attributes : {};
        // quantity_kg only applies to pollution_waste, and only as a
        // fallback when the caller didn't already supply one (measurement
        // intake's {value, unit} has no quantity_kg concept at all).
        const needsQuantityFallback = match.family === 'pollution_waste'
          && !('quantity_kg' in passthroughAttributes) && !('quantity_kg' in ontologyAttributes);
        const attributes = { ...passthroughAttributes, ...ontologyAttributes };
        if (needsQuantityFallback) attributes.quantity_kg = Number(activity.quantity) || 0;

        const overrides = { ...(match.attributeProvenance || {}) };
        if (needsQuantityFallback && quantityProvenance) overrides.quantity_kg = quantityProvenance;

        return {
          subjectId,
          code: match.code,
          confidence: match.confidence ?? null,
          source,
          attributes,
          attributeProvenance: withAttributeProvenance(attributes, source, overrides)
        };
      });
  } else if (!intakeMethod) {
    // The category-derived pollution_waste fallback only makes sense for a
    // genuinely pre-AI submission — the legacy wizard/mobile-app path that
    // has no concept of `intakeMethod` at all and really is always a
    // cleanup report. A submission tagged with a modern intake method
    // (photo_video, tell_blue_mind, measurement, upload) that came back
    // with zero AI subjects — a failed/timed-out inference call, say — must
    // NOT be guessed as pollution_waste here: a wildlife sighting or
    // water-quality reading with a broken AI call would otherwise be
    // silently mislabeled as cleanup debris, exactly the "everything is
    // cleanup" behavior the universal-contributor model removes. Falling
    // through with zero subjects means no event is created for it (see the
    // length check below) — the activity record itself is still saved, so
    // nothing is lost, it's just left for a verifier to classify by hand
    // rather than guessed wrong automatically.
    const subjectCode = CATEGORY_TO_SUBJECT_CODE[activity.category] || 'mixed_waste';
    const { rows } = await query(
      `SELECT subject_id FROM subjects WHERE family = 'pollution_waste' AND code = $1`,
      [subjectCode]
    );
    subjectsToInsert = rows.map((row) => {
      const attributes = { quantity_kg: Number(activity.quantity) || 0 };
      return {
        subjectId: row.subject_id, code: subjectCode, confidence: null, source: 'user_provided',
        attributes,
        attributeProvenance: withAttributeProvenance(attributes, 'user_provided', quantityProvenance ? { quantity_kg: quantityProvenance } : {})
      };
    });
  } else {
    subjectsToInsert = [];
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

  const images = imageArrays(activity);

  // A lone claim with nothing behind it starts 'unverified'; a claim
  // backed by real evidence signals — a photo plus a GPS fix captured at
  // source (spec §14: "GPS captured at source", "direct camera capture")
  // — starts one notch up at 'supported' rather than making the
  // contributor wait for a human to say "yes, this looks real" before it
  // even reads as evidence-backed. Deliberately coarse — the richer
  // signals behind this level (AI confidence, contributor reliability,
  // instrument quality, contradictory evidence) are recorded separately by
  // confidenceSignalService rather than compressed into a fake score here
  // (spec §14: "do not make a fake scientifically precise score").
  const hasGps = activity.lat != null && activity.lon != null;
  const hasPhotoEvidence = images.length > 0;
  const initialVerificationState = hasGps && hasPhotoEvidence ? 'supported' : 'unverified';

  const captureMethod = LOCATION_CAPTURE_METHODS.has(locationCaptureMethod) ? locationCaptureMethod : null;
  const accuracyMeters = Number.isFinite(Number(locationAccuracy)) ? Number(locationAccuracy) : null;

  // Per-field location provenance (spec §17). lat/lon are system_captured
  // only when the device actually measured them; a hand-placed pin is
  // user_provided. The label is whatever the picker's reverse geocode
  // returned and is read-only in the UI, so it's external_enrichment —
  // but only when we know the picker was used at all; a legacy or API
  // submission that just posted a location string stays user_provided
  // rather than being credited to a lookup that never ran.
  const locationProvenance = captureMethod
    ? {
        lat: captureMethod === 'gps' ? 'system_captured' : 'user_provided',
        lon: captureMethod === 'gps' ? 'system_captured' : 'user_provided',
        location_label: 'external_enrichment',
        location_capture_method: 'system_captured',
        ...(accuracyMeters != null ? { location_accuracy_m: 'system_captured' } : {})
      }
    : {};

  const event = await query(
    `INSERT INTO environmental_events
       (contribution_id, legacy_activity_id, event_state, verification_state,
        occurred_at, lat, lon, location_label, location_source,
        location_accuracy_m, location_capture_method, location_provenance)
     VALUES ($1, $2, 'observed', $3, $4, $5, $6, $7, 'user_provided', $8, $9, $10)
     RETURNING event_id`,
    [
      contributionId, activity.id, initialVerificationState, activity.timestamp, activity.lat, activity.lon, activity.location,
      accuracyMeters, captureMethod, JSON.stringify(locationProvenance)
    ]
  );
  const eventId = event.rows[0].event_id;

  // Fire-and-forget (spec §17/§7.5: EXTERNAL_ENRICHMENT) — same contract as
  // backfillWeatherInBackground in activityController.js: a slow or failing
  // third-party geocoder must never delay or fail event creation. Only
  // patches columns the lookup actually resolved, so a partial result
  // (e.g. country but no named water body) doesn't overwrite the others.
  // The lookup itself is logged either way — a "found nothing" result is
  // still part of the audit trail, not just a successful one.
  if (activity.lat != null && activity.lon != null) {
    fetchLocationContext(activity.lat, activity.lon)
      .then((locationContext) => {
        const { adminArea, country, waterBody } = locationContext;
        logExternalEnrichment({
          eventId, sourceSystem: 'nominatim',
          input: { lat: activity.lat, lon: activity.lon },
          result: locationContext
        });
        if (adminArea == null && country == null && waterBody == null) return;
        // Each field this lookup actually resolved is recorded as
        // external_enrichment (spec §17) — the whole reason location
        // provenance had to become per-field: these arrive from a
        // third-party geocoder, not from the contributor.
        const enrichedProvenance = {
          ...(adminArea != null ? { admin_area: 'external_enrichment' } : {}),
          ...(country != null ? { country: 'external_enrichment' } : {}),
          ...(waterBody != null ? { water_body: 'external_enrichment' } : {})
        };
        return query(
          `UPDATE environmental_events
           SET admin_area = COALESCE($2, admin_area), country = COALESCE($3, country), water_body = COALESCE($4, water_body),
               location_provenance = location_provenance || $5::jsonb
           WHERE event_id = $1`,
          [eventId, adminArea, country, waterBody, JSON.stringify(enrichedProvenance)]
        );
      })
      .catch((err) => console.error('[locationEnrichmentService] background update failed for event', eventId, ':', err.message));
  }

  for (const subject of subjectsToInsert) {
    const { rows: subjectRows } = await query(
      `INSERT INTO event_subjects (event_id, subject_id, attributes, attribute_provenance, source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING event_subject_id`,
      [eventId, subject.subjectId, JSON.stringify(subject.attributes), JSON.stringify(subject.attributeProvenance), subject.source, subject.confidence]
    );

    // MEASUREMENT as its own entity (spec §26) — any subject carrying a
    // numeric `value` (today: the water-family measurement intake) also
    // gets a structured row here, alongside the JSONB attributes it
    // already has. `instrument`/`notes` come from the submission as a
    // whole (the measurement intake collects one of each per submission,
    // not per parameter) rather than being invented per-reading.
    if (Number.isFinite(subject.attributes?.value)) {
      await query(
        `INSERT INTO measurements (event_id, event_subject_id, parameter, value, unit, instrument, method, notes, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          eventId, subjectRows[0].event_subject_id, subject.code, subject.attributes.value, subject.attributes.unit || null,
          activity.instrument || null, subject.source === 'system_captured' ? 'instrument' : 'informal',
          activity.notes || null, subject.source
        ]
      );
    }
  }

  // `source` is set explicitly on every evidence insert (spec §17) rather
  // than left to the column default. The default happens to be right for
  // the paths that exist today, which is exactly the problem: a future
  // AI- or enrichment-attached item would inherit 'user_provided' and be
  // silently mislabelled as something the contributor supplied.
  // Different axis from `capture_source` (camera vs gallery): that says
  // how the file was obtained, this says who or what produced the record.
  for (const image of images) {
    await query(
      `INSERT INTO evidence (event_id, contribution_id, evidence_type, storage_url, gateway_url, cid, capture_source, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'user_provided')`,
      [eventId, contributionId, evidenceType || 'photo', image.storageUrl, image.gatewayUrl, image.cid, captureSource || 'unknown']
    );
  }

  if (rawText) {
    // A typed or spoken note is the contributor's own statement — they can
    // review and correct a voice transcript before submitting. Text pulled
    // out of an uploaded document is not: the machine extracted it, so it's
    // system_captured even though the document itself was user-supplied.
    const statementSource = intakeMethod === 'upload' ? 'system_captured' : 'user_provided';
    await query(
      `INSERT INTO evidence (event_id, contribution_id, evidence_type, capture_source, metadata, source)
       VALUES ($1, $2, 'contributor_statement', 'unknown', $3, $4)`,
      [eventId, contributionId, JSON.stringify({ text: rawText }), statementSource]
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
 * 'corroborated'/'needs_attention', never 'verified'. The one exception to
 * "never downgrades" is 'addressed' → 'reassessed': that's not a downgrade,
 * it's the spec §11 lifecycle's own next step when a closed report gets a
 * fresh independent corroborator.
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
  // Each existing matched event's true corroborator count keeps growing as
  // more reports come in — counting distinct linked events here (rather
  // than hardcoding 1 per call) is what lets, e.g., a third citizen's
  // report actually push an already-'supported' event on to 'corroborated'
  // instead of that event silently capping out after its first match.
  for (const match of matches) {
    const corroboratorCount = await countCorroborators(match.event_id);
    await bumpTowardCorroborated(match, corroboratorCount);
  }

  return { matchCount: matches.length, matchedEventIds: matches.map((m) => m.event_id) };
}

// Total distinct events linked to eventId via a 'corroborates' relationship
// in either direction — corroboration is symmetric (two reports of the same
// incident corroborate each other regardless of which one was submitted
// first), so both directions count toward the same total.
async function countCorroborators(eventId) {
  const { rows } = await query(
    `SELECT COUNT(DISTINCT other_id) AS count FROM (
       SELECT to_event_id AS other_id FROM event_relationships
       WHERE from_event_id = $1 AND relationship_type = 'corroborates'
       UNION
       SELECT from_event_id AS other_id FROM event_relationships
       WHERE to_event_id = $1 AND relationship_type = 'corroborates'
     ) AS corroborators`,
    [eventId]
  );
  return Number(rows[0]?.count || 0);
}

// The automated escalation ladder this function drives (spec §11:
// observed → corroborated → needs_attention). action_planned and beyond
// are only ever set by a human/verifier action elsewhere
// (planActionForEvent, completeAction, verifyEvent) — a state not in this
// map is left untouched below rather than climbed past.
const AUTO_EVENT_STATE_RANK = { observed: 0, corroborated: 1, needs_attention: 2 };

function nextAutoEventState(current, corroboratingCount) {
  // A closed report that gets a fresh independent corroborator is worth a
  // second look (spec §11's "Addressed → Reassessed") — someone reporting
  // the same subject at the same place again after it was marked resolved
  // is exactly the signal that should reopen it, not get silently ignored
  // the way it did before this event_state ever moved off 'addressed'.
  if (current.event_state === 'addressed') return 'reassessed';
  if (!(current.event_state in AUTO_EVENT_STATE_RANK)) return current.event_state;

  // Two or more independent corroborators is treated as "confirmed enough
  // that this needs someone to act on it now", not just "seen more than
  // once" — matching the verification_state threshold for 'corroborated'
  // just below, one rung further along the event_state ladder.
  const candidate = corroboratingCount >= 2 ? 'needs_attention' : 'corroborated';
  return AUTO_EVENT_STATE_RANK[candidate] > AUTO_EVENT_STATE_RANK[current.event_state]
    ? candidate
    : current.event_state;
}

async function bumpTowardCorroborated(current, corroboratingCount) {
  if (current.verification_state === 'verified') return;

  const candidateVerificationState = corroboratingCount >= 2 ? 'corroborated' : 'supported';
  const nextVerificationState =
    VERIFICATION_STATE_RANK[candidateVerificationState] > VERIFICATION_STATE_RANK[current.verification_state]
      ? candidateVerificationState
      : current.verification_state;
  const nextEventState = nextAutoEventState(current, corroboratingCount);

  if (nextEventState === current.event_state && nextVerificationState === current.verification_state) {
    return;
  }

  const note = nextEventState === 'reassessed'
    ? `Reassessed — ${corroboratingCount} new corroborating report(s) received after this was addressed`
    : `Corroborated by ${corroboratingCount} nearby event(s) within ${CORROBORATION_RADIUS_METERS}m / ${CORROBORATION_WINDOW_DAYS}d`;
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

  // Trust-weighted points (spec §14): the original contributor earns a
  // corroboration bonus the moment independent reports push their
  // submission's verification_state forward — not for how much they
  // reported, for being confirmed by someone else.
  if (nextVerificationState !== current.verification_state) {
    const { rows: contribRows } = await query(
      `SELECT c.contributor_id FROM environmental_events e
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE e.event_id = $1`,
      [current.event_id]
    );
    const contributorId = contribRows[0]?.contributor_id;
    if (contributorId) {
      await awardCorroborationPoints({ eventId: current.event_id, userId: contributorId }).catch((err) =>
        console.error('[rewardLedgerService] corroboration points failed for event', current.event_id, ':', err.message)
      );
    }
  }
}

function mapEventSummaryRow(row) {
  // Same three checks runIntakePipeline computes at intake time (spec
  // §20), recomputed at read time instead of stored — cheap enough as
  // scalar subqueries, and it means a verifier always sees the event's
  // *current* completeness rather than a snapshot from whenever it was
  // first submitted.
  const sanityFlags = [];
  if (row.lat == null || row.lon == null) sanityFlags.push('missing_location');
  if (Number(row.evidence_count) === 0) sanityFlags.push('no_evidence');
  if (!row.subjects || row.subjects.length === 0) sanityFlags.push('no_subject');

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
    organizationId: row.organization_id,
    subjects: row.subjects || [],
    corroborationCount: Number(row.corroboration_count) || 0,
    connectionCount: Number(row.connection_count) || 0,
    // Always an array over the wire, whatever the driver hands back — a
    // client mapping over this shouldn't have to care how pg decoded it.
    connectionTypes: Array.isArray(row.connection_types) ? row.connection_types : [],
    impact: Array.isArray(row.impact) ? row.impact : [],
    evidenceUrls: Array.isArray(row.evidence_urls) ? row.evidence_urls.filter(Boolean) : [],
    sanityFlags
  };
}

/**
 * listEvents — a page of events with their subjects rolled up, newest
 * first. Filters are optional and silently ignored if the value isn't a
 * real enum/family member, rather than erroring on a typo'd query param.
 * `eventIds` (spec §20: verifier queue signals) lets a caller ask for
 * summaries of an exact, already-known set of events in one round trip —
 * e.g. the legacy activity queue resolving each pending activity's linked
 * event — rather than one request per event.
 */
export async function listEvents({ eventState, verificationState, subjectFamily, contributorId, organizationId, eventIds, limit, offset } = {}) {
  const conditions = [];
  const params = [];

  if (contributorId) {
    params.push(contributorId);
    conditions.push(`EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.contribution_id = e.contribution_id AND c.contributor_id = $${params.length}
    )`);
  }
  if (UUID_PATTERN.test(organizationId || '')) {
    params.push(organizationId);
    conditions.push(`EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.contribution_id = e.contribution_id AND c.organization_id = $${params.length}
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
  const validEventIds = Array.isArray(eventIds) ? eventIds.filter((id) => UUID_PATTERN.test(id)) : [];
  if (validEventIds.length > 0) {
    params.push(validEventIds);
    conditions.push(`e.event_id = ANY($${params.length}::uuid[])`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // eventIds callers want every match in one shot, not a paginated page of
  // an already-bounded set — 200 stays the ceiling either way.
  const safeLimit = validEventIds.length > 0 ? Math.min(validEventIds.length, 200) : Math.min(Math.max(toNumber(limit) || 50, 1), 200);
  const safeOffset = Math.max(toNumber(offset) || 0, 0);
  params.push(safeLimit, safeOffset);

  const result = await query(
    `SELECT e.event_id, e.legacy_activity_id, e.title, e.description, e.event_state, e.verification_state,
            e.occurred_at, e.lat, e.lon, e.location_label, e.created_at, e.updated_at, c.organization_id,
            -- Ordered by what the event is about, not by jsonb value.
            -- json_agg(DISTINCT ...) sorts by the serialized object, so
            -- "subjects[0]" was effectively arbitrary and could surface the
            -- human_action ("Cleanup / removal") as the event's own name.
            (SELECT COALESCE(json_agg(sub ORDER BY sub->>'rank', sub->>'label'), '[]'::json)
             FROM (
               SELECT DISTINCT jsonb_build_object(
                 'subjectId', s2.subject_id, 'family', s2.family, 'code', s2.code, 'label', s2.label,
                 'rank', CASE s2.family
                   WHEN 'pollution_waste' THEN '0' WHEN 'life' THEN '1' WHEN 'habitat' THEN '2'
                   WHEN 'water' THEN '3' WHEN 'conditions' THEN '4' ELSE '5' END
               ) AS sub
               FROM event_subjects es2
               JOIN subjects s2 ON s2.subject_id = es2.subject_id
               WHERE es2.event_id = e.event_id
             ) ordered_subjects) AS subjects,
            (SELECT COUNT(*) FROM evidence ev WHERE ev.event_id = e.event_id) AS evidence_count,
            (SELECT COUNT(DISTINCT other_id) FROM (
               SELECT to_event_id AS other_id FROM event_relationships
               WHERE from_event_id = e.event_id AND relationship_type = 'corroborates'
               UNION
               SELECT from_event_id AS other_id FROM event_relationships
               WHERE to_event_id = e.event_id AND relationship_type = 'corroborates'
             ) AS corroborators) AS corroboration_count,
            -- spec §16's "Connected Events": every link this event has to
            -- another, not only corroboration — a report answered by an
            -- action (responds_to), a follow-up survey, a duplicate, all
            -- count as "this didn't stay an isolated record".
            (SELECT COUNT(DISTINCT other_id) FROM (
               SELECT to_event_id AS other_id FROM event_relationships WHERE from_event_id = e.event_id
               UNION
               SELECT from_event_id AS other_id FROM event_relationships WHERE to_event_id = e.event_id
             ) AS connected) AS connection_count,
            -- ::text is load-bearing: relationship_type is a custom enum, and
            -- node-postgres has no parser registered for an enum array's OID,
            -- so ARRAY_AGG over the raw enum comes back as the literal string
            -- '{corroborates,responds_to}' instead of a JS array. Casting to
            -- text[] hits a type pg does parse.
            (SELECT ARRAY_AGG(DISTINCT rel_type::text) FROM (
               SELECT relationship_type AS rel_type FROM event_relationships WHERE from_event_id = e.event_id
               UNION
               SELECT relationship_type AS rel_type FROM event_relationships WHERE to_event_id = e.event_id
             ) AS rel_types) AS connection_types,
            -- What actually changed (spec §4's "86 kg was removed" beat).
            -- Previously only getEventDetail fetched this, so the dashboard's
            -- "What Changed Because of You" card could say an event was
            -- resolved but never what the resolution produced. Cast to float8
            -- because pg hands NUMERIC back as a string.
            (SELECT COALESCE(json_agg(json_build_object(
               'metric', ei.metric, 'value', ei.value::float8, 'unit', ei.unit
             ) ORDER BY ei.recorded_at DESC), '[]'::json)
             FROM event_impact ei WHERE ei.event_id = e.event_id) AS impact,
            -- Evidence thumbnails, so one card design can serve both
            -- legacy-backed events (which have photos) and event-model-only
            -- ones (which may not) without the page falling back to the old
            -- activities table to find an image.
            (SELECT COALESCE(json_agg(ev.gateway_url ORDER BY ev.created_at ASC), '[]'::json)
             FROM evidence ev
             WHERE ev.event_id = e.event_id
               AND ev.gateway_url IS NOT NULL
               AND ev.evidence_type IN ('photo', 'video')) AS evidence_urls
     FROM environmental_events e
     LEFT JOIN contributions c ON c.contribution_id = e.contribution_id
     LEFT JOIN event_subjects es ON es.event_id = e.event_id
     LEFT JOIN subjects s ON s.subject_id = es.subject_id
     ${whereClause}
     GROUP BY e.event_id, c.organization_id
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
            occurred_at, lat, lon, location_label, location_source, location_provenance,
            location_accuracy_m, location_capture_method, admin_area, country, water_body,
            created_at, updated_at
     FROM environmental_events
     WHERE event_id = $1`,
    [eventId]
  );
  const eventRow = eventRows[0];
  if (!eventRow) return null;

  const [subjects, evidence, relationshipsFrom, relationshipsTo, stateHistory, verifications, impact, measurements, confidenceSignals] =
    await Promise.all([
      query(
        `SELECT es.event_subject_id, es.subject_id, s.family, s.code, s.label,
                es.attributes, es.attribute_provenance, es.source, es.confidence,
                es.corrects_event_subject_id, es.created_at
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
      ),
      query(
        `SELECT measurement_id, event_subject_id, parameter, value, unit, instrument, method, notes, source, recorded_at
         FROM measurements
         WHERE event_id = $1
         ORDER BY recorded_at ASC`,
        [eventId]
      ),
      query(
        `SELECT signal, stance, detail, computed_at
         FROM confidence_signals
         WHERE event_id = $1
         ORDER BY
           CASE stance WHEN 'weakens' THEN 0 WHEN 'supports' THEN 1 ELSE 2 END,
           signal ASC`,
        [eventId]
      )
    ]);

  return {
    ...mapEventSummaryRow({ ...eventRow, subjects: undefined }),
    locationSource: eventRow.location_source,
    // spec §18 — accuracy/captureMethod come from the client at intake
    // (only the device knows these); adminArea/country/waterBody are
    // filled in later by locationEnrichmentService's background lookup,
    // so null here can mean "not enriched yet" as well as "not found".
    locationAccuracyM: eventRow.location_accuracy_m,
    locationCaptureMethod: eventRow.location_capture_method,
    adminArea: eventRow.admin_area,
    country: eventRow.country,
    waterBody: eventRow.water_body,
    // Per-field location provenance (spec §17). Any field with no stored
    // entry — every row written before this column existed — falls back to
    // location_source, exactly how it read before per-field tracking.
    locationProvenance: Object.fromEntries(
      ['lat', 'lon', 'location_label', 'location_accuracy_m', 'location_capture_method', 'admin_area', 'country', 'water_body']
        .filter((field) => eventRow[field] != null)
        .map((field) => [field, (eventRow.location_provenance || {})[field] || eventRow.location_source])
    ),
    subjects: subjects.rows.map((r) => {
      const attributes = r.attributes || {};
      const storedProvenance = r.attribute_provenance || {};
      // Backfill: a key with no stored provenance (older rows written
      // before this column existed) reads as the subject's own source,
      // same as it behaved before per-field tracking existed.
      const attributeProvenance = Object.fromEntries(
        Object.keys(attributes).map((key) => [key, storedProvenance[key] || r.source])
      );
      return {
        eventSubjectId: r.event_subject_id,
        subjectId: r.subject_id,
        family: r.family,
        code: r.code,
        label: r.label,
        attributes,
        attributeProvenance,
        source: r.source,
        confidence: r.confidence,
        // Set when this row is itself a correction (spec §7) — the UI reads
        // it both ways: to label this row as the current identification, and
        // to mark the row it names as superseded history rather than dropping
        // it from view.
        correctsEventSubjectId: r.corrects_event_subject_id,
        createdAt: r.created_at
      };
    }),
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
    })),
    // MEASUREMENT as its own entity (spec §26) — structured readings with
    // their own instrument/method/notes, distinct from the subject's own
    // generic {value, unit} attributes.
    measurements: measurements.rows.map((r) => ({
      measurementId: r.measurement_id,
      eventSubjectId: r.event_subject_id,
      parameter: r.parameter,
      value: Number(r.value),
      unit: r.unit,
      instrument: r.instrument,
      method: r.method,
      notes: r.notes,
      source: r.source,
      recordedAt: r.recorded_at
    })),
    // The detailed signals behind verificationState (spec §14) — no score,
    // just which way each signal leans and why. Ordered weakens-first: the
    // reasons to look closer are the ones a verifier needs to see.
    confidenceSignals: confidenceSignals.rows.map((r) => ({
      signal: r.signal,
      stance: r.stance,
      detail: r.detail,
      computedAt: r.computed_at
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

  // Generic, family-agnostic breakdowns (spec §8/§16: metrics must adapt to
  // contributor type instead of assuming everyone is a cleanup crew). The
  // UI derives its own per-type metric set from these rather than the
  // backend hardcoding "rescues"/"anomalies"/etc. per family.
  const [{ rows: familyRows }, { rows: metricRows }, { rows: intakeRows }] = await Promise.all([
    query(
      `SELECT s.family,
              COUNT(DISTINCT es.event_id)::int AS event_count,
              COUNT(DISTINCT es.event_id) FILTER (WHERE e.event_state = 'addressed')::int AS addressed_count,
              COUNT(DISTINCT es.event_id) FILTER (WHERE e.event_state = 'needs_attention')::int AS needs_attention_count,
              -- spec §8's per-type metric examples need a third count each
              -- beyond total/addressed: "confirmed species observations"
              -- (verified), "recurring changes" (recurring), "observations
              -- corroborated" (corroborated). Counted per family here so the
              -- UI can keep choosing its own labels.
              COUNT(DISTINCT es.event_id) FILTER (WHERE e.verification_state = 'verified')::int AS verified_count,
              COUNT(DISTINCT es.event_id) FILTER (WHERE e.event_state = 'recurring')::int AS recurring_count,
              COUNT(DISTINCT es.event_id) FILTER (WHERE e.verification_state = 'corroborated' OR e.event_state = 'corroborated')::int AS corroborated_count
       FROM event_subjects es
       JOIN subjects s ON s.subject_id = es.subject_id
       JOIN environmental_events e ON e.event_id = es.event_id
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.contributor_id = $1
       GROUP BY s.family`,
      [contributorId]
    ),
    query(
      `SELECT ei.metric, ei.unit, COALESCE(SUM(ei.value), 0) AS total
       FROM event_impact ei
       JOIN environmental_events e ON e.event_id = ei.event_id
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.contributor_id = $1
       GROUP BY ei.metric, ei.unit`,
      [contributorId]
    ),
    // spec §8's research contributor ("datasets contributed", "records
    // reused/connected"). Research isn't a subject family — a researcher's
    // data is *about* water or life — so it can't be derived from byFamily
    // like the other types. What distinguishes them is HOW they contribute:
    // uploaded datasets/documents rather than field photos.
    query(
      `SELECT
         COUNT(*) FILTER (WHERE c.intake_method = 'upload')::int AS datasets,
         COUNT(*)::int AS total_contributions,
         (SELECT COUNT(DISTINCT e2.event_id)
          FROM environmental_events e2
          JOIN contributions c2 ON c2.contribution_id = e2.contribution_id
          WHERE c2.contributor_id = $1
            AND EXISTS (
              SELECT 1 FROM event_relationships r
              WHERE r.from_event_id = e2.event_id OR r.to_event_id = e2.event_id
            ))::int AS connected_events
       FROM contributions c
       WHERE c.contributor_id = $1`,
      [contributorId]
    )
  ]);

  const byFamily = {};
  for (const r of familyRows) {
    byFamily[r.family] = {
      total: r.event_count,
      addressed: r.addressed_count,
      needsAttention: r.needs_attention_count,
      verified: r.verified_count,
      recurring: r.recurring_count,
      corroborated: r.corroborated_count
    };
  }

  const byMetric = {};
  for (const r of metricRows) {
    byMetric[r.metric] = { value: Number(r.total) || 0, unit: r.unit || null };
  }

  const intake = intakeRows[0] || {};

  return {
    contributions: Number(row.contributions) || 0,
    verifiedEvents: Number(row.verified_events) || 0,
    actionsCompleted: Number(row.actions_completed) || 0,
    kgRemoved: Number(row.kg_removed) || 0,
    locationsAffected: Number(row.locations_affected) || 0,
    byFamily,
    byMetric,
    // Contribution *shape* rather than subject matter (spec §8's research
    // contributor) — lets the UI recognise a researcher by how they work.
    datasetsContributed: Number(intake.datasets) || 0,
    connectedEvents: Number(intake.connected_events) || 0,
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
  // further along (e.g. don't stomp 'disputed'). 'reassessed' is included
  // so a report that was closed, then reopened by a fresh corroborator,
  // can actually be acted on again instead of being a dead end.
  if (['observed', 'corroborated', 'needs_attention', 'reassessed'].includes(observation.event_state)) {
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
 * completeAction — the action event itself moves to 'addressed' (the team's
 * side of the work is done) and an impact record + completion photos land
 * as evidence (spec §27: "They upload photos and weight"). The
 * observations it responds to move only as far as 'action_underway' here
 * — spec §27 has a verifier review the evidence *after* completion before
 * the original report is closed out, so closing those to 'addressed' is
 * verifyEvent()'s job below, not this one's. This function's own
 * 'addressed' is about the action being done, not the report being
 * confirmed resolved.
 */
export async function completeAction(actionEventId, { actorId, kgRemoved, impacts, note, images }) {
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

  // No contribution_id here (evidence.contribution_id is nullable) — a
  // completion photo is attached directly by the acting org/verifier at
  // closeout, not submitted as a raw contribution the way intake evidence
  // is. Still user_provided: a person attached it, just at a later step.
  for (const image of images || []) {
    await query(
      `INSERT INTO evidence (event_id, evidence_type, storage_url, gateway_url, cid, capture_source, source)
       VALUES ($1, 'photo', $2, $3, $4, 'unknown', 'user_provided')`,
      [actionEventId, image.storageUrl, image.gatewayUrl, image.cid]
    );
  }

  // Generic outcome recording (spec §7/§11): a rescue writes
  // {metric:'lives_rescued', value:1, unit:'count'}, a restoration action
  // writes {metric:'condition_change', ...} — not every action is
  // kg-removed. `kgRemoved` stays as a convenience shorthand for the
  // cleanup case rather than a required/only shape.
  const impactEntries = [
    ...(kgRemoved != null && Number(kgRemoved) > 0
      ? [{ metric: 'debris_removed_kg', value: Number(kgRemoved), unit: 'kg' }]
      : []),
    ...(Array.isArray(impacts) ? impacts.filter((i) => i && i.metric && i.value != null) : [])
  ];
  for (const { metric, value, unit } of impactEntries) {
    await query(
      `INSERT INTO event_impact (event_id, metric, value, unit) VALUES ($1, $2, $3, $4)`,
      [actionEventId, metric, Number(value), unit || null]
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
    // Bumped to 'action_underway' (the removal has happened, on the
    // ground), not 'addressed' — that final close-out waits for a
    // verifier, in verifyEvent() below. Never touches an observation
    // that's already past this point (addressed/disputed/etc.). Includes
    // 'reassessed' so a reopened report can be worked a second time.
    if (['observed', 'corroborated', 'needs_attention', 'action_planned', 'reassessed'].includes(obsOldState)) {
      await query(
        `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
         VALUES ($1, 'event_state', $2, 'action_underway', $3, 'Removal completed, pending verification')`,
        [row.to_event_id, obsOldState, actorId]
      );
      await query(
        `UPDATE environmental_events SET event_state = 'action_underway', updated_at = NOW() WHERE event_id = $1`,
        [row.to_event_id]
      );
    }
  }

  return responded.map((r) => r.to_event_id);
}

// Every contributor with a stake in eventId: its own reporter, plus the
// reporters of anything linked to it via 'corroborates' (the "three
// additional users" from spec §27's example) — everyone whose report this
// closure actually resolves, not just whoever happened to submit first.
async function getContributorsToNotify(eventId) {
  const { rows } = await query(
    `SELECT DISTINCT contributor_id FROM (
       SELECT c.contributor_id
       FROM environmental_events e
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE e.event_id = $1
       UNION
       SELECT c.contributor_id
       FROM event_relationships r
       JOIN environmental_events e ON e.event_id = r.to_event_id
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE r.relationship_type = 'corroborates' AND r.from_event_id = $1
       UNION
       SELECT c.contributor_id
       FROM event_relationships r
       JOIN environmental_events e ON e.event_id = r.from_event_id
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE r.relationship_type = 'corroborates' AND r.to_event_id = $1
     ) AS contributors
     WHERE contributor_id IS NOT NULL`,
    [eventId]
  );
  return rows.map((r) => r.contributor_id);
}

// What the event is *about*, for the one-line notification subject.
// human_action is ranked last deliberately: a cleanup is what people did
// about the event, not what the event is, and ordering by confidence alone
// let it win (a contributor-confirmed action carries confidence 1.0), which
// produced "Cleanup / removal reported near X has been addressed" instead
// of naming the ghost net.
async function getPrimarySubjectLabel(eventId) {
  const { rows } = await query(
    `SELECT s.label FROM event_subjects es
     JOIN subjects s ON s.subject_id = es.subject_id
     WHERE es.event_id = $1
     ORDER BY
       CASE s.family
         WHEN 'pollution_waste' THEN 0 WHEN 'life' THEN 1 WHEN 'habitat' THEN 2
         WHEN 'water' THEN 3 WHEN 'conditions' THEN 4 ELSE 5
       END,
       es.confidence DESC NULLS LAST,
       es.created_at ASC
     LIMIT 1`,
    [eventId]
  );
  return rows[0]?.label || null;
}

// Notifies everyone with a stake in eventId that it just closed (spec
// §22-23, §27: "Something you reported changed"). Each recipient's role is
// looked up individually — contributors span both the 'contributor' and
// 'citizen' roles, and notifications.recipient_role must match whichever
// one a given person actually has.
async function notifyEventClosure(eventId, { locationLabel, impacts }) {
  const [subjectLabel, contributorIds] = await Promise.all([
    getPrimarySubjectLabel(eventId),
    getContributorsToNotify(eventId)
  ]);

  for (const contributorId of contributorIds) {
    const contributor = await findUserById(contributorId);
    if (!contributor?.role) continue;
    await notifyClosure({
      contributorId,
      contributorRole: contributor.role,
      subjectLabel,
      locationLabel,
      impacts,
      eventId
    });
  }
}

const VERIFY_OUTCOMES = new Set(['verified', 'disputed', 'unable_to_verify']);

/**
 * verifyEvent — spec §20/§27's missing piece: a verifier (not the
 * contributor/org who did the work) reviews the evidence and records an
 * outcome. Only a 'verified' outcome on an action event cascades to close
 * out the observation(s) it 'responds_to' — completing an action is not
 * itself sufficient to mark the original report resolved, a human review
 * is. 'disputed'/'unable_to_verify' route the event into the matching
 * existing event_state values rather than silently closing anything.
 */
export async function verifyEvent(eventId, { verifierId, outcome, notes }) {
  if (!VERIFY_OUTCOMES.has(outcome)) {
    throw new Error(`Unknown verification outcome: ${outcome}`);
  }

  const { rows } = await query(
    `SELECT event_state, verification_state FROM environmental_events WHERE event_id = $1`,
    [eventId]
  );
  const current = rows[0];
  if (!current) {
    throw new Error('Event not found');
  }

  const { rows: verificationRows } = await query(
    `INSERT INTO verifications (event_id, verifier_id, outcome, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING verification_id`,
    [eventId, verifierId, outcome, notes || null]
  );

  // Fire-and-forget, same pattern as recordActivityOnChain's caller (spec
  // §21): a slow/failed chain submission must never block the verifier's
  // request. Proved regardless of outcome — this is the ONLY proof
  // mechanism an action-event (no legacy_activity_id, spec §27) will ever
  // get, and a 'disputed' attestation deserves tamper-evidence as much as
  // a 'verified' one does. Legacy-activity-backed events already get an
  // equivalent proof via recordActivityOnChain on the activity itself
  // (see recordReviewOnEvent above), so this isn't a duplicate for them —
  // it's the record of the verifier's own attestation, not the original
  // submission.
  recordVerificationOnChain(verificationRows[0].verification_id).catch((proofErr) =>
    console.error('[onchainProof] background submission failed for verification', verificationRows[0].verification_id, ':', proofErr.message)
  );

  // A verifier acting on the event changes the verifier_review signal (and,
  // for an adverse outcome, contradictory_evidence) — recompute so the
  // stored signals explain the state the event is actually in now (spec §14).
  await computeConfidenceSignals(eventId);

  if (outcome === 'verified') {
    if (VERIFICATION_STATE_RANK.verified > VERIFICATION_STATE_RANK[current.verification_state]) {
      await query(
        `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
         VALUES ($1, 'verification_state', $2, 'verified', $3, $4)`,
        [eventId, current.verification_state, verifierId, notes || null]
      );
      await query(
        `UPDATE environmental_events SET verification_state = 'verified', updated_at = NOW() WHERE event_id = $1`,
        [eventId]
      );

      // Trust-weighted points (spec §14): a human verifier confirming the
      // report is worth more than corroboration alone, and — like
      // corroboration bonuses — has nothing to do with reported quantity.
      const { rows: contribRows } = await query(
        `SELECT c.contributor_id FROM environmental_events e
         JOIN contributions c ON c.contribution_id = e.contribution_id
         WHERE e.event_id = $1`,
        [eventId]
      );
      const contributorId = contribRows[0]?.contributor_id;
      if (contributorId) {
        await awardVerificationPoints({ eventId, userId: contributorId }).catch((err) =>
          console.error('[rewardLedgerService] verification points failed for event', eventId, ':', err.message)
        );
      }
    }

    const { rows: responded } = await query(
      `SELECT to_event_id FROM event_relationships WHERE from_event_id = $1 AND relationship_type = 'responds_to'`,
      [eventId]
    );

    // All outcome metrics recorded on this action event, generic across
    // subject type (kg removed, lives rescued, condition change, ...) —
    // not just the cleanup-specific 'debris_removed_kg'.
    const { rows: impacts } = await query(
      `SELECT metric, value, unit FROM event_impact WHERE event_id = $1 ORDER BY created_at DESC`,
      [eventId]
    );

    const closedEventIds = [];
    for (const row of responded) {
      const { rows: obsRows } = await query(
        `SELECT event_state, location_label FROM environmental_events WHERE event_id = $1`,
        [row.to_event_id]
      );
      const obsOldState = obsRows[0]?.event_state;
      if (obsOldState && obsOldState !== 'addressed') {
        await query(
          `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
           VALUES ($1, 'event_state', $2, 'addressed', $3, 'Closed by verified action')`,
          [row.to_event_id, obsOldState, verifierId]
        );
        await query(
          `UPDATE environmental_events SET event_state = 'addressed', updated_at = NOW() WHERE event_id = $1`,
          [row.to_event_id]
        );
        closedEventIds.push(row.to_event_id);

        // Fire-and-forget from the closure itself: a notification failure
        // must never undo or block the state change that already committed.
        notifyEventClosure(row.to_event_id, {
          locationLabel: obsRows[0].location_label,
          impacts
        }).catch((err) =>
          console.error('[notificationService] closure notification failed for event', row.to_event_id, ':', err.message)
        );
      }
    }

    return { closedEventIds };
  }

  // 'disputed' / 'unable_to_verify' — the enum already has an event_state
  // for each; route into it rather than leaving verification_state as the
  // only record of the outcome. Never overrides an event already
  // 'addressed' — a verifier disputing evidence on a closed report should
  // not silently reopen it.
  if (current.event_state !== 'addressed') {
    await query(
      `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
       VALUES ($1, 'event_state', $2, $3, $4, $5)`,
      [eventId, current.event_state, outcome, verifierId, notes || null]
    );
    await query(
      `UPDATE environmental_events SET event_state = $2, updated_at = NOW() WHERE event_id = $1`,
      [eventId, outcome]
    );
  }

  return { closedEventIds: [] };
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

/**
 * getContributorStories — spec §4's "What Changed Because of You", told as
 * the full chain rather than a status badge: you reported it → others saw
 * the same thing → the reports were merged → someone acted → this much
 * changed → it was verified.
 *
 * Deliberately its own endpoint rather than more columns on listEvents:
 * that query feeds the map with up to 200 events, and these joins (acting
 * organization, verifier identity) are only worth paying for on the handful
 * of stories actually rendered.
 *
 * Every beat is derived from recorded data. Beats with nothing behind them
 * are omitted rather than guessed at — a story that invents who acted is
 * worse than a shorter one.
 */
export async function getContributorStories(contributorId, limit = 3) {
  const safeLimit = Math.min(Math.max(toNumber(limit) || 3, 1), 10);

  const { rows: eventRows } = await query(
    `SELECT e.event_id, e.title, e.location_label, e.created_at, e.updated_at,
            e.verification_state, c.intake_method
     FROM environmental_events e
     JOIN contributions c ON c.contribution_id = e.contribution_id
     WHERE c.contributor_id = $1 AND e.event_state = 'addressed'
     ORDER BY e.updated_at DESC
     LIMIT $2`,
    [contributorId, safeLimit]
  );
  if (eventRows.length === 0) return [];

  const eventIds = eventRows.map((r) => r.event_id);

  const [subjects, corroboration, impact, actions, verifications, closures] = await Promise.all([
    query(
      `SELECT es.event_id, s.family, s.code, s.label
       FROM event_subjects es
       JOIN subjects s ON s.subject_id = es.subject_id
       WHERE es.event_id = ANY($1::uuid[])
       ORDER BY es.created_at ASC`,
      [eventIds]
    ),
    query(
      `SELECT e.event_id, COUNT(DISTINCT other_id)::int AS corroborators
       FROM environmental_events e
       LEFT JOIN LATERAL (
         SELECT to_event_id AS other_id FROM event_relationships
         WHERE from_event_id = e.event_id AND relationship_type = 'corroborates'
         UNION
         SELECT from_event_id FROM event_relationships
         WHERE to_event_id = e.event_id AND relationship_type = 'corroborates'
       ) AS c ON TRUE
       WHERE e.event_id = ANY($1::uuid[])
       GROUP BY e.event_id`,
      [eventIds]
    ),
    query(
      `SELECT event_id, metric, value::float8 AS value, unit
       FROM event_impact
       WHERE event_id = ANY($1::uuid[])
       ORDER BY recorded_at DESC`,
      [eventIds]
    ),
    // The action that answered the report: an event related by 'responds_to'
    // pointing AT this one. Its actor comes from the relationship's
    // created_by (action events carry no contribution of their own), so the
    // organization is resolved through that user.
    query(
      `SELECT r.to_event_id AS event_id, a.title AS action_title, a.occurred_at AS acted_at,
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS actor_name,
              o.name AS actor_org
       FROM event_relationships r
       JOIN environmental_events a ON a.event_id = r.from_event_id
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN organizations o ON o.org_id = u.organization_id
       WHERE r.to_event_id = ANY($1::uuid[]) AND r.relationship_type = 'responds_to'
       ORDER BY a.occurred_at DESC`,
      [eventIds]
    ),
    query(
      `SELECT v.event_id, v.created_at,
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS verifier_name,
              o.name AS verifier_org
       FROM verifications v
       LEFT JOIN users u ON u.id = v.verifier_id
       LEFT JOIN organizations o ON o.org_id = u.organization_id
       WHERE v.event_id = ANY($1::uuid[]) AND v.outcome = 'verified'
       ORDER BY v.created_at DESC`,
      [eventIds]
    ),
    // When it actually closed, rather than whenever the row last changed.
    query(
      `SELECT DISTINCT ON (event_id) event_id, changed_at
       FROM event_state_history
       WHERE event_id = ANY($1::uuid[]) AND field = 'event_state' AND new_value = 'addressed'
       ORDER BY event_id, changed_at DESC`,
      [eventIds]
    )
  ]);

  const firstBy = (rows, key) => {
    const map = new Map();
    for (const row of rows) if (!map.has(row[key])) map.set(row[key], row);
    return map;
  };
  const groupBy = (rows, key) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row[key])) map.set(row[key], []);
      map.get(row[key]).push(row);
    }
    return map;
  };

  const subjectsByEvent = groupBy(subjects.rows, 'event_id');
  const impactByEvent = groupBy(impact.rows, 'event_id');
  const corroborationByEvent = firstBy(corroboration.rows, 'event_id');
  const actionByEvent = firstBy(actions.rows, 'event_id');
  const verificationByEvent = firstBy(verifications.rows, 'event_id');
  const closureByEvent = firstBy(closures.rows, 'event_id');

  return eventRows.map((e) => {
    const action = actionByEvent.get(e.event_id) || null;
    const verification = verificationByEvent.get(e.event_id) || null;
    const corroborators = corroborationByEvent.get(e.event_id)?.corroborators || 0;
    return {
      eventId: e.event_id,
      title: e.title,
      locationLabel: e.location_label,
      reportedAt: e.created_at,
      closedAt: closureByEvent.get(e.event_id)?.changed_at || e.updated_at,
      intakeMethod: e.intake_method,
      verificationState: e.verification_state,
      subjects: (subjectsByEvent.get(e.event_id) || [])
        .map((s) => ({ family: s.family, code: s.code, label: s.label })),
      corroboratorCount: corroborators,
      // What the contributor sees as "N reports merged into one event" —
      // their own plus everyone who corroborated it.
      mergedReportCount: corroborators > 0 ? corroborators + 1 : 0,
      action: action && {
        title: action.action_title,
        actedAt: action.acted_at,
        actorName: action.actor_name,
        actorOrg: action.actor_org
      },
      impact: (impactByEvent.get(e.event_id) || [])
        .map((i) => ({ metric: i.metric, value: i.value, unit: i.unit })),
      verification: verification && {
        verifiedAt: verification.created_at,
        verifierName: verification.verifier_name,
        verifierOrg: verification.verifier_org
      }
    };
  });
}

/**
 * correctSubject — spec §7's "a species may initially be identified
 * incorrectly, later an expert may correct it". Appends a new
 * event_subjects row carrying the corrected identification and points it
 * back at the row it supersedes; the original row is never updated or
 * deleted, so both interpretations stay readable and the first one keeps
 * whatever provenance it was submitted with. The correction itself is
 * logged to event_state_history so who changed it, when, and why stay
 * visible alongside the event's other state changes.
 */
export async function correctSubject(eventSubjectId, { verifierId, family, code, attributes, note }) {
  if (!UUID_PATTERN.test(eventSubjectId || '')) {
    throw new Error('Subject not found');
  }

  const { rows: existingRows } = await query(
    `SELECT es.event_subject_id, es.event_id, s.family AS old_family, s.code AS old_code
     FROM event_subjects es
     JOIN subjects s ON s.subject_id = es.subject_id
     WHERE es.event_subject_id = $1`,
    [eventSubjectId]
  );
  const existing = existingRows[0];
  if (!existing) {
    throw new Error('Subject not found');
  }

  // A correction may only land on a family/code that actually exists in the
  // taxonomy — same rule the AI classifier is held to, so a human correction
  // can't introduce a subject the rest of the system can't interpret.
  const { rows: taxonomyRows } = await query(
    `SELECT subject_id FROM subjects WHERE family = $1 AND code = $2 AND is_active = true`,
    [family, code]
  );
  const taxonomyRow = taxonomyRows[0];
  if (!taxonomyRow) {
    throw new Error(`Unknown subject: ${family}/${code}`);
  }

  // Already-superseded rows are the history, not the current reading — a
  // correction has to be made against whatever supersedes them instead.
  const { rows: supersededRows } = await query(
    `SELECT 1 FROM event_subjects WHERE corrects_event_subject_id = $1 LIMIT 1`,
    [eventSubjectId]
  );
  if (supersededRows.length > 0) {
    throw new Error('This subject has already been corrected — correct the current identification instead');
  }

  const sanitizedAttributes = sanitizeSubjectAttributes(family, attributes);
  const attributeProvenance = Object.fromEntries(
    Object.keys(sanitizedAttributes).map((key) => [key, 'verifier_confirmed'])
  );

  const { rows: inserted } = await query(
    `INSERT INTO event_subjects
       (event_id, subject_id, attributes, attribute_provenance, source, confidence, corrects_event_subject_id)
     VALUES ($1, $2, $3, $4, 'verifier_confirmed', NULL, $5)
     RETURNING event_subject_id`,
    [
      existing.event_id,
      taxonomyRow.subject_id,
      JSON.stringify(sanitizedAttributes),
      JSON.stringify(attributeProvenance),
      eventSubjectId
    ]
  );

  await query(
    `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
     VALUES ($1, 'subject_identification', $2, $3, $4, $5)`,
    [
      existing.event_id,
      `${existing.old_family}/${existing.old_code}`,
      `${family}/${code}`,
      verifierId,
      note || null
    ]
  );

  return { eventSubjectId: inserted[0].event_subject_id, eventId: existing.event_id };
}
