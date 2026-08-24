import crypto from 'crypto';
import { env } from '../config/env.js';
import { sendAdminInviteEmail } from '../services/emailService.js';
import {
  listAdmins,
  findAdminByEmail,
  createAdminInvite,
  deleteAdminById
} from '../services/adminService.js';
import asyncHandler from '../middleware/asyncHandler.js';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── GET /api/admin/admins ─────────────────────────────────────────────────
async function listImpl(req, res) {
  const admins = await listAdmins();
  res.json({ ok: true, admins });
}

// ─── POST /api/admin/admins ────────────────────────────────────────────────
async function inviteImpl(req, res) {
  const email = normalizeEmail(req.body.email);
  const firstName = String(req.body.firstName || '').trim() || null;
  const lastName = String(req.body.lastName || '').trim() || null;

  if (!email) {
    return res.status(400).json({ ok: false, error: 'Email is required' });
  }

  const existing = await findAdminByEmail(email);
  if (existing) {
    return res.status(400).json({ ok: false, error: 'This email has already been invited as admin' });
  }

  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
  const inviteTokenExpiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS).toISOString();

  const admin = await createAdminInvite({
    email,
    firstName,
    lastName,
    invitedBy: req.user?.id || null,
    inviteTokenHash,
    inviteTokenExpiresAt
  });

  const inviteUrl = `${String(env.adminBaseUrl || '').replace(/\/$/, '')}/set-password?token=${inviteToken}`;

  let emailResult;
  try {
    emailResult = await sendAdminInviteEmail({ to: email, firstName, inviteUrl });
  } catch (mailError) {
    await deleteAdminById(admin.id);
    throw mailError;
  }

  res.status(201).json({
    ok: true,
    admin,
    message: emailResult?.delivered === false
      ? 'Email service is in console mode. Check the backend terminal for the invite link.'
      : 'Invite sent'
  });
}

// ─── DELETE /api/admin/admins/:id ──────────────────────────────────────────
async function removeImpl(req, res) {
  if (req.params.id === req.user?.id) {
    return res.status(400).json({ ok: false, error: 'You cannot remove your own admin account' });
  }

  const deleted = await deleteAdminById(req.params.id);
  if (!deleted) {
    return res.status(404).json({ ok: false, error: 'Admin not found' });
  }

  res.json({ ok: true, message: 'Admin removed successfully' });
}

export const list = asyncHandler(listImpl);
export const invite = asyncHandler(inviteImpl);
export const remove = asyncHandler(removeImpl);

export default { list, invite, remove };
