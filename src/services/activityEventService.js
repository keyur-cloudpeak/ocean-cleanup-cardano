import { query } from '../config/connection.js';

export async function recordActivityEvent({ activityId, eventType, actorId = null, payload = {} }) {
  const result = await query(
    `INSERT INTO activity_events (activity_id, event_type, payload)
     VALUES ($1, $2, $3)
     RETURNING id, activity_id, event_type, payload, created_at`,
    [activityId, eventType, { ...payload, actorId }]
  );

  return result.rows[0];
}

export default { recordActivityEvent };
