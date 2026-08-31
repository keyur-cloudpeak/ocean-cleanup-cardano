// One-off backfill: creates a contributions + environmental_events (+
// event_subjects, evidence, event_impact) row for every existing activity
// that doesn't have one yet. Safe to re-run — only touches activities
// where environmental_event_id is still null.
//
// `category` is mapped to the closest seeded subject in the
// pollution_waste family (see CATEGORY_TO_SUBJECT_CODE below); anything
// that doesn't match falls back to 'mixed_waste' rather than blocking the
// run — categories were free text before this migration, so an exact
// mapping isn't guaranteed to exist.
//
// Usage: node scripts/backfillEnvironmentalEvents.js

import { query } from '../src/config/connection.js';
import {
  CATEGORY_TO_SUBJECT_CODE,
  EVENT_STATE_BY_STATUS,
  VERIFICATION_STATE_BY_STATUS
} from '../src/services/environmentalEventService.js';

function imageArrays(row) {
  const cids = row.image_cid || [];
  const ipfsUrls = row.image_ipfs_url || [];
  const gatewayUrls = row.image_gateway_url || [];
  const count = Math.max(cids.length, ipfsUrls.length, gatewayUrls.length);
  return Array.from({ length: count }, (_, i) => ({
    cid: cids[i] || null,
    storageUrl: ipfsUrls[i] || null,
    gatewayUrl: gatewayUrls[i] || null
  }));
}

async function backfillOne(row) {
  const subjectCode = CATEGORY_TO_SUBJECT_CODE[row.category] || 'mixed_waste';
  const { rows: subjectRows } = await query(
    `SELECT subject_id FROM subjects WHERE family = 'pollution_waste' AND code = $1`,
    [subjectCode]
  );
  if (subjectRows.length === 0) {
    console.log(`  ${row.id}: no subject seeded for category "${row.category}", skipping`);
    return false;
  }

  // activities.contributor_id was never FK-constrained, so legacy rows can
  // reference a user that no longer exists. contributions.contributor_id
  // is FK-constrained (correctly, for new data) — fall back to null rather
  // than fail the whole backfill on old orphaned references.
  let contributorId = row.contributor_id;
  if (contributorId) {
    const { rows: userRows } = await query(`SELECT id FROM users WHERE id = $1`, [contributorId]);
    if (userRows.length === 0) {
      console.log(`  ${row.id}: contributor_id "${contributorId}" no longer exists, recording contribution without it`);
      contributorId = null;
    }
  }

  const contribution = await query(
    `INSERT INTO contributions (contributor_id, organization_id, intake_method, submitted_at)
     VALUES ($1, NULL, 'upload', $2)
     RETURNING contribution_id`,
    [contributorId, row.submitted_at]
  );
  const contributionId = contribution.rows[0].contribution_id;

  const event = await query(
    `INSERT INTO environmental_events
       (contribution_id, legacy_activity_id, event_state, verification_state,
        occurred_at, lat, lon, location_label, location_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'user_provided')
     RETURNING event_id`,
    [
      contributionId,
      row.id,
      EVENT_STATE_BY_STATUS[row.status] || 'observed',
      VERIFICATION_STATE_BY_STATUS[row.status] || 'unverified',
      row.submitted_at,
      row.lat,
      row.lon,
      row.location
    ]
  );
  const eventId = event.rows[0].event_id;

  await query(
    `INSERT INTO event_subjects (event_id, subject_id, attributes, source)
     VALUES ($1, $2, $3, 'user_provided')`,
    [eventId, subjectRows[0].subject_id, JSON.stringify({ quantity_kg: Number(row.quantity) || 0 })]
  );

  // Set explicitly rather than relying on the column default (spec §17).
  // These are real contributor uploads being migrated from the legacy
  // activities table, so user_provided is accurate — but it says so now
  // instead of merely happening to inherit it.
  for (const image of imageArrays(row)) {
    await query(
      `INSERT INTO evidence
         (event_id, contribution_id, evidence_type, storage_url, gateway_url, cid, capture_source, source)
       VALUES ($1, $2, 'photo', $3, $4, $5, 'unknown', 'user_provided')`,
      [eventId, contributionId, image.storageUrl, image.gatewayUrl, image.cid]
    );
  }

  if (Number(row.quantity) > 0) {
    await query(
      `INSERT INTO event_impact (event_id, metric, value, unit)
       VALUES ($1, 'debris_removed_kg', $2, 'kg')`,
      [eventId, row.quantity]
    );
  }

  await query(`UPDATE activities SET environmental_event_id = $1 WHERE id = $2`, [eventId, row.id]);
  return true;
}

async function main() {
  const { rows } = await query(
    `SELECT id, category, location, quantity, contributor_id, submitted_at, status,
            lat, lon, image_cid, image_ipfs_url, image_gateway_url
     FROM activities
     WHERE environmental_event_id IS NULL
     ORDER BY submitted_at ASC`
  );

  console.log(`Backfilling ${rows.length} activit${rows.length === 1 ? 'y' : 'ies'} into the event model...`);

  let migrated = 0;
  for (const row of rows) {
    if (await backfillOne(row)) {
      migrated += 1;
      console.log(`  ${row.id}: done`);
    }
  }

  console.log(`Done. Migrated ${migrated} of ${rows.length} activities.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
