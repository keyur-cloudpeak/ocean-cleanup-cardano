import { getContributorStats } from '../services/activityService.js';

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

export default { getStats };
