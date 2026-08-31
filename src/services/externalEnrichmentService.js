import { query } from '../config/connection.js';

/**
 * logExternalEnrichment — the EXTERNAL_ENRICHMENT audit trail (spec §26):
 * what an external lookup actually returned, independent of whether it
 * resolved anything useful. Mirrors aiInferenceService.logAiInference's
 * contract exactly — best-effort, never throws, so a logging failure can
 * never break the enrichment (or the event/activity creation) it's
 * describing. Called by every external-data lookup in the codebase
 * (locationEnrichmentService's reverse geocode, weatherService's archive
 * lookup) rather than each one writing its own ad-hoc row, so there's one
 * consistent shape to query across enrichment sources.
 */
export async function logExternalEnrichment({ eventId, activityId, sourceSystem, input, result }) {
  try {
    await query(
      `INSERT INTO external_enrichments (event_id, activity_id, source_system, input, result)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId || null, activityId || null, sourceSystem, JSON.stringify(input || {}), JSON.stringify(result || {})]
    );
  } catch (err) {
    console.error('[externalEnrichmentService] failed to log enrichment:', err.message);
  }
}

export default { logExternalEnrichment };
