// One-off: populates realistic demo data across every intake path and
// event-lifecycle state this project now supports, so the contributor
// dashboard, event detail pages, and maps have something real to show
// instead of being empty or sparse. Runs everything through the actual
// service functions (createActivity, createEventForActivity,
// runIntakePipeline, planActionForEvent, completeAction, reviewActivity)
// rather than raw inserts, so this data is structurally identical to a
// real submission — same validation, same corroboration detection, same
// event-model wiring.
//
// Demo accounts use a @bluemind.demo email domain so they're easy to
// find and remove later; nothing here touches real users' data.
// Blockchain recording and reward minting are deliberately NOT triggered
// (those live in activityController, not the service layer this script
// calls directly) — this is presentation data, not a real audit trail.
//
// Usage: node scripts/seedDemoData.js

import bcrypt from 'bcryptjs';
import { query } from '../src/config/connection.js';
import { createUser, findUserByEmail } from '../src/services/userService.js';
import { createOrganization, listOrganizations } from '../src/services/organizationService.js';
import { createActivity, reviewActivity } from '../src/services/activityService.js';
import {
  createEventForActivity, recordReviewOnEvent, planActionForEvent, completeAction
} from '../src/services/environmentalEventService.js';
import { runIntakePipeline } from '../src/services/verifierService.js';

// Verified-reachable Unsplash images (checked via HEAD request before use —
// a broken <img> would defeat the point of seeding presentable data).
const IMG = {
  plasticBeach: 'https://images.unsplash.com/photo-1621451537084-482c73073a0f?w=900',
  oceanPlastic: 'https://images.unsplash.com/photo-1618477388954-7852f32655ec?w=900',
  seaTurtle: 'https://images.unsplash.com/photo-1591025207163-942350e47db2?w=900',
  coralReef: 'https://images.unsplash.com/photo-1546026423-cc4642628d2b?w=900',
  cleanupCrew: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=900',
  mangrove: 'https://images.unsplash.com/photo-1567337710282-00832b415979?w=900',
  fishingNet: 'https://images.unsplash.com/photo-1559827260-dc66d52bef19?w=900',
  wildlifeRescue: 'https://images.unsplash.com/photo-1526336179256-1347bdb255ee?w=900'
};

async function ensureUser({ email, firstName, lastName, role, username, organizationId, jobTitle }) {
  const existing = await findUserByEmail(email);
  if (existing) return existing;
  const passwordHash = await bcrypt.hash('BlueMindDemo!2026', 10);
  const user = await createUser({
    firstName, lastName, email, username, password: passwordHash, role,
    emailVerifiedAt: new Date(), organizationId, jobTitle
  });
  console.log(`  created ${role} ${firstName} ${lastName} (${email})`);
  return user;
}

async function ensureOrganization(name, region, country) {
  const existing = (await listOrganizations()).find((o) => o.name === name);
  if (existing) return existing;
  const org = await createOrganization({ name, region, country, contactEmail: 'hello@coastalguardians.demo' });
  console.log(`  created organization ${name}`);
  return org;
}

/**
 * submit — mirrors what activityController.create does (minus IPFS
 * upload and blockchain/reward side effects): create the legacy
 * activity, link it into the event model, tag AI/measurement subjects,
 * run the intake pipeline (sanity checks + real corroboration
 * detection). occurredAt lets the seed spread submissions over the last
 * couple of weeks instead of everything landing "now".
 */
async function submit({ contributor, organizationId, occurredAt, aiSubjects, rawText, intakeMethod, captureSource, evidenceType, imageUrl, ...fields }) {
  const activity = await createActivity({
    ...fields,
    contributorId: contributor.id,
    organizationId: organizationId || null,
    imageCids: imageUrl ? [null] : [],
    imageIpfsUrls: imageUrl ? [null] : [],
    imageGatewayUrls: imageUrl ? [imageUrl] : [],
    timestamp: occurredAt.toISOString()
  });

  const eventId = await createEventForActivity(activity, {
    aiSubjects, rawText, intakeMethod, captureSource,
    evidenceType: evidenceType || (imageUrl ? 'photo' : undefined)
  });

  if (eventId) await runIntakePipeline(eventId);
  return { activity, eventId };
}

