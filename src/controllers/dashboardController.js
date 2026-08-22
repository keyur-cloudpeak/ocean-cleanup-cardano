import { getDashboardStats } from '../services/activityService.js';
import { getUsers, setUserActiveStatus as setUserActiveStatusInService } from '../services/userService.js';
import { listOrganizations } from '../services/organizationService.js';
import { listNotificationsForRecipient, markNotificationReadById } from '../services/notificationService.js';
import asyncHandler from '../middleware/asyncHandler.js';

async function getStats(req, res) {
  const stats = await getDashboardStats();

  res.json({
    ok: true,
    stats
  });
}

async function getUserLists(req, res) {
  const allUsers = await getUsers();
  const verifiers = allUsers
    .filter((u) => u.role === 'verifier')
    .map(({ id, firstName, lastName, username, email, active, organizationId, createdAt }) => ({
      id, firstName, lastName, username, email, active, organizationId, createdAt
    }));
  const contributors = allUsers
    .filter((u) => u.role === 'contributor')
    .map(({ id, firstName, lastName, username, email, active, organizationId, createdAt }) => ({
      id, firstName, lastName, username, email, active, organizationId, createdAt
    }));
  const citizens = allUsers
    .filter((u) => u.role === 'citizen')
    .map(({ id, firstName, lastName, username, email, active, organizationId, createdAt }) => ({
      id, firstName, lastName, username, email, active, organizationId, createdAt
    }));

  res.json({ ok: true, verifiers, contributors, citizens });
}

async function setUserActiveStatus(req, res) {
  const { id } = req.params;
  const active = req.body.active;

  if (typeof active !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Active status must be boolean' });
  }

  const updatedUser = await setUserActiveStatusInService(id, active);
  if (!updatedUser) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }

  res.json({ ok: true, user: updatedUser });
}

async function getPublicOrganizations(req, res) {
  const orgs = await listOrganizations(true); // only active orgs
  const organizations = orgs.map(({ orgId, name }) => ({ orgId, name }));
  res.json({ ok: true, organizations });
}

async function getNotifications(req, res) {
  const notifications = await listNotificationsForRecipient('admin', req.user?.id);
  const unreadCount = notifications.filter((item) => !item.isRead).length;

  res.json({ ok: true, notifications, unreadCount });
}

async function markNotificationRead(req, res) {
  const notification = await markNotificationReadById(req.params.id, 'admin', req.user?.id);
  if (!notification) {
    return res.status(404).json({ ok: false, error: 'Notification not found' });
  }

  res.json({ ok: true, notification });
}

export default {
  getStats: asyncHandler(getStats),
  getUserLists: asyncHandler(getUserLists),
  setUserActiveStatus: asyncHandler(setUserActiveStatus),
  getPublicOrganizations: asyncHandler(getPublicOrganizations),
  getNotifications: asyncHandler(getNotifications),
  markNotificationRead: asyncHandler(markNotificationRead)
};
