import { getContributorStats, getContributorInsights } from '../services/activityService.js';

/**
 * GET /api/contributor/stats
 * Returns per-contributor aggregate stats for the authenticated contributor.
 * Requires authentication (token must belong to a contributor or admin).
 */
async function getStats(req, res) {
  try {
    const contributorId = req.user?.id;
    if (!contributorId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const stats = await getContributorStats(contributorId);
    res.json({ ok: true, stats });
  } catch (error) {
    console.error('Contributor stats error:', error);
    res.status(500).json({ ok: false, error: 'Failed to compute contributor stats' });
  }
}

/**
 * GET /api/contributor/insights
 * Returns top locations, disposal method breakdown, and wildlife sighting
 * stats for the authenticated contributor's activities.
 */
async function getInsights(req, res) {
  try {
    const contributorId = req.user?.id;
    if (!contributorId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const insights = await getContributorInsights(contributorId);
    res.json({ ok: true, insights });
  } catch (error) {
    console.error('Contributor insights error:', error);
    res.status(500).json({ ok: false, error: 'Failed to compute contributor insights' });
  }
}

export default { getStats, getInsights };
