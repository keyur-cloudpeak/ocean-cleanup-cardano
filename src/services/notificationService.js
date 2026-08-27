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

// A notification is either broadcast to a whole role (recipient_id left
// null — e.g. "new activity submitted" going to every admin) or targeted
// at one specific user (recipient_id set — e.g. a closure notification
// going only to the contributor who reported it). Those are different
// conditions, not one combined with OR — an earlier version of this query
// used a bare `recipient_role = $1 OR recipient_id = $2`, which meant any
// caller passing a recipientId would also pull back every OTHER user's
// broadcast-scoped rows for that role, and (for non-admin roles, where
// every notification is targeted) potentially every other user's
// notifications entirely.
export async function listNotificationsForRecipient(recipientRole, recipientId = null) {
  const params = [recipientRole];
  let queryText = `SELECT ${notificationColumns}
                   FROM notifications
                   WHERE (recipient_role = $1 AND recipient_id IS NULL)`;

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
  // Same broadcast-vs-targeted split as listNotificationsForRecipient, and
  // the id match must scope BOTH branches (parenthesized) — an earlier
  // version's `id = $1 AND recipient_role = $2 OR recipient_id = $3` let
  // the OR escape the id check entirely, so marking any one targeted
  // notification read would mark every targeted notification for that
  // user as read.
  let queryText = `UPDATE notifications
                   SET is_read = TRUE
                   WHERE id = $1
                     AND ((recipient_role = $2 AND recipient_id IS NULL)`;

  if (recipientId) {
    params.push(recipientId);
    queryText += ` OR recipient_id = $3`;
  }
  queryText += `)`;

  queryText += ` RETURNING ${notificationColumns}`;

  const result = await query(queryText, params);
  return mapNotificationRow(result.rows[0]);
}

/**
 * notifyClosure — spec §22-23, §27's closing beat: "Something you reported
 * changed." Sent to every contributor who has a stake in an event that
 * just got closed out by a verified action — the event's own contributor
 * plus anyone whose report was linked to it via 'corroborates' (the "three
 * additional users" in the spec's worked example). Targeted per-user
 * (recipientId set), not broadcast to a role, since this is specific to
 * what that person reported.
 */
export async function notifyClosure({ contributorId, contributorRole, subjectLabel, locationLabel, kgRemoved, eventId }) {
  if (!contributorId || !contributorRole) return null;

  const title = 'Something you reported changed';
  const what = subjectLabel || 'The issue';
  const where = locationLabel ? ` near ${locationLabel}` : '';
  const impact = kgRemoved ? ` ${kgRemoved} kg removed ·` : '';
  const message = `${what} reported${where} has been removed.${impact} Verified`;

  return createNotification({
    recipientRole: contributorRole,
    recipientId: contributorId,
    title,
    message,
    payload: { eventId }
  });
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
