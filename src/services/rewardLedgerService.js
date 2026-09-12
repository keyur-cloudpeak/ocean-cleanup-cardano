import { query } from '../config/connection.js';
import { pointsConfig } from '../config/points.js';

const APPROVAL_REASON = 'activity_approved';
const CORROBORATION_REASON = 'event_corroborated';
const VERIFICATION_REASON = 'event_verified';

export async function awardApprovalPoints({ activityId, userId, reviewerId }) {
  const idempotencyKey = `activity:${activityId}:${APPROVAL_REASON}`;
  const metadata = { reviewerId: reviewerId || null };

  const inserted = await query(
    `INSERT INTO reward_ledger (activity_id, user_id, reason, amount, idempotency_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, activity_id, user_id, reason, amount, idempotency_key, metadata, created_at`,
    [activityId, userId, APPROVAL_REASON, pointsConfig.perApprovedActivity, idempotencyKey, metadata]
  );

  if (inserted.rows[0]) {
    return { ...inserted.rows[0], awarded: true };
  }

  const existing = await query(
    `SELECT id, activity_id, user_id, reason, amount, idempotency_key, metadata, created_at
     FROM reward_ledger WHERE idempotency_key = $1`,
    [idempotencyKey]
  );

  return existing.rows[0] ? { ...existing.rows[0], awarded: false } : null;
}

// Trust-weighted points (spec §14): a contribution earns points for being
// corroborated by other independent reporters or verified by a human, not
// for the quantity it claims. `activity_id` stays null here — these are
// keyed to an environmental_event, which may have no legacy activity at
// all (e.g. an action event). Idempotent per event+reason, same pattern as
// awardApprovalPoints, so a re-triggered corroboration/verification never
// double-pays.
async function awardEventPoints({ eventId, userId, reason, amount }) {
  if (!userId) return null;
  const idempotencyKey = `event:${eventId}:${reason}`;
  const metadata = { eventId };

  const inserted = await query(
    `INSERT INTO reward_ledger (user_id, reason, amount, idempotency_key, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, user_id, reason, amount, idempotency_key, metadata, created_at`,
    [userId, reason, amount, idempotencyKey, metadata]
  );

  if (inserted.rows[0]) {
    return { ...inserted.rows[0], awarded: true };
  }

  const existing = await query(
    `SELECT id, user_id, reason, amount, idempotency_key, metadata, created_at
     FROM reward_ledger WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  return existing.rows[0] ? { ...existing.rows[0], awarded: false } : null;
}

export async function awardCorroborationPoints({ eventId, userId }) {
  return awardEventPoints({ eventId, userId, reason: CORROBORATION_REASON, amount: pointsConfig.perCorroboration });
}

export async function awardVerificationPoints({ eventId, userId }) {
  return awardEventPoints({ eventId, userId, reason: VERIFICATION_REASON, amount: pointsConfig.perVerification });
}

export async function getUserPoints(userId) {
  const result = await query(
    `SELECT COALESCE(SUM(amount), 0)::int AS points
     FROM reward_ledger
     WHERE user_id = $1`,
    [userId]
  );
  return Number(result.rows[0]?.points) || 0;
}

export default { awardApprovalPoints, awardCorroborationPoints, awardVerificationPoints, getUserPoints };
