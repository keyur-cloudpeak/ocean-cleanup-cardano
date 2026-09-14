import { query } from '../config/connection.js';

// ─── Badge definitions ────────────────────────────────────────────────────────
// spec §14: badges/tiers must not encourage submitting more just to
// progress — 'verified_reports' (a verifier actually confirmed it), not
// raw 'total_reports' (anything submitted, confirmed or not), is what
// gates report-count-based badges and the tier ladder below.
//
// "Verified" is environmental_events.verification_state = 'verified' — the
// event model's own confidence axis, not the legacy activities.status =
// 'approved' this used to read, which is a different flag and one most
// citizen reports never get set at all.
const BADGE_DEFS = [
  { id: 'first_report', icon: '🥇', title: 'First Report', desc: 'Get your first report verified', threshold: 1, field: 'verified_reports' },
  { id: 'tide_guardian', icon: '🌊', title: 'Tide Guardian', desc: '3 verified reports', threshold: 3, field: 'verified_reports' },
  { id: 'spot_mapper', icon: '📍', title: 'Spot Mapper', desc: '5 unique locations', threshold: 5, field: 'unique_locations' },
  { id: 'reef_defender', icon: '🐚', title: 'Reef Defender', desc: '7 verified reports', threshold: 7, field: 'verified_reports' },
  { id: 'streak_30', icon: '🔥', title: '30-Day Streak', desc: 'Active 30 days in a row', threshold: 30, field: 'streak_days' },
  { id: 'top_100', icon: '🏆', title: 'Top 100', desc: 'Reach city rank #100 or better', threshold: 100, field: 'city_rank_inv' },
  { id: 'harbor_hero', icon: '⚓', title: 'Harbor Hero', desc: '100 kg logged', threshold: 100, field: 'total_kg' },
  { id: 'crew_leader', icon: '👥', title: 'Crew Leader', desc: '10+ volunteers mobilized', threshold: 10, field: 'total_volunteers' },
];

// Determine current tier based on *verified* report count, not raw
// submissions (spec §14).
function getTier(verifiedReportCount) {
  if (verifiedReportCount >= 7) return { label: '🐚 Reef Defender', next: null, nextAt: null };
  if (verifiedReportCount >= 3) return { label: '🌊 Tide Guardian', next: 'Reef Defender', nextAt: 7 };
  if (verifiedReportCount >= 1) return { label: '🥇 First Reporter', next: 'Tide Guardian', nextAt: 3 };
  return { label: '🌱 Newcomer', next: 'First Reporter', nextAt: 1 };
}

// Compute which badges are earned based on stats
function computeBadges(stats) {
  return BADGE_DEFS.map(def => {
    let progress = 0;
    switch (def.field) {
      case 'verified_reports': progress = stats.verifiedReports; break;
      case 'unique_locations': progress = stats.uniqueLocations; break;
      case 'streak_days': progress = stats.streakDays; break;
      case 'total_kg': progress = stats.totalKg; break;
      case 'total_volunteers': progress = stats.totalVolunteers; break;
      case 'city_rank_inv':
        // Invert rank: #1 = 100, #100 = 1; treat rank 0 (no rank) as 0
        progress = stats.cityRank > 0 ? Math.max(0, 101 - stats.cityRank) : 0;
        break;
      default: progress = 0;
    }
    const earned = progress >= def.threshold;
    return {
      ...def,
      earned,
      progress,
      progressLabel: `${Math.min(progress, def.threshold)}/${def.threshold}`,
    };
  });
}

// ─── Service functions ─────────────────────────────────────────────────────────

/**
 * Get per-citizen aggregate stats, tier, and badges.
 */
