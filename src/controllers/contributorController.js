import { getContributorStats, getContributorInsights, getContributorExportSummary, getContributorExportActivities } from '../services/activityService.js';
import { findUserById } from '../services/userService.js';
import { streamContributorReportPdf } from '../services/reportPdfService.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

function defaultExportRange() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 6);
  return { from: toDateInputValue(from), to: toDateInputValue(to) };
}

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

/**
 * GET /api/contributor/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=pdf
 * Streams a PDF field report of the authenticated contributor's approved
 * activities within the given date range (defaults to the last 6 months).
 */
async function exportReport(req, res) {
  try {
    const contributorId = req.user?.id;
    if (!contributorId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const defaults = defaultExportRange();
    let from = DATE_PATTERN.test(req.query.from || '') ? req.query.from : defaults.from;
    let to = DATE_PATTERN.test(req.query.to || '') ? req.query.to : defaults.to;
    if (from > to) {
      [from, to] = [to, from];
    }

    const [contributor, summary, activities] = await Promise.all([
      findUserById(contributorId),
      getContributorExportSummary(contributorId, from, to),
      getContributorExportActivities(contributorId, from, to)
    ]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="field-report-${from}-to-${to}.pdf"`);

    streamContributorReportPdf(res, { contributor, from, to, summary, activities });
  } catch (error) {
    console.error('Contributor export error:', error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Failed to generate report' });
    } else {
      res.end();
    }
  }
}

export default { getStats, getInsights, exportReport };
