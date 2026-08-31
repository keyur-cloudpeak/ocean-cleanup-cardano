import { query } from '../config/connection.js';

/**
 * Confidence signals (spec §14).
 *
 * The spec lists a dozen things confidence "can eventually consider", and
 * is equally explicit that we must NOT "make a fake scientifically precise
 * score immediately" — V1 exposes the coarse levels
 * (unverified/supported/corroborated/verified) "while retaining more
 * detailed internal signals". This service is that retained detail.
 *
 * Deliberately no weights, no composite number, no ranking. Each signal
 * records only which way it leans — supports / weakens / neutral — plus a
 * plain-language reason. A verifier reads the reasons and judges; the
 * system never pretends to have computed a trust percentage it can't
 * actually justify.
 *
 * 'neutral' is a real, meaningful outcome and not a filler value: an
 * uncorroborated report is not a suspicious one, and a citizen submitting
 * without an organization is not a weaker contributor (spec §15 —
 * "the system must never imply that citizen evidence is worthless").
 * Signals whose input is simply absent are omitted entirely rather than
 * recorded as a weakness.
 */

// A report filed within a day of the event reads as contemporaneous; one
// filed more than a week later isn't wrong, but the timestamp is doing
// less work as evidence, which is what "timestamp integrity" means here.
const CONTEMPORANEOUS_HOURS = 24;
const STALE_REPORT_DAYS = 7;

// Don't judge reliability off a handful of submissions — a contributor
// with two reviewed reports has no track record worth reading into.
const MIN_HISTORY_FOR_RELIABILITY = 3;
const RELIABLE_APPROVAL_RATIO = 0.8;
const UNRELIABLE_APPROVAL_RATIO = 0.5;

const CONFIDENT_AI = 0.7;
const UNSURE_AI = 0.4;

/**
 * computeConfidenceSignals — evaluates every signal the available data can
 * actually support for one event, and upserts them. Best-effort by
 * contract: a failure here must never break intake or verification, since
 * these signals are explanatory, not authoritative.
 */