export async function getCitizenStats(citizenId) {
  // Every number here is the event model's (environmental_events +
  // contributions), the same source the Contributor Space counts from and
  // the same source this citizen's own Needs Attention / Your Areas cards
  // read. It used to count rows in the legacy `activities` table, which
  // disagreed with those cards: activities carry a separate approved/
  // pending/rejected flag that the event pipeline never sets, and their
  // raw `quantity` column is not what the event model records as removed.
  const statsResult = await query(
    `WITH my_events AS (
       SELECT e.event_id, e.event_state, e.verification_state, e.location_label,
              e.legacy_activity_id, c.submitted_at
       FROM environmental_events e
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.contributor_id = $1
     ),
     -- One kg figure per event. The event model records the weight in two
     -- places: event_impact (written when an action is formally completed)
     -- and event_subjects.attributes.quantity_kg (written at intake). They
     -- are NOT additive — where both exist they hold the same weight, so
     -- adding them reports twice the waste that was actually logged. Take
     -- the larger instead: it survives an event that has only one of them,
     -- and prefers the completed-action figure when that is the bigger
     -- (later, measured) number.
     --
     -- Only the first quantity_kg subject row is read, never a SUM over
     -- them: intake stamps the same weight onto every subject of an event,
     -- so summing would multiply it by the subject count.
     per_event_kg AS (
       SELECT GREATEST(
         COALESCE((SELECT SUM(ei.value) FROM event_impact ei
                   WHERE ei.event_id = m.event_id AND ei.metric = 'debris_removed_kg'), 0),
         COALESCE((SELECT (es.attributes->>'quantity_kg')::numeric FROM event_subjects es
                   WHERE es.event_id = m.event_id AND es.attributes ? 'quantity_kg'
                   ORDER BY es.created_at ASC LIMIT 1), 0)
       ) AS kg
       FROM my_events m
     )
     SELECT
       (SELECT COUNT(*) FROM my_events)::int AS total_reports,
       (SELECT COUNT(*) FROM my_events WHERE verification_state = 'verified')::int AS verified_reports,
       (SELECT COUNT(*) FROM my_events
         WHERE event_state IN ('disputed', 'unable_to_verify'))::int AS disputed_reports,
       (SELECT COUNT(*) FROM my_events
         WHERE verification_state <> 'verified'
           AND event_state NOT IN ('disputed', 'unable_to_verify'))::int AS open_reports,
       -- An event with no label counts as its own place rather than
       -- collapsing every unlabelled report into one "location".
       (SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(location_label), ''), event_id::text))
          FROM my_events)::int AS unique_locations,
       (SELECT COUNT(*) FROM my_events
         WHERE submitted_at >= date_trunc('week', NOW()))::int AS week_reports,
       (SELECT MIN(submitted_at) FROM my_events) AS member_since,
       (SELECT COALESCE(SUM(kg), 0) FROM per_event_kg) AS total_kg,
       -- volunteers is the one figure with no event-model column at all
       -- (db/schema.sql: it exists only on activities), so it is read
       -- through the event's own legacy link rather than dropped — which
       -- still means only events that came from an activity can carry it.
       (SELECT COALESCE(SUM(a.volunteers), 0)::int
          FROM my_events m JOIN activities a ON a.id = m.legacy_activity_id) AS total_volunteers`,
    [citizenId]
  );

  // City rank among citizens only — trust-weighted points (spec §14), not
  // raw reported kg, so this doesn't reward volume over meaningful,
  // confirmed contributions. Same reward_ledger-based ranking as
  // activityService.getContributorStats.
  const rankResult = await query(
    `SELECT rank FROM (
       SELECT r.user_id,
              RANK() OVER (ORDER BY COALESCE(SUM(r.amount), 0) DESC) AS rank
       FROM reward_ledger r
       JOIN users u ON u.id = r.user_id
       WHERE u.role = 'citizen'
       GROUP BY r.user_id
     ) ranked
     WHERE user_id = $1`,
    [citizenId]
  );

  // Streak days (consecutive days with at least one contribution up to
  // today), counted off contributions.submitted_at — the event model's own
  // intake timestamp.
  const streakResult = await query(
    `WITH daily AS (
       SELECT DISTINCT DATE(submitted_at AT TIME ZONE 'UTC') AS day
       FROM contributions
       WHERE contributor_id = $1
       ORDER BY day DESC
     ),
     numbered AS (
       SELECT day,
              ROW_NUMBER() OVER (ORDER BY day DESC) AS rn
       FROM daily
     ),
     streak AS (
       SELECT day, rn,
              day + CAST(rn - 1 AS INT) * INTERVAL '1 day' AS grp
       FROM numbered
       WHERE day >= CURRENT_DATE - CAST(rn - 1 AS INT)
     )
     SELECT COUNT(*) AS streak_days FROM streak WHERE grp = CURRENT_DATE`,
    [citizenId]
  );

  const row = statsResult.rows[0] || {};
  const cityRank = Number(rankResult.rows[0]?.rank) || 0;
  const streakDays = Number(streakResult.rows[0]?.streak_days) || 0;

  const stats = {
    totalReports: Number(row.total_reports) || 0,
    uniqueLocations: Number(row.unique_locations) || 0,
    totalKg: Number(row.total_kg) || 0,
    totalVolunteers: Number(row.total_volunteers) || 0,
    // Event-model vocabulary (spec §11/§12) rather than the legacy
    // approved/pending/rejected, which couldn't express an event that is
    // both addressed and unverified.
    verifiedReports: Number(row.verified_reports) || 0,
    openReports: Number(row.open_reports) || 0,
    disputedReports: Number(row.disputed_reports) || 0,
    weekReports: Number(row.week_reports) || 0,
    cityRank,
    streakDays,
    memberSince: row.member_since ? new Date(row.member_since).toISOString() : null,
  };

  const tier = getTier(stats.verifiedReports);
  const badges = computeBadges(stats);
  const earnedBadges = badges.filter(b => b.earned).length;

  // Progress to next badge tier
  let progressPct = 0;
  let progressLabel = '';
  if (tier.next && tier.nextAt) {
    const prevAt = tier.nextAt === 3 ? 1 : tier.nextAt === 7 ? 3 : 0;
    progressPct = Math.min(100, Math.round(((stats.verifiedReports - prevAt) / (tier.nextAt - prevAt)) * 100));
    progressLabel = `${stats.verifiedReports} of ${tier.nextAt}`;
  }

  return {
    ...stats,
    tier,
    badges,
    earnedBadges,
    progressPct,
    progressLabel,
  };
}

