import { getCitizenStats, getCitizenLeaderboard, getCitizenFeed, getCitizenActivities } from '../services/citizenService.js';
import { getContributorStories } from '../services/environmentalEventService.js';
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
  // Clamped to a whole number in [1, 50]. Without the floor and the
  // truncation this reached Postgres as `LIMIT -5` / `LIMIT 1.5` and came
  // back as a 500 carrying the raw driver error — on an endpoint that
  // takes no auth, so any caller could trigger it.
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 15, 1), 50);
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

/**
 * GET /api/citizen/stories
 * Returns the authenticated citizen's outcome chains for "What Changed
 * Because of You" (spec §4) — the same shape the Contributor Space gets,
 * so both spaces tell the story the same way.
 *
 * Shares the contributor service rather than a citizen-specific copy: it
 * scopes purely by the contribution's own contributor_id, which is the
 * submitting user whatever their role, so there is nothing role-specific
 * in it to duplicate.
 */
async function getStories(req, res) {
  const stories = await getContributorStories(req.user.id, req.query.limit);
  res.json({ ok: true, stories });
}

export default {
  getStats: asyncHandler(getStats),
  getLeaderboard: asyncHandler(getLeaderboard),
  getFeed: asyncHandler(getFeed),
  getActivities: asyncHandler(getActivities),
  getStories: asyncHandler(getStories)
};
