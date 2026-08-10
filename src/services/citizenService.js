import { query } from '../config/connection.js';

// ─── Badge definitions ────────────────────────────────────────────────────────
const BADGE_DEFS = [
  { id: 'first_report',    icon: '🥇', title: 'First Report',  desc: 'Submit your first report',    threshold: 1,   field: 'total_reports' },
  { id: 'tide_guardian',   icon: '🌊', title: 'Tide Guardian', desc: '3 reports submitted',           threshold: 3,   field: 'total_reports' },
  { id: 'spot_mapper',     icon: '📍', title: 'Spot Mapper',   desc: '5 unique locations',            threshold: 5,   field: 'unique_locations' },
  { id: 'reef_defender',   icon: '🐚', title: 'Reef Defender', desc: '7 reports submitted',           threshold: 7,   field: 'total_reports' },
  { id: 'streak_30',       icon: '🔥', title: '30-Day Streak', desc: 'Active 30 days in a row',       threshold: 30,  field: 'streak_days' },
  { id: 'top_100',         icon: '🏆', title: 'Top 100',       desc: 'Reach city rank #100 or better',threshold: 100, field: 'city_rank_inv' },
  { id: 'harbor_hero',     icon: '⚓', title: 'Harbor Hero',   desc: '100 kg logged',                 threshold: 100, field: 'total_kg' },
  { id: 'crew_leader',     icon: '👥', title: 'Crew Leader',   desc: '10+ volunteers mobilized',      threshold: 10,  field: 'total_volunteers' },
];

// Determine current tier based on report count
function getTier(reportCount) {
  if (reportCount >= 7)  return { label: '🐚 Reef Defender',  next: null,             nextAt: null  };
  if (reportCount >= 3)  return { label: '🌊 Tide Guardian',  next: 'Reef Defender',   nextAt: 7     };
  if (reportCount >= 1)  return { label: '🥇 First Reporter', next: 'Tide Guardian',   nextAt: 3     };
  return               { label: '🌱 Newcomer',            next: 'First Reporter',  nextAt: 1     };
}

