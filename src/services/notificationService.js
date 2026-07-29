import { query } from '../config/connection.js';
import { findUserById } from './userService.js';

const notificationColumns = `id, recipient_role, recipient_id, activity_id, title, message, link, payload, is_read, created_at`;

function mapNotificationRow(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    recipientRole: row.recipient_role,
    recipientId: row.recipient_id,
    activityId: row.activity_id,
    title: row.title,
    message: row.message,
    link: row.link,
    payload: row.payload,
    isRead: row.is_read,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  };
}

export async function createNotification({ recipientRole, recipientId = null, activityId = null, title, message, link = null, payload = {} }) {
  const result = await query(
    `INSERT INTO notifications (recipient_role, recipient_id, activity_id, title, message, link, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${notificationColumns}`,
    [recipientRole, recipientId, activityId, title, message, link, payload]
  );

  return mapNotificationRow(result.rows[0]);
}

async function enrichNotification(notification) {
  const contributorId = notification.payload?.contributorId;
  if (!contributorId) return notification;

  const contributor = await findUserById(contributorId);
  if (!contributor) return notification;

  const contributorName = [contributor.firstName, contributor.lastName].filter(Boolean).join(' ') || contributor.username || contributorId;
  let message = notification.message;
  if (message.includes(contributorId)) {
    message = message.replace(contributorId, contributorName);
  }

  return {
    ...notification,
    message,
    contributorName
  };
}

export async function listNotificationsForRecipient(recipientRole, recipientId = null) {
  const params = [recipientRole];
  let queryText = `SELECT ${notificationColumns}
                   FROM notifications
                   WHERE recipient_role = $1`;

  if (recipientId) {
    params.push(recipientId);
    queryText += ` OR recipient_id = $2`;
  }

  queryText += ` ORDER BY is_read ASC, created_at DESC`;

  const result = await query(queryText, params);
  const notifications = result.rows.map(mapNotificationRow);
  return Promise.all(notifications.map(enrichNotification));
}

export async function markNotificationReadById(id, recipientRole, recipientId = null) {
  const params = [id, recipientRole];
  let queryText = `UPDATE notifications
                   SET is_read = TRUE
                   WHERE id = $1
                     AND recipient_role = $2`;

  if (recipientId) {
    params.push(recipientId);
    queryText += ` OR recipient_id = $3`;
  }

  queryText += ` RETURNING ${notificationColumns}`;

  const result = await query(queryText, params);
  return mapNotificationRow(result.rows[0]);
}

export async function send(activity) {
  const activityLocation = activity.location || 'a cleanup location';
  let contributorLabel = 'by a contributor';

  if (activity.contributorId) {
    const contributor = await findUserById(activity.contributorId);
    if (contributor?.firstName || contributor?.lastName) {
      contributorLabel = `by ${[contributor.firstName, contributor.lastName].filter(Boolean).join(' ')}`;
    } else if (contributor?.username) {
      contributorLabel = `by ${contributor.username}`;
    } else {
      contributorLabel = `by ${activity.contributorId}`;
    }
  }

  const title = 'New activity submitted';
  const message = `A new cleanup activity was submitted ${contributorLabel} At: ${activityLocation}.`;

  return createNotification({
    recipientRole: 'admin',
    activityId: activity.id,
    title,
    message,
    link: '/dashboard/activities',
    payload: {
      activityId: activity.id,
      contributorId: activity.contributorId,
      organizationId: activity.organizationId
    }
  });
}
