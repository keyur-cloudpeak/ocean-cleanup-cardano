import { query } from '../config/connection.js';
import { pointsConfig } from '../config/points.js';

const APPROVAL_REASON = 'activity_approved';

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

export async function getUserPoints(userId) {
  const result = await query(
    `SELECT COALESCE(SUM(amount), 0)::int AS points
     FROM reward_ledger
     WHERE user_id = $1`,
    [userId]
  );
  return Number(result.rows[0]?.points) || 0;
}

export default { awardApprovalPoints, getUserPoints };
