import { query } from '../config/connection.js';
import { detectAndLinkCorroboration } from './environmentalEventService.js';
import { computeConfidenceSignals } from './confidenceSignalService.js';

/**
 * runIntakePipeline — the automated triage step between "an event was
 * created" and "a human verifier looks at it" (spec §20): cheap
 * completeness checks, duplicate/corroboration detection, and the
 * confidence signals behind the event's level (spec §14). Never blocks or
 * rejects anything on its own — it only enriches the event
 * (relationships + state + signals) and reports what it found, so a
 * verifier sees corroboration already surfaced instead of having to spot
 * it manually.
 */
export async function runIntakePipeline(eventId) {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*) FROM evidence WHERE event_id = $1)::int AS evidence_count,
       (SELECT COUNT(*) FROM event_subjects WHERE event_id = $1)::int AS subject_count,
       (lat IS NOT NULL AND lon IS NOT NULL) AS has_location
     FROM environmental_events
     WHERE event_id = $1`,
    [eventId]
  );
  const row = rows[0] || {};

  const sanityFlags = [];
  if (!row.has_location) sanityFlags.push('missing_location');
  if (Number(row.evidence_count) === 0) sanityFlags.push('no_evidence');
  if (Number(row.subject_count) === 0) sanityFlags.push('no_subject');

  const corroboration = await detectAndLinkCorroboration(eventId);
  // Computed after corroboration detection, so the corroboration signal
  // reflects the links this same pipeline run just created rather than
  // lagging a run behind.
  const confidenceSignals = await computeConfidenceSignals(eventId);

  return { eventId, sanityFlags, corroboration, confidenceSignals };
}

export default { runIntakePipeline };
