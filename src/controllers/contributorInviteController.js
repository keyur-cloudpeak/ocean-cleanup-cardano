import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { sendContributorInviteEmail } from '../services/emailService.js';
import {
  findUserByEmail,
  createUser,
  generateUniqueUsername,
  updateUserRole,
  findUserById,
  isPendingContributorInvite,
  setUserPasswordResetToken,
  deleteUserById
} from '../services/userService.js';
import asyncHandler from '../middleware/asyncHandler.js';

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function issueInvite(user, firstName) {
  const inviteToken = crypto.randomBytes(32).toString('hex');
  await setUserPasswordResetToken(user.id, {
    tokenHash: crypto.createHash('sha256').update(inviteToken).digest('hex'),
    expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS).toISOString()
  });

  const inviteUrl = `${env.apiBaseUrl}/api/auth/reset-password?token=${inviteToken}&type=invite`;
  return sendContributorInviteEmail({ to: user.email, firstName, inviteUrl });
}

function emailExistsResponse(res, role) {
  const label = role.charAt(0).toUpperCase() + role.slice(1);
  return res.status(409).json({
    ok: false,
    error: `Email already exists for the ${label}. Please use another email.`
  });
}

function inviteMessage(emailResult, resent) {
  if (emailResult?.delivered === false) {
    return 'Email service is in console mode. Check the backend terminal for the invite link.';
  }
  return resent ? 'Invite resent' : 'Invite sent';
}

function userPayload(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    username: user.username,
    role: user.role
  };
}

// ─── POST /api/admin/contributors ──────────────────────────────────────────
// Creates a contributor account that cannot be logged into yet (random
// password) and emails a one-time link to the existing set-password page.
// Inviting an address whose invite is still pending resends the email.
async function inviteImpl(req, res) {
  const email = normalizeEmail(req.body.email);
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();

  if (!email) {
    return res.status(400).json({ ok: false, error: 'Email is required' });
  }

  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    if (existingUser.role === 'contributor') {
      // A contributor who never opened their invite can be re-invited.
      if (isPendingContributorInvite(existingUser)) {
        const emailResult = await issueInvite(existingUser, firstName || existingUser.firstName);
        return res.json({
          ok: true,
          resent: true,
          user: userPayload(existingUser),
          message: inviteMessage(emailResult, true)
        });
      }
      return emailExistsResponse(res, 'contributor');
    }

    // Emails are unique across users, so a citizen who is being invited as a
    // contributor is upgraded in place rather than duplicated.
    if (existingUser.role === 'citizen') {
      const upgraded = await updateUserRole(existingUser.id, 'contributor');
      let emailResult;
      try {
        emailResult = await issueInvite(upgraded, firstName || upgraded.firstName);
      } catch (mailError) {
        await updateUserRole(existingUser.id, existingUser.role);
        throw mailError;
      }
      return res.json({
        ok: true,
        upgraded: true,
        user: userPayload(upgraded),
        message: inviteMessage(emailResult, false)
      });
    }

    return emailExistsResponse(res, existingUser.role);
  }

  const username = await generateUniqueUsername(email);
  const placeholderPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

  const user = await createUser({
    firstName: firstName || username,
    lastName,
    email,
    username,
    password: placeholderPasswordHash,
    role: 'contributor'
    // email_verified_at stays empty until they set a password via the link.
  });

  let emailResult;
  try {
    emailResult = await issueInvite(user, firstName);
  } catch (mailError) {
    await deleteUserById(user.id);
    throw mailError;
  }

  res.status(201).json({
    ok: true,
    user: userPayload(user),
    message: inviteMessage(emailResult, false)
  });
}

// ─── DELETE /api/admin/contributors/:id ────────────────────────────────────
// Cancels an invite that hasn't been accepted. Active accounts are never
// removed here.
async function cancelInviteImpl(req, res) {
  const user = await findUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ ok: false, error: 'Invite not found' });
  }
  if (!isPendingContributorInvite(user)) {
    return res.status(400).json({ ok: false, error: 'Only pending invites can be cancelled' });
  }

  await deleteUserById(user.id);
  res.json({ ok: true, message: 'Invite cancelled' });
}

export const invite = asyncHandler(inviteImpl);
export const cancelInvite = asyncHandler(cancelInviteImpl);

export default { invite, cancelInvite };