/**
 * Get the weekly leaderboard — ALL citizens ranked by trust-weighted points
 * earned this week (spec §14: corroboration/verification bonuses, not raw
 * report volume), so submitting more without it being confirmed doesn't
 * move you up. Citizens with zero points this week are included at the
 * bottom (0 reports, 0 points).
 */
export async function getCitizenLeaderboard(citizenId) {
  const result = await query(
    `WITH week_events AS (
       SELECT c.contributor_id, e.event_id
       FROM environmental_events e
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.submitted_at >= date_trunc('week', NOW())
     ),
     week_kg AS (
       -- GREATEST, not a sum of the two sources — see per_event_kg in
       -- getCitizenStats for why adding them double-counts.
       SELECT we.contributor_id, SUM(GREATEST(
         COALESCE((SELECT SUM(ei.value) FROM event_impact ei
                   WHERE ei.event_id = we.event_id AND ei.metric = 'debris_removed_kg'), 0),
         COALESCE((SELECT (es.attributes->>'quantity_kg')::numeric FROM event_subjects es
                   WHERE es.event_id = we.event_id AND es.attributes ? 'quantity_kg'
                   ORDER BY es.created_at ASC LIMIT 1), 0)
       )) AS kg
       FROM week_events we
       GROUP BY we.contributor_id
     )
     SELECT
       u.id                                                             AS citizen_id,
       u.first_name,
       u.last_name,
       u.username,
       COUNT(we.event_id)::int                                          AS week_reports,
       COALESCE(MAX(wk.kg), 0)                                          AS week_kg,
       COALESCE(r.week_points, 0)::int                                  AS week_points,
       RANK() OVER (ORDER BY COALESCE(r.week_points, 0) DESC, COUNT(we.event_id) DESC)::int AS rank
     FROM users u
     LEFT JOIN week_events we ON we.contributor_id = u.id
     LEFT JOIN week_kg wk ON wk.contributor_id = u.id
     LEFT JOIN (
       SELECT user_id, SUM(amount) AS week_points
       FROM reward_ledger
       WHERE created_at >= date_trunc('week', NOW())
       GROUP BY user_id
     ) r ON r.user_id = u.id
     WHERE u.role = 'citizen'
       AND u.is_active = TRUE
     GROUP BY u.id, u.first_name, u.last_name, u.username, r.week_points
     ORDER BY rank, week_reports DESC`,
    []
  );

  const rows = result.rows.map(r => ({
    userId: r.citizen_id,
    firstName: r.first_name,
    lastName: r.last_name,
    username: r.username,
    initials: `${r.first_name?.[0] || ''}${r.last_name?.[0] || ''}`.toUpperCase(),
    weekReports: Number(r.week_reports) || 0,
    weekKg: Number(r.week_kg) || 0,
    weekPoints: Number(r.week_points) || 0,
    rank: Number(r.rank) || 0,
    isMe: r.citizen_id === citizenId,
  }));

  // All citizens are always in the list — no separate myRow needed
  return { leaderboard: rows, myRow: null };
}

