import { getDashboardStats } from '../services/activityService.js';
import { getUsers, setUserActiveStatus as setUserActiveStatusInService } from '../services/userService.js';
import { listOrganizations, createOrganization, addOrganizationMembership } from '../services/organizationService.js';
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

async function createPublicOrganization(req, res) {
  const name = (req.body?.name || '').trim();
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Organization name is required' });
  }

  const existing = (await listOrganizations(true))
    .find((o) => o.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    // Deliberately NOT joining the caller to an org that already exists —
    // typing an existing NGO's name into the picker must not enrol you in
    // it, which is the exact hole resolveContributorOrganization closes.
    return res.status(200).json({ ok: true, organization: { orgId: existing.orgId, name: existing.name } });
  }

  const org = await createOrganization({ name, isActive: true });

  // Whoever creates an org from the submit form is a member of it —
  // without this they'd immediately fail the membership check on the very
  // submission they created it for. This route is also reachable
  // unauthenticated during signup (no token yet), hence the optional user.
  if (req.user?.id) {
    await addOrganizationMembership(req.user.id, org.orgId, 'owner');
  }

  res.status(201).json({ ok: true, organization: { orgId: org.orgId, name: org.name } });
}

// Scoped to the caller's own role/id now, not hardcoded to 'admin' — every
// role gets its own notifications (admins: new-submission broadcasts;
// contributors/citizens: closure notifications from notifyEventClosure).
// listNotificationsForRecipient/markNotificationReadById already keep
// broadcast (recipient_id null) and targeted (recipient_id set) rows
// properly scoped, so this is safe to open up beyond admin.
async function getNotifications(req, res) {
  const notifications = await listNotificationsForRecipient(req.user.role, req.user.id);
  const unreadCount = notifications.filter((item) => !item.isRead).length;

  res.json({ ok: true, notifications, unreadCount });
}

async function markNotificationRead(req, res) {
  const notification = await markNotificationReadById(req.params.id, req.user.role, req.user.id);
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
  createPublicOrganization: asyncHandler(createPublicOrganization),
  getNotifications: asyncHandler(getNotifications),
  markNotificationRead: asyncHandler(markNotificationRead)
};
