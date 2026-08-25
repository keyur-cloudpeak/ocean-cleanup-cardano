import asyncHandler from '../middleware/asyncHandler.js';
import { findUserById } from '../services/userService.js';
import {
  getContributorActivities,
  getContributorExportActivities,
  getContributorExportSummary,
  getContributorInsights,
  getContributorStats
} from '../services/activityService.js';
import { streamContributorReportPdf } from '../services/reportPdfService.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function defaultExportRange() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 6);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
import {
  getCitizenActivities,
  getCitizenFeed,
  getCitizenLeaderboard,
  getCitizenStats
} from '../services/citizenService.js';

async function getContributorReport(req, res) {
  const userId = req.params.userId;
  const user = await findUserById(userId);

  if (!user || user.role !== 'contributor') {
    return res.status(404).json({ ok: false, error: 'Contributor not found' });
  }

  const [stats, insights, activities] = await Promise.all([
    getContributorStats(userId),
    getContributorInsights(userId),
    getContributorActivities(userId),
  ]);

  res.json({
    ok: true,
    user,
    stats,
    insights,
    activities,
  });
}

async function exportContributorReport(req, res) {
  const userId = req.params.userId;
  const contributor = await findUserById(userId);
  if (!contributor || contributor.role !== 'contributor') {
    return res.status(404).json({ ok: false, error: 'Contributor not found' });
  }

  const defaults = defaultExportRange();
  let from = DATE_PATTERN.test(req.query.from || '') ? req.query.from : defaults.from;
  let to = DATE_PATTERN.test(req.query.to || '') ? req.query.to : defaults.to;
  if (from > to) [from, to] = [to, from];

  const [summary, activities] = await Promise.all([
    getContributorExportSummary(userId, from, to),
    getContributorExportActivities(userId, from, to),
  ]);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="field-report-${from}-to-${to}.pdf"`);
  streamContributorReportPdf(res, { contributor, from, to, summary, activities });
}

async function getCitizenReport(req, res) {
  const userId = req.params.userId;
  const user = await findUserById(userId);

  if (!user || user.role !== 'citizen') {
    return res.status(404).json({ ok: false, error: 'Citizen not found' });
  }

  const [stats, leaderboard, feed, activities] = await Promise.all([
    getCitizenStats(userId),
    getCitizenLeaderboard(userId),
    getCitizenFeed(6),
    getCitizenActivities(userId),
  ]);

  res.json({
    ok: true,
    user,
    stats,
    leaderboard,
    feed,
    activities,
  });
}

export default {
  getContributorReport: asyncHandler(getContributorReport),
  exportContributorReport: asyncHandler(exportContributorReport),
  getCitizenReport: asyncHandler(getCitizenReport),
};