/**
 * Get the recent community feed — citizens' reports as environmental
 * events (spec §22), the same records the rest of the Citizen Space
 * shows. Reads the event model rather than the legacy activities table so
 * a row's state here matches its state on the event it links to, and so
 * non-cleanup reports (wildlife, water quality) appear as what they are
 * instead of being described as a cleanup.
 */
export async function getCitizenFeed(limit = 5) {
  const result = await query(
    `SELECT
       e.event_id,
       e.location_label,
       e.event_state,
       e.verification_state,
       c.submitted_at,
       c.intake_method,
       a.volunteers,
       (SELECT COALESCE(json_agg(json_build_object('code', s.code, 'family', s.family, 'label', s.label)
                                 ORDER BY es.created_at), '[]'::json)
          FROM event_subjects es
          JOIN subjects s ON s.subject_id = es.subject_id
          WHERE es.event_id = e.event_id) AS subjects,
       GREATEST(
         COALESCE((SELECT SUM(ei.value) FROM event_impact ei
                   WHERE ei.event_id = e.event_id AND ei.metric = 'debris_removed_kg'), 0),
         COALESCE((SELECT (es2.attributes->>'quantity_kg')::numeric FROM event_subjects es2
                   WHERE es2.event_id = e.event_id AND es2.attributes ? 'quantity_kg'
                   ORDER BY es2.created_at ASC LIMIT 1), 0)
       ) AS quantity,
       u.first_name,
       u.last_name,
       u.username
     FROM environmental_events e
     JOIN contributions c ON c.contribution_id = e.contribution_id
     JOIN users u ON u.id = c.contributor_id
     LEFT JOIN activities a ON a.id = e.legacy_activity_id
     WHERE u.role = 'citizen'
     ORDER BY c.submitted_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(r => ({
    id: r.event_id,
    eventId: r.event_id,
    location: r.location_label,
    quantity: Number(r.quantity) || 0,
    // Only events that came from a legacy activity can carry this — the
    // event model has no volunteers column of its own.
    volunteers: Number(r.volunteers) || 0,
    subjects: r.subjects || [],
    eventState: r.event_state,
    verificationState: r.verification_state,
    intakeMethod: r.intake_method,
    submittedAt: r.submitted_at,
    firstName: r.first_name || 'Anonymous',
    lastName: r.last_name || '',
    username: r.username || 'anon',
    initials: r.first_name ? `${r.first_name[0]}${r.last_name?.[0] || ''}`.toUpperCase() : 'AN',
  }));
}

/**
 * Get all activities for a specific citizen.
 */
export async function getCitizenActivities(citizenId) {
  const result = await query(
    `SELECT a.*,
       COALESCE((SELECT SUM(amount) FROM reward_ledger rl WHERE rl.activity_id = a.id), 0)::int AS points_awarded
     FROM activities a
     WHERE a.contributor_id = $1
     ORDER BY a.submitted_at DESC`,
    [citizenId]
  );

  return result.rows.map(r => ({
    id: r.id,
    location: r.location,
    quantity: Number(r.quantity) || 0,
    volunteers: Number(r.volunteers) || 0,
    category: r.category,
    status: r.status,
    submittedAt: r.submitted_at,
    notes: r.notes,
    imageIpfsUrl: r.image_ipfs_url ? (Array.isArray(r.image_ipfs_url) ? r.image_ipfs_url : [r.image_ipfs_url]) : [],
    imageGatewayUrl: r.image_gateway_url ? (Array.isArray(r.image_gateway_url) ? r.image_gateway_url : [r.image_gateway_url]) : [],
    reviewNote: r.review_note,
    pointsAwarded: Number(r.points_awarded) || 0
  }));
}