// Compute which badges are earned based on stats
function computeBadges(stats) {
  return BADGE_DEFS.map(def => {
    let progress = 0;
    switch (def.field) {
      case 'total_reports':     progress = stats.totalReports;      break;
      case 'unique_locations':  progress = stats.uniqueLocations;   break;
      case 'streak_days':       progress = stats.streakDays;        break;
      case 'total_kg':          progress = stats.totalKg;           break;
      case 'total_volunteers':  progress = stats.totalVolunteers;   break;
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
  // Core stats
  const statsResult = await query(
    `SELECT
       COUNT(*)::int                                          AS total_reports,
       COUNT(DISTINCT location)::int                         AS unique_locations,
       COALESCE(SUM(quantity), 0)                            AS total_kg,
       COALESCE(SUM(volunteers), 0)::int                     AS total_volunteers,
       COUNT(*) FILTER (WHERE status = 'approved')::int      AS approved_reports,
       COUNT(*) FILTER (WHERE status = 'pending')::int       AS pending_reports,
       COUNT(*) FILTER (WHERE status = 'rejected')::int      AS rejected_reports,
       -- This week's reports
       COUNT(*) FILTER (
         WHERE submitted_at >= date_trunc('week', NOW())
       )::int                                                AS week_reports,
       -- Member since
       MIN(submitted_at)                                     AS member_since
     FROM activities
     WHERE contributor_id = $1`,
    [citizenId]
  );

  // City rank among citizens only
  const rankResult = await query(
    `SELECT rank FROM (
       SELECT a.contributor_id,
              RANK() OVER (ORDER BY COALESCE(SUM(a.quantity), 0) DESC) AS rank
       FROM activities a
       JOIN users u ON u.id = a.contributor_id
       WHERE a.contributor_id IS NOT NULL
         AND u.role = 'citizen'
       GROUP BY a.contributor_id
     ) ranked
     WHERE contributor_id = $1`,
    [citizenId]
  );

  // Calculate streak days (consecutive days with at least one activity up to today)
  const streakResult = await query(
    `WITH daily AS (
       SELECT DISTINCT DATE(submitted_at AT TIME ZONE 'UTC') AS day
       FROM activities
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
    totalReports:     Number(row.total_reports)    || 0,
    uniqueLocations:  Number(row.unique_locations)  || 0,
    totalKg:          Number(row.total_kg)          || 0,
    totalVolunteers:  Number(row.total_volunteers)  || 0,
    approvedReports:  Number(row.approved_reports)  || 0,
    pendingReports:   Number(row.pending_reports)   || 0,
    rejectedReports:  Number(row.rejected_reports)  || 0,
    weekReports:      Number(row.week_reports)      || 0,
    cityRank,
    streakDays,
    memberSince:      row.member_since ? new Date(row.member_since).toISOString() : null,
  };

  const tier = getTier(stats.totalReports);
  const badges = computeBadges(stats);
  const earnedBadges = badges.filter(b => b.earned).length;

  // Progress to next badge tier
  let progressPct = 0;
  let progressLabel = '';
  if (tier.next && tier.nextAt) {
    const prevAt = tier.nextAt === 3 ? 1 : tier.nextAt === 7 ? 3 : 0;
    progressPct = Math.min(100, Math.round(((stats.totalReports - prevAt) / (tier.nextAt - prevAt)) * 100));
    progressLabel = `${stats.totalReports} of ${tier.nextAt}`;
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
 * Get the weekly leaderboard — ALL citizens ranked by this week's reports.
 * Citizens with zero reports this week are included at the bottom (0 reports).
 */
export async function getCitizenLeaderboard(citizenId) {
  const result = await query(
    `SELECT
       u.id                                                             AS citizen_id,
       u.first_name,
       u.last_name,
       u.username,
       COUNT(a.id)::int                                                 AS week_reports,
       COALESCE(SUM(a.quantity), 0)                                     AS week_kg,
       RANK() OVER (ORDER BY COUNT(a.id) DESC, COALESCE(SUM(a.quantity),0) DESC)::int AS rank
     FROM users u
     LEFT JOIN activities a
       ON a.contributor_id = u.id
       AND a.submitted_at >= date_trunc('week', NOW())
     WHERE u.role = 'citizen'
       AND u.is_active = TRUE
     GROUP BY u.id, u.first_name, u.last_name, u.username
     ORDER BY rank, week_kg DESC`,
    []
  );

  const rows = result.rows.map(r => ({
    userId:       r.citizen_id,
    firstName:    r.first_name,
    lastName:     r.last_name,
    username:     r.username,
    initials:     `${r.first_name?.[0] || ''}${r.last_name?.[0] || ''}`.toUpperCase(),
    weekReports:  Number(r.week_reports) || 0,
    weekKg:       Number(r.week_kg)      || 0,
    rank:         Number(r.rank)         || 0,
    isMe:         r.citizen_id === citizenId,
  }));

  // All citizens are always in the list — no separate myRow needed
  return { leaderboard: rows, myRow: null };
}

/**
 * Get recent community activity feed.
 */
export async function getCitizenFeed(limit = 5) {
  const result = await query(
    `SELECT
       a.id,
       a.location,
       a.quantity,
       a.volunteers,
       a.category,
       a.status,
       a.submitted_at,
       a.notes,
       u.first_name,
       u.last_name,
       u.username
     FROM activities a
     JOIN users u ON u.id = a.contributor_id
     WHERE u.role = 'citizen'
     ORDER BY a.submitted_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(r => ({
    id:          r.id,
    location:    r.location,
    quantity:    Number(r.quantity) || 0,
    volunteers:  Number(r.volunteers) || 0,
    category:    r.category,
    status:      r.status,
    submittedAt: r.submitted_at,
    notes:       r.notes,
    firstName:   r.first_name || 'Anonymous',
    lastName:    r.last_name  || '',
    username:    r.username   || 'anon',
    initials:    r.first_name ? `${r.first_name[0]}${r.last_name?.[0] || ''}`.toUpperCase() : 'AN',
  }));
}

/**
 * Get all activities for a specific citizen.
 */
export async function getCitizenActivities(citizenId) {
  const result = await query(
    `SELECT
       a.id,
       a.location,
       a.quantity,
       a.volunteers,
       a.category,
       a.status,
       a.submitted_at,
       a.notes,
       a.image_ipfs_url,
       a.review_note,
       a.reward_amount,
       a.reward_tx_hash
     FROM activities a
     WHERE a.contributor_id = $1
     ORDER BY a.submitted_at DESC`,
    [citizenId]
  );

  return result.rows.map(r => ({
    id:          r.id,
    location:    r.location,
    quantity:    Number(r.quantity) || 0,
    volunteers:  Number(r.volunteers) || 0,
    category:    r.category,
    status:      r.status,
    submittedAt: r.submitted_at,
    notes:       r.notes,
    imageIpfsUrl: r.image_ipfs_url ? (Array.isArray(r.image_ipfs_url) ? r.image_ipfs_url : [r.image_ipfs_url]) : [],
    reviewNote:  r.review_note,
    rewardAmount: Number(r.reward_amount) || null,
    rewardTxHash: r.reward_tx_hash || null
  }));
}
