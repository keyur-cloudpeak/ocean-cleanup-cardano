// One-off: runs corroboration detection over every existing
// environmental_event in submission order, so events that predate this
// feature get linked/nudged the same way a live submission now is.
// Idempotent — event_relationships has a unique constraint on
// (from_event_id, to_event_id, relationship_type), and state bumps are
// no-ops once a pair has already been linked, so re-running is safe.
//
// Usage: node scripts/detectCorroborationBackfill.js

import { query } from '../src/config/connection.js';
import { detectAndLinkCorroboration } from '../src/services/environmentalEventService.js';

async function main() {
  const { rows } = await query(
    `SELECT event_id FROM environmental_events ORDER BY created_at ASC`
  );

  console.log(`Running corroboration detection over ${rows.length} events...`);

  let linked = 0;
  for (const row of rows) {
    const result = await detectAndLinkCorroboration(row.event_id);
    if (result.matchCount > 0) {
      linked += 1;
      console.log(`  ${row.event_id}: corroborated by ${result.matchCount} event(s) — ${result.matchedEventIds.join(', ')}`);
    }
  }

  console.log(`Done. ${linked} of ${rows.length} events had a corroboration match.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Corroboration backfill failed:', err);
  process.exit(1);
});