export async function computeConfidenceSignals(eventId) {
  try {
    const { rows } = await query(
      `SELECT
         e.event_id, e.occurred_at, e.location_capture_method, e.location_accuracy_m,
         c.submitted_at, c.contributor_id, c.organization_id,
         u.email_verified_at,
         (SELECT COUNT(*) FROM evidence ev WHERE ev.event_id = e.event_id)::int AS evidence_count,
         (SELECT COUNT(*) FROM evidence ev WHERE ev.event_id = e.event_id AND ev.capture_source = 'camera')::int AS camera_count,
         (SELECT MAX(es.confidence) FROM event_subjects es WHERE es.event_id = e.event_id) AS max_ai_confidence,
         (SELECT COUNT(*) FROM measurements m WHERE m.event_id = e.event_id)::int AS measurement_count,
         (SELECT COUNT(*) FROM measurements m WHERE m.event_id = e.event_id AND m.method = 'instrument')::int AS instrument_count,
         (SELECT COUNT(*) FROM verifications v WHERE v.event_id = e.event_id AND v.outcome = 'verified')::int AS verified_count,
         (SELECT COUNT(*) FROM verifications v WHERE v.event_id = e.event_id AND v.outcome IN ('disputed', 'unable_to_verify'))::int AS adverse_verification_count,
         (SELECT COUNT(DISTINCT other_id) FROM (
            SELECT to_event_id AS other_id FROM event_relationships
            WHERE from_event_id = e.event_id AND relationship_type = 'corroborates'
            UNION
            SELECT from_event_id AS other_id FROM event_relationships
            WHERE to_event_id = e.event_id AND relationship_type = 'corroborates'
          ) AS corr)::int AS corroboration_count,
         (SELECT COUNT(*) FROM event_relationships r
           WHERE (r.from_event_id = e.event_id OR r.to_event_id = e.event_id)
             AND r.relationship_type IN ('disputes', 'duplicate_of'))::int AS contradiction_count
       FROM environmental_events e
       LEFT JOIN contributions c ON c.contribution_id = e.contribution_id
       LEFT JOIN users u ON u.id = c.contributor_id
       WHERE e.event_id = $1`,
      [eventId]
    );

    const row = rows[0];
    if (!row) return [];

    const signals = [];
    const add = (signal, stance, detail) => signals.push({ signal, stance, detail });

    // — Where the location came from (spec §14: "GPS captured at source")
    if (row.location_capture_method === 'gps') {
      const accuracy = row.location_accuracy_m != null ? ` (±${Math.round(row.location_accuracy_m)}m)` : '';
      add('gps_at_source', 'supports', `Location came from the device's own GPS fix${accuracy}`);
    } else if (row.location_capture_method === 'manual_pin') {
      add('gps_at_source', 'weakens', 'Location was placed by hand on the map, not measured by the device');
    }

    // — How the photo got here (spec §14: "direct camera capture vs gallery upload")
    if (row.evidence_count > 0) {
      if (row.camera_count > 0) {
        add('direct_camera_capture', 'supports', `${row.camera_count} item(s) captured directly in-app rather than picked from a gallery`);
      } else {
        add('direct_camera_capture', 'weakens', 'All media was picked from a gallery, so it may not have been taken at this place or time');
      }
      add('supporting_media', 'supports', `${row.evidence_count} piece(s) of supporting evidence attached`);
    } else {
      add('supporting_media', 'weakens', 'No photo, video or document was attached');
    }

    // — Timestamp integrity: how long after the fact was this filed?
    if (row.occurred_at && row.submitted_at) {
      const hoursApart = Math.abs(new Date(row.submitted_at) - new Date(row.occurred_at)) / 36e5;
      if (hoursApart <= CONTEMPORANEOUS_HOURS) {
        add('timestamp_integrity', 'supports', 'Reported within a day of when it happened');
      } else if (hoursApart > STALE_REPORT_DAYS * 24) {
        add('timestamp_integrity', 'weakens', `Reported ${Math.round(hoursApart / 24)} days after the stated date`);
      } else {
        add('timestamp_integrity', 'neutral', `Reported ${Math.round(hoursApart / 24)} day(s) after the stated date`);
      }
    }

    // — Who filed it. A missing contributor is a real weakness; a citizen
    //   without an organization is not (spec §15).
    if (!row.contributor_id) {
      add('contributor_identity', 'weakens', 'Not attributed to a signed-in contributor');
    } else if (row.email_verified_at) {
      add('contributor_identity', 'supports', 'Filed by a contributor with a verified email address');
    } else {
      add('contributor_identity', 'neutral', 'Filed by a signed-in contributor whose email is not yet verified');
    }

    if (row.organization_id) {
      add('organization_identity', 'supports', 'Filed on behalf of a registered organization');
    }

    // — Independent corroboration. Zero is neutral, never a weakness.
    if (row.corroboration_count > 0) {
      add('independent_corroboration', 'supports', `${row.corroboration_count} independent nearby report(s) describe the same thing`);
    } else {
      add('independent_corroboration', 'neutral', 'No independent reports of the same thing yet');
    }

    // — How sure the classifier was about what this is
    const aiConfidence = row.max_ai_confidence != null ? Number(row.max_ai_confidence) : null;
    if (aiConfidence != null) {
      const pct = Math.round(aiConfidence * 100);
      if (aiConfidence >= CONFIDENT_AI) {
        add('ai_confidence', 'supports', `Blue Mind classified the main subject with ${pct}% confidence`);
      } else if (aiConfidence < UNSURE_AI) {
        add('ai_confidence', 'weakens', `Blue Mind was only ${pct}% confident about what this shows`);
      } else {
        add('ai_confidence', 'neutral', `Blue Mind was ${pct}% confident about what this shows`);
      }
    }

    // — Instrument quality, only meaningful where readings exist
    if (row.measurement_count > 0) {
      if (row.instrument_count > 0) {
        add('measurement_instrument', 'supports', `${row.instrument_count} of ${row.measurement_count} reading(s) taken with a named instrument`);
      } else {
        add('measurement_instrument', 'weakens', 'Readings were informal observations rather than instrument measurements');
      }
    }

    // — Has a human actually reviewed it
    if (row.verified_count > 0) {
      add('verifier_review', 'supports', 'Reviewed and verified by a verifier');
    } else if (row.adverse_verification_count > 0) {
      add('verifier_review', 'weakens', 'A verifier disputed this or could not verify it');
    }

    // — Track record, only once there's enough history to mean anything
    if (row.contributor_id) {
      const { rows: historyRows } = await query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('approved', 'rejected'))::int AS reviewed,
           COUNT(*) FILTER (WHERE status = 'approved')::int AS approved
         FROM activities
         WHERE contributor_id = $1 AND environmental_event_id IS DISTINCT FROM $2`,
        [row.contributor_id, eventId]
      );
      const { reviewed, approved } = historyRows[0] || { reviewed: 0, approved: 0 };
      if (reviewed >= MIN_HISTORY_FOR_RELIABILITY) {
        const ratio = approved / reviewed;
        const pct = Math.round(ratio * 100);
        if (ratio >= RELIABLE_APPROVAL_RATIO) {
          add('contributor_reliability', 'supports', `${pct}% of this contributor's ${reviewed} previous reports were approved`);
        } else if (ratio < UNRELIABLE_APPROVAL_RATIO) {
          add('contributor_reliability', 'weakens', `Only ${pct}% of this contributor's ${reviewed} previous reports were approved`);
        } else {
          add('contributor_reliability', 'neutral', `${pct}% of this contributor's ${reviewed} previous reports were approved`);
        }
      }
    }

    // — Anything actively arguing against this record
    if (row.contradiction_count > 0) {
      add('contradictory_evidence', 'weakens', `${row.contradiction_count} event(s) dispute this or mark it a duplicate`);
    }

    for (const { signal, stance, detail } of signals) {
      await query(
        `INSERT INTO confidence_signals (event_id, signal, stance, detail, computed_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (event_id, signal)
         DO UPDATE SET stance = EXCLUDED.stance, detail = EXCLUDED.detail, computed_at = NOW()`,
        [eventId, signal, stance, detail]
      );
    }

    return signals;
  } catch (err) {
    console.error('[confidenceSignalService] failed to compute signals for event', eventId, ':', err.message);
    return [];
  }
}

export default { computeConfidenceSignals };
