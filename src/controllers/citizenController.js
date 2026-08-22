import { getCitizenStats, getCitizenLeaderboard, getCitizenFeed, getCitizenActivities } from '../services/citizenService.js';
import asyncHandler from '../middleware/asyncHandler.js';

/**
 * GET /api/citizen/stats
 * Returns the authenticated citizen's personal stats, tier, badges, and progress.
 */
async function getStats(req, res) {
  const stats = await getCitizenStats(req.user.id);
  res.json({ ok: true, stats });
}

/**
 * GET /api/citizen/leaderboard
 * Returns the current week's leaderboard (top 10 + caller's own row if outside top 10).
 */
async function getLeaderboard(req, res) {
  const data = await getCitizenLeaderboard(req.user?.id);
  res.json({ ok: true, ...data });
}

/**
 * GET /api/citizen/feed
 * Returns recent community activity feed (public — no auth needed, auth adds "isMe" flag).
 */
async function getFeed(req, res) {
  const limit = Math.min(Number(req.query.limit) || 15, 50);
  const feed = await getCitizenFeed(limit);
  res.json({ ok: true, feed });
}

/**
 * GET /api/citizen/activities
 * Returns the authenticated citizen's activities
 */
async function getActivities(req, res) {
  const activities = await getCitizenActivities(req.user.id);
  res.json({ ok: true, activities });
}

export default {
  getStats: asyncHandler(getStats),
  getLeaderboard: asyncHandler(getLeaderboard),
  getFeed: asyncHandler(getFeed),
  getActivities: asyncHandler(getActivities)
};