async function review(activity, status, note, verifier) {
  const reviewed = await reviewActivity(activity.id, status, note, verifier.id);
  await recordReviewOnEvent(reviewed, verifier.id);
  return reviewed;
}

function daysAgo(n, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

async function main() {
  console.log('Seeding demo accounts...');
  const org = await ensureOrganization('Coastal Guardians Collective', 'Gujarat', 'India');

  const priya = await ensureUser({
    email: 'priya.sharma@bluemind.demo', firstName: 'Priya', lastName: 'Sharma',
    role: 'contributor', username: 'priya.sharma', organizationId: org.orgId, jobTitle: 'Marine Biologist'
  });
  const rahul = await ensureUser({
    email: 'rahul.mehta@bluemind.demo', firstName: 'Rahul', lastName: 'Mehta',
    role: 'contributor', username: 'rahul.mehta', organizationId: org.orgId, jobTitle: 'Cleanup Crew Lead'
  });
  const ananya = await ensureUser({
    email: 'ananya.iyer@bluemind.demo', firstName: 'Ananya', lastName: 'Iyer', role: 'citizen', username: 'ananya.iyer'
  });
  const vikram = await ensureUser({
    email: 'vikram.nair@bluemind.demo', firstName: 'Vikram', lastName: 'Nair', role: 'citizen', username: 'vikram.nair'
  });
  const kavita = await ensureUser({
    email: 'kavita.rao@bluemind.demo', firstName: 'Kavita', lastName: 'Rao', role: 'verifier', username: 'kavita.rao', jobTitle: 'Field Verifier'
  });

  console.log('Seeding events...');

  // ── 1-3. Ghost net cluster at Mandvi Beach — three independent reports
  // close enough in space/time that the real corroboration detector links
  // them, matching spec §27's canonical example almost exactly. ──
  const netReport1 = await submit({
    contributor: ananya, occurredAt: daysAgo(9),
    category: 'other', location: 'Mandvi Beach, Kutch, Gujarat', quantity: 40, volunteers: 1,
    lat: 22.8300, lon: 69.3500,
    notes: 'Found a large abandoned fishing net tangled around a sea turtle near the reef edge.',
    imageUrl: IMG.fishingNet, intakeMethod: 'photo_video', captureSource: 'camera',
    aiSubjects: [
      { family: 'pollution_waste', code: 'fishing_gear', confidence: 0.92 },
      { family: 'life', code: 'sea_turtle', confidence: 0.85 },
      { family: 'habitat', code: 'coral_reef', confidence: 0.7 }
    ]
  });

  const netReport2 = await submit({
    contributor: vikram, occurredAt: daysAgo(8, 15),
    category: 'other', location: 'Mandvi Beach (north end), Kutch, Gujarat', quantity: 0, volunteers: 1,
    lat: 22.8305, lon: 69.3498,
    notes: 'Same net still there, turtle looked exhausted but alive.',
    imageUrl: IMG.seaTurtle, intakeMethod: 'photo_video', captureSource: 'gallery',
    aiSubjects: [
      { family: 'pollution_waste', code: 'fishing_gear', confidence: 0.88 },
      { family: 'life', code: 'sea_turtle', confidence: 0.9 }
    ]
  });

  const netReport3 = await submit({
    contributor: rahul, organizationId: org.orgId, occurredAt: daysAgo(8, 18),
    category: 'other', location: 'Mandvi Beach, Kutch, Gujarat', quantity: 0, volunteers: 2,
    lat: 22.8298, lon: 69.3503,
    notes: 'Confirmed on site — ghost net roughly 6m across, one turtle entangled.',
    rawText: 'Confirmed on site — ghost net roughly 6m across, one turtle entangled, we will organize a removal crew this week.',
    intakeMethod: 'tell_blue_mind',
    aiSubjects: [
      { family: 'pollution_waste', code: 'fishing_gear', confidence: 0.95 },
      { family: 'life', code: 'sea_turtle', confidence: 0.8 },
      { family: 'human_action', code: 'wildlife_rescue', confidence: 0.6 }
    ]
  });

  // Org plans and completes the response to the first report — spec §27's
  // "Plan Action" → "Completed" → original event "Addressed" chain, and
  // the flagship Impact Story on the dashboard.
  const actionEventId = await planActionForEvent(netReport1.eventId, {
    actorId: rahul.id, subjectCode: 'cleanup_removal',
    title: 'Cleanup crew dispatched to Mandvi net site',
    description: 'Sending a two-person crew with cutting tools to free the turtle and remove the net.'
  });
  await completeAction(actionEventId, {
    actorId: rahul.id, kgRemoved: 38,
    note: 'Net fully removed and disposed of at the Mandvi recycling depot. Turtle was freed, examined, and released back to sea in good health.'
  });
  console.log('  ghost net cluster seeded (3 corroborating reports, 1 completed action)');

  // ── 4. Straightforward approved cleanup, verified — plastic on the
  // beach, evidence photo, goes through a real review. ──
  const plasticCleanup = await submit({
    contributor: rahul, organizationId: org.orgId, occurredAt: daysAgo(6),
    category: 'plastic', location: 'Diu Coastal Point, Diu', quantity: 65, volunteers: 8,
    lat: 20.7100, lon: 70.9800,
    notes: 'Weekend community cleanup — mostly bottles and packaging washed up after the tide.',
    imageUrl: IMG.cleanupCrew, intakeMethod: 'photo_video', captureSource: 'camera',
    aiSubjects: [{ family: 'pollution_waste', code: 'plastic', confidence: 0.9 }]
  });
  await review(plasticCleanup.activity, 'approved', 'Verified on site, weight confirmed.', kavita);

  // ── 5. Voice-derived report of an oil slick, left open ("Needs
  // Attention" — event_state values the automated pipeline doesn't reach
  // on its own, set directly here since that's a legitimate demo of
  // states a verifier would set by hand, not a bug). ──
  const oilSlick = await submit({
    contributor: ananya, occurredAt: daysAgo(4),
    category: 'other', location: 'Marine Drive, Mumbai', quantity: 0, volunteers: 1,
    lat: 18.9440, lon: 72.8230,
    notes: 'Noticed a rainbow-sheen slick near the promenade, smells strongly of fuel.',
    rawText: 'There is an oil slick near Marine Drive, it smells strongly of fuel and covers maybe fifty meters of shoreline.',
    intakeMethod: 'tell_blue_mind',
    aiSubjects: [{ family: 'pollution_waste', code: 'oil_petroleum', confidence: 0.87 }]
  });
  if (oilSlick.eventId) {
    await query(
      `INSERT INTO event_state_history (event_id, field, old_value, new_value, changed_by, note)
       VALUES ($1, 'event_state', 'observed', 'needs_attention', $2, 'Escalated — active fuel smell reported near a public promenade.')`,
      [oilSlick.eventId, kavita.id]
    );
    await query(
      `UPDATE environmental_events SET event_state = 'needs_attention', updated_at = NOW() WHERE event_id = $1`,
      [oilSlick.eventId]
    );
  }

  // ── 6. Video report of a restoration action in progress. ──
  const mangroveRestoration = await submit({
    contributor: priya, organizationId: org.orgId, occurredAt: daysAgo(3),
    category: 'other', location: 'Diu Mangrove Belt, Diu', quantity: 0, volunteers: 12,
    lat: 20.7135, lon: 70.9765,
    notes: 'Planting mangrove saplings along the eroded section of the belt.',
    rawText: 'Volunteers planting mangrove saplings along the eroded section to help stabilize the shoreline.',
    imageUrl: IMG.mangrove, intakeMethod: 'photo_video', evidenceType: 'video', captureSource: 'camera',
    aiSubjects: [{ family: 'human_action', code: 'restoration', confidence: 0.85 }]
  });
  if (mangroveRestoration.eventId) {
    await query(
      `UPDATE environmental_events SET event_state = 'action_underway', updated_at = NOW() WHERE event_id = $1`,
      [mangroveRestoration.eventId]
    );
  }

  // ── 7-8. Water measurements — one instrument reading, one informal
  // observation, demonstrating the provenance distinction spec §7.2 asks
  // for. ──
  await submit({
    contributor: priya, organizationId: org.orgId, occurredAt: daysAgo(5),
    category: 'other', location: 'Mandvi Beach (offshore buoy), Kutch, Gujarat', quantity: 0, volunteers: 1,
    lat: 22.8312, lon: 69.3486,
    notes: 'Routine monthly water quality check.',
    instrument: 'YSI EXO2 Sonde',
    intakeMethod: 'measurement',
    aiSubjects: [
      { family: 'water', code: 'temperature', source: 'system_captured', attributes: { value: 28.4, unit: '°C' } },
      { family: 'water', code: 'ph', source: 'system_captured', attributes: { value: 8.12, unit: '' } },
      { family: 'water', code: 'dissolved_oxygen', source: 'system_captured', attributes: { value: 6.1, unit: 'mg/L' } }
    ]
  });

  await submit({
    contributor: ananya, occurredAt: daysAgo(2),
    category: 'other', location: 'Diu Coastal Point, Diu', quantity: 0, volunteers: 1,
    lat: 20.7088, lon: 70.9812,
    notes: 'Water looked unusually cloudy after the storm, no instrument on hand.',
    intakeMethod: 'measurement',
    aiSubjects: [{ family: 'water', code: 'turbidity_clarity', source: 'user_provided', attributes: { value: 14, unit: 'NTU (estimated)' } }]
  });

  // ── 9. Document/dataset upload — a coral survey CSV. ──
  const surveyCsv = 'date,location,observation\n' +
    '2026-08-10,Mandvi Reef Section B,Coral bleaching observed across roughly 30% of the surveyed section\n' +
    '2026-08-10,Mandvi Reef Section B,Water temperature 29.6C, above seasonal average';
  await submit({
    contributor: priya, organizationId: org.orgId, occurredAt: daysAgo(7),
    category: 'other', location: 'Mandvi Reef Section B, Kutch, Gujarat', quantity: 0, volunteers: 1,
    lat: 22.8320, lon: 69.3475,
    notes: 'Uploaded from the monthly reef survey dataset.',
    imageUrl: IMG.coralReef, intakeMethod: 'upload', evidenceType: 'dataset', captureSource: 'upload',
    rawText: surveyCsv,
    aiSubjects: [{ family: 'life', code: 'coral', confidence: 0.88 }]
  });

  // ── 10. Rejected/disputed report — the negative path. ──
  const disputedReport = await submit({
    contributor: vikram, occurredAt: daysAgo(1),
    category: 'other', location: 'Marine Drive, Mumbai', quantity: 5, volunteers: 1,
    lat: 18.9450, lon: 72.8210,
    notes: 'Reported plastic pile that turned out to be a construction tarp.',
    imageUrl: IMG.oceanPlastic, intakeMethod: 'photo_video', captureSource: 'gallery',
    aiSubjects: [{ family: 'pollution_waste', code: 'plastic', confidence: 0.55 }]
  });
  await review(disputedReport.activity, 'rejected', "That's a construction tarp, not marine debris — please double-check before submitting.", kavita);

  // ── 11. Fresh, unreviewed submission — keeps "Needs Attention" from
  // being only resolved/escalated items. ──
  await submit({
    contributor: ananya, occurredAt: daysAgo(0, 8),
    category: 'plastic', location: 'Chorwad Beach, Gujarat', quantity: 18, volunteers: 1,
    lat: 21.1400, lon: 70.0200,
    notes: 'Bottles and wrappers scattered along the tideline this morning.',
    imageUrl: IMG.plasticBeach, intakeMethod: 'photo_video', captureSource: 'camera',
    aiSubjects: [{ family: 'pollution_waste', code: 'plastic', confidence: 0.82 }]
  });

  console.log('Done seeding demo data.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
