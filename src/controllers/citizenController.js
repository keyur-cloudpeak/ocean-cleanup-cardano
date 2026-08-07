import { getCitizenStats, getCitizenLeaderboard, getCitizenFeed } from '../services/citizenService.js';

/**
 * GET /api/citizen/stats
 * Returns the authenticated citizen's personal stats, tier, badges, and progress.
 */
async function getStats(req, res) {
  try {
    const citizenId = req.user?.id;
    if (!citizenId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const stats = await getCitizenStats(citizenId);
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Citizen stats error:', err);
    res.status(500).json({ ok: false, error: 'Failed to compute citizen stats' });
  }
}

/**
 * GET /api/citizen/leaderboard
 * Returns the current week's leaderboard (top 10 + caller's own row if outside top 10).
 */
async function getLeaderboard(req, res) {
  try {
    const citizenId = req.user?.id;
    const data = await getCitizenLeaderboard(citizenId);
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Citizen leaderboard error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load leaderboard' });
  }
}

/**
 * GET /api/citizen/feed
 * Returns recent community activity feed (public — no auth needed, auth adds "isMe" flag).
 */
async function getFeed(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 15, 50);
    const feed = await getCitizenFeed(limit);
    res.json({ ok: true, feed });
  } catch (err) {
    console.error('Citizen feed error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load feed' });
  }
}

export default { getStats, getLeaderboard, getFeed };
