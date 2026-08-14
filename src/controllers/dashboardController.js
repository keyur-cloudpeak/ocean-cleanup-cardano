import { getDashboardStats } from '../services/activityService.js';
import { getUsers, setUserActiveStatus as setUserActiveStatusInService } from '../services/userService.js';
import { listOrganizations } from '../services/organizationService.js';
import { listNotificationsForRecipient, markNotificationReadById } from '../services/notificationService.js';

async function getStats(req, res) {
  try {
    const stats = await getDashboardStats();

    res.json({
      ok: true,
      stats
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ ok: false, error: 'Failed to compute stats' });
  }
}

async function getUserLists(req, res) {
  try {
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
  } catch (error) {
    console.error('Dashboard user lists error:', error);
    res.status(500).json({ ok: false, error: 'Failed to fetch user lists' });
  }
}

async function setUserActiveStatus(req, res) {
  try {
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
  } catch (error) {
    console.error('Dashboard set user active error:', error);
    res.status(500).json({ ok: false, error: 'Failed to update user status' });
  }
}

async function getPublicOrganizations(req, res) {
  try {
    const orgs = await listOrganizations(true); // only active orgs
    const organizations = orgs.map(({ orgId, name }) => ({ orgId, name }));
    res.json({ ok: true, organizations });
  } catch (error) {
    console.error('Public organizations list error:', error);
    res.status(500).json({ ok: false, error: 'Failed to fetch organizations' });
  }
}

async function getNotifications(req, res) {
  try {
    const notifications = await listNotificationsForRecipient('admin', req.user?.id);
    const unreadCount = notifications.filter((item) => !item.isRead).length;

    res.json({ ok: true, notifications, unreadCount });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ ok: false, error: 'Failed to load notifications' });
  }
}

async function markNotificationRead(req, res) {
  try {
    const notification = await markNotificationReadById(req.params.id, 'admin', req.user?.id);
    if (!notification) {
      return res.status(404).json({ ok: false, error: 'Notification not found' });
    }

    res.json({ ok: true, notification });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ ok: false, error: 'Failed to update notification' });
  }
}

export default { getStats, getUserLists, setUserActiveStatus, getPublicOrganizations, getNotifications, markNotificationRead };
