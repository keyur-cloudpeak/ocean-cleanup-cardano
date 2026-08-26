import { getContributorStats, getContributorInsights, getContributorExportSummary, getContributorExportActivities } from '../services/activityService.js';
import { getContributorImpactSummary } from '../services/environmentalEventService.js';
import { findUserById } from '../services/userService.js';
import { streamContributorReportPdf } from '../services/reportPdfService.js';
import asyncHandler from '../middleware/asyncHandler.js';

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
  const stats = await getContributorStats(req.user.id);
  res.json({ ok: true, stats });
}

/**
 * GET /api/contributor/insights
 * Returns top locations, disposal method breakdown, and wildlife sighting
 * stats for the authenticated contributor's activities.
 */
async function getInsights(req, res) {
  const insights = await getContributorInsights(req.user.id);
  res.json({ ok: true, insights });
}

/**
 * GET /api/contributor/impact
 * The five "Your Impact" numbers from the environmental-event model
 * (contributions, verified, actions completed, kg removed, locations
 * affected) for the authenticated contributor — see spec §22.
 */
async function getImpact(req, res) {
  const impact = await getContributorImpactSummary(req.user.id);
  res.json({ ok: true, impact });
}

/**
 * GET /api/contributor/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=pdf
 * Streams a PDF field report of the authenticated contributor's approved
 * activities within the given date range (defaults to the last 6 months).
 */
// Kept as a real try/catch (not routed through asyncHandler's throw path):
// the catch here does meaningful work beyond a generic 500 — it checks
// res.headersSent since the PDF stream may already be underway.
async function exportReport(req, res) {
  try {
    const contributorId = req.user.id;
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

export default {
  getStats: asyncHandler(getStats),
  getInsights: asyncHandler(getInsights),
  getImpact: asyncHandler(getImpact),
  exportReport: asyncHandler(exportReport)
};
