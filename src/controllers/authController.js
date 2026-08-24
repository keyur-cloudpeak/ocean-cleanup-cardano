import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/emailService.js';
import {
  findUserByUsername,
  findUserByEmail,
  createUser,
  findUserById,
  recordUserLogin,
  deleteUserLoginRecords,
  updateUserProfile,
  findUserByEmailVerificationToken,
  markUserEmailVerified,
  findUserByPasswordResetToken,
  setUserPasswordResetToken,
  clearUserPasswordResetToken,
  updateUserPassword,
  deleteUserById
} from '../services/userService.js';
import {
  findAdminByEmail,
  findAdminById,
  findAdminByInviteToken,
  setAdminPassword
} from '../services/adminService.js';
import asyncHandler from '../middleware/asyncHandler.js';

// NOTE on this controller's catch blocks: unlike the other controllers,
// every response here (success and error) uses a `message` field, not
// `error`. The shared errorHandler.js (wired up via asyncHandler) responds
// with `{ ok:false, error: ... }`. Converting these generic catch-all
// blocks to throw-and-let-asyncHandler-catch would silently rename the
// JSON field from `message` to `error` for every 500 this controller
// returns, which is a response-shape regression, not a pure refactor.
// So the catch blocks below are left as-is; only the handlers are wrapped
// with asyncHandler (as a backstop for any error path that currently
// isn't caught at all, e.g. a synchronous throw before the try block).

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function requiresEmailVerification(role) {
  return ['citizen', 'contributor'].includes(String(role || '').trim().toLowerCase());
}

function buildAdminPayload(admin) {
  return {
    id: admin.id,
    firstName: admin.firstName,
    lastName: admin.lastName,
    email: admin.email,
    role: 'admin',
    passwordSet: admin.passwordSet
  };
}

function buildUserPayload(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    username: user.username,
    role: user.role,
    organizationId: user.organizationId,
    jobTitle: user.jobTitle,
    yearsExperience: user.yearsExperience,
    profileImageUrl: user.profileImageUrl,
    emailVerifiedAt: user.emailVerifiedAt
  };
}

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const WEB_APP_LOGIN_URL = `${String(env.webBaseUrl || 'http://localhost:3002').replace(/\/$/, '')}/login`;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function renderPasswordResetNoticePage() {
  return `
    <html>
      <head>
        <title>Password Reset - BlueMind</title>
      </head>
      <body style="margin:0; padding:0; background-color:#0a1e33; font-family:Arial, Helvetica, sans-serif;">
        <div style="max-width:600px; margin:0 auto; padding:60px 20px;">
          <div style="background:rgba(15,42,64,0.55); border:1px solid rgba(148,197,214,0.18); border-radius:20px; padding:50px 40px; text-align:center; box-shadow:0 8px 30px rgba(0,0,0,0.35);">
            <table role="presentation" align="center" style="margin:0 auto 30px;">
              <tr>
                <td style="vertical-align:middle; padding-right:8px;">
                  <span style="display:inline-block; width:26px; height:26px; border:1.5px solid #7dd3c0; border-radius:50%; color:#7dd3c0; font-size:14px; line-height:23px; text-align:center;">🌐</span>
                </td>
                <td style="vertical-align:middle;">
                  <span style="color:#f1f5f9; font-size:18px; font-weight:700; letter-spacing:0.3px;">BlueMind</span>
                </td>
              </tr>
            </table>
            <div style="width:64px; height:64px; margin:0 auto 26px; border-radius:50%; background:linear-gradient(135deg, rgba(96,165,250,0.25), rgba(59,130,246,0.1)); border:1px solid rgba(96,165,250,0.4); line-height:64px; font-size:28px; color:#60a5fa;">ℹ</div>
            <h1 style="margin:0 0 12px; font-size:30px; font-weight:600; color:#f8fafc;">Password reset link <span style="font-style:italic; font-weight:400; color:#60a5fa;">expired or invalid.</span></h1>
            <p style="margin:0 auto 34px; max-width:420px; font-size:15px; line-height:1.6; color:#94a3b8;">
              That reset link is no longer usable. Please request a new password reset from the sign-in page.
            </p>
            <table role="presentation" align="center" style="margin:0 auto;">
              <tr>
                <td style="background:linear-gradient(90deg, #2dd4bf, #5eead4); border-radius:10px;">
                  <a href="${WEB_APP_LOGIN_URL}" style="display:inline-block; padding:14px 36px; font-size:14px; font-weight:700; letter-spacing:0.5px; color:#062a29; text-decoration:none;">BACK TO LOGIN &nbsp;&#8594;</a>
                </td>
              </tr>
            </table>
          </div>
        </div>
      </body>
    </html>
  `;
}

function renderPasswordResetFormPage({ token, error = null }) {
  const errorBanner = error
    ? `<div style="margin:0 0 20px; padding:14px 16px; border-radius:12px; border:1px solid rgba(248,113,113,0.35); background:rgba(248,113,113,0.08); color:#fecaca; font-size:14px; line-height:1.5;">${error}</div>`
    : '';

  return `
    <html>
      <head>
        <title>Reset Password - BlueMind</title>
      </head>
      <body style="margin:0; padding:0; background-color:#0a1e33; font-family:Arial, Helvetica, sans-serif;">
        <div style="max-width:600px; margin:0 auto; padding:60px 20px;">
          <form method="POST" action="/api/auth/reset-password" style="background:rgba(15,42,64,0.55); border:1px solid rgba(148,197,214,0.18); border-radius:20px; padding:50px 40px; box-shadow:0 8px 30px rgba(0,0,0,0.35);">
            <table role="presentation" align="center" style="margin:0 auto 30px;">
              <tr>
                <td style="vertical-align:middle; padding-right:8px;">
                  <span style="display:inline-block; width:26px; height:26px; border:1.5px solid #7dd3c0; border-radius:50%; color:#7dd3c0; font-size:14px; line-height:23px; text-align:center;">🌐</span>
                </td>
                <td style="vertical-align:middle;">
                  <span style="color:#f1f5f9; font-size:18px; font-weight:700; letter-spacing:0.3px;">BlueMind</span>
                </td>
              </tr>
            </table>
            <div style="text-align:center;">
              <div style="width:64px; height:64px; margin:0 auto 26px; border-radius:50%; background:linear-gradient(135deg, rgba(45,212,191,0.22), rgba(94,234,212,0.10)); border:1px solid rgba(94,234,212,0.35); line-height:64px; font-size:28px; color:#5eead4;">🔐</div>
              <h1 style="margin:0 0 12px; font-size:30px; font-weight:600; color:#f8fafc;">Choose a <span style="font-style:italic; font-weight:400; color:#5eead4;">new password.</span></h1>
              <p style="margin:0 auto 24px; max-width:440px; font-size:15px; line-height:1.6; color:#94a3b8;">
                Enter your new password below. This reset link can only be used once.
              </p>
            </div>
            ${errorBanner}
            <input type="hidden" name="token" value="${token}" />
            <div style="margin-bottom:16px;">
              <label style="display:block; margin:0 0 8px; color:#cbd5e1; font-size:14px; font-weight:600;">New password</label>
              <div style="position:relative;">
                <input id="password" name="password" type="password" autocomplete="new-password" required style="width:100%; box-sizing:border-box; border-radius:12px; border:1px solid rgba(148,163,184,0.25); background:rgba(2,12,20,0.45); color:#f8fafc; padding:14px 52px 14px 16px; font-size:15px; outline:none;" />
                <button type="button" aria-label="Show password" aria-pressed="false" onclick="togglePassword('password', this)" style="position:absolute; top:50%; right:12px; transform:translateY(-50%); border:0; padding:6px; background:transparent; color:#94a3b8; cursor:pointer;">
                  <svg class="password-eye" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>
                </button>
              </div>
            </div>
            <div style="margin-bottom:24px;">
              <label style="display:block; margin:0 0 8px; color:#cbd5e1; font-size:14px; font-weight:600;">Confirm password</label>
              <div style="position:relative;">
                <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required style="width:100%; box-sizing:border-box; border-radius:12px; border:1px solid rgba(148,163,184,0.25); background:rgba(2,12,20,0.45); color:#f8fafc; padding:14px 52px 14px 16px; font-size:15px; outline:none;" />
                <button type="button" aria-label="Show password" aria-pressed="false" onclick="togglePassword('confirmPassword', this)" style="position:absolute; top:50%; right:12px; transform:translateY(-50%); border:0; padding:6px; background:transparent; color:#94a3b8; cursor:pointer;">
                  <svg class="password-eye" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>
                </button>
              </div>
            </div>
            <div style="text-align:center;">
              <button type="submit" style="border:none; cursor:pointer; background:linear-gradient(90deg, #2dd4bf, #5eead4); border-radius:10px; padding:14px 34px; font-size:15px; font-weight:700; letter-spacing:0.3px; color:#062a29;">
                Update Password
              </button>
            </div>
            <div style="border-top:1px solid rgba(148,163,184,0.2); padding-top:20px; margin-top:28px;">
              <p style="font-size:13px; line-height:1.6; color:#94a3b8; margin:0;">
                If you did not request this reset, you can safely close this page.
              </p>
            </div>
          </form>
        </div>
        <script>
          function togglePassword(inputId, button) {
            const input = document.getElementById(inputId);
            const isVisible = input.type === 'text';
            input.type = isVisible ? 'password' : 'text';
            button.setAttribute('aria-label', isVisible ? 'Show password' : 'Hide password');
            button.setAttribute('aria-pressed', String(!isVisible));
            button.style.color = isVisible ? '#94a3b8' : '#5eead4';
          }
        </script>
      </body>
    </html>
  `;
}

function renderPasswordResetSuccessPage() {
  return `
    <html>
      <head>
        <title>Password Updated - BlueMind</title>
      </head>
      <body style="margin:0; padding:0; background-color:#0a1e33; font-family:Arial, Helvetica, sans-serif;">
        <div style="max-width:600px; margin:0 auto; padding:60px 20px;">
          <div style="background:rgba(15,42,64,0.55); border:1px solid rgba(148,197,214,0.18); border-radius:20px; padding:50px 40px; text-align:center; box-shadow:0 8px 30px rgba(0,0,0,0.35);">
            <table role="presentation" align="center" style="margin:0 auto 30px;">
              <tr>
                <td style="vertical-align:middle; padding-right:8px;">
                  <span style="display:inline-block; width:26px; height:26px; border:1.5px solid #7dd3c0; border-radius:50%; color:#7dd3c0; font-size:14px; line-height:23px; text-align:center;">🌐</span>
                </td>
                <td style="vertical-align:middle;">
                  <span style="color:#f1f5f9; font-size:18px; font-weight:700; letter-spacing:0.3px;">BlueMind</span>
                </td>
              </tr>
            </table>
            <div style="width:64px; height:64px; margin:0 auto 26px; border-radius:50%; background:linear-gradient(135deg, rgba(94,234,212,0.25), rgba(45,212,191,0.1)); border:1px solid rgba(94,234,212,0.4); line-height:64px; font-size:30px; color:#5eead4;">✓</div>
            <h1 style="margin:0 0 12px; font-size:30px; font-weight:600; color:#f8fafc;">Password updated <span style="font-style:italic; font-weight:400; color:#5eead4;">successfully.</span></h1>
            <p style="margin:0 auto 34px; max-width:420px; font-size:15px; line-height:1.6; color:#94a3b8;">
              Your password has been changed. You can now sign in with your new credentials.
            </p>
            <table role="presentation" align="center" style="margin:0 auto;">
              <tr>
                <td style="background:linear-gradient(90deg, #2dd4bf, #5eead4); border-radius:10px;">
                  <a href="${WEB_APP_LOGIN_URL}" style="display:inline-block; padding:14px 36px; font-size:14px; font-weight:700; letter-spacing:0.5px; color:#062a29; text-decoration:none;">CONTINUE TO LOGIN &nbsp;&#8594;</a>
                </td>
              </tr>
            </table>
          </div>
        </div>
      </body>
    </html>
  `;
}

async function signup(req, res) {
  try {
    const firstName = String(req.body.firstName || '').trim();
    const lastName = String(req.body.lastName || '').trim();
    const email = normalizeEmail(req.body.email);
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');
    const role = String(req.body.role || '').trim().toLowerCase();
    const organizationId = req.body.organizationId || null;
    const jobTitle = String(req.body.jobTitle || '').trim() || null;
    const yearsExperience = String(req.body.yearsExperience || '').trim() || null;

    if (!firstName || !lastName || !email || !username || !password || !role) {
      return res.status(400).json({ ok: false, message: 'All fields are required' });
    }

    const validRoles = ['admin', 'contributor', 'verifier', 'citizen'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ ok: false, message: 'Invalid role' });
    }

    const [existingUserByUsername, existingUserByEmail] = await Promise.all([
      findUserByUsername(username),
      findUserByEmail(email)
    ]);

    if (existingUserByUsername) {
      return res.status(400).json({ ok: false, message: 'Username already exists' });
    }

    if (existingUserByEmail) {
      return res.status(400).json({ ok: false, message: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationRequired = requiresEmailVerification(role);
    const verificationToken = verificationRequired ? crypto.randomBytes(32).toString('hex') : null;
    const verificationTokenHash = verificationRequired
      ? crypto.createHash('sha256').update(verificationToken).digest('hex')
      : null;
    const verificationTokenExpiresAt = verificationRequired
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : null;

    const user = await createUser({
      firstName,
      lastName,
      email,
      username,
      password: hashedPassword,
      role,
      organizationId,
      jobTitle,
      yearsExperience,
      emailVerifiedAt: verificationRequired ? null : new Date().toISOString(),
      emailVerificationTokenHash: verificationTokenHash,
      emailVerificationTokenExpiresAt: verificationTokenExpiresAt
    });

    if (verificationRequired) {
      const verificationUrl = `${env.apiBaseUrl}/api/auth/verify-email?token=${verificationToken}`;
      let emailResult;
      try {
        emailResult = await sendVerificationEmail({
          to: user.email,
          firstName: user.firstName,
          verificationUrl
        });
      } catch (mailError) {
        await deleteUserById(user.id);
        throw mailError;
      }

      return res.status(201).json({
        ok: true,
        requiresEmailVerification: true,
        message: emailResult?.delivered === false
          ? 'Email service is in console mode. Check the backend terminal for the verification link.'
          : 'Verification email sent',
        user: buildUserPayload(user)
      });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, env.jwtSecret, { expiresIn: '24h' });
    res.status(201).json({ ok: true, token, user: buildUserPayload(user) });
  } catch (error) {
    console.error('Signup error:', error);

    // Keep the response user-friendly if concurrent requests reach the unique constraint.
    if (error?.code === '23505' && error?.constraint === 'users_email_unique') {
      return res.status(400).json({ ok: false, message: 'Email already exists' });
    }

    res.status(500).json({ ok: false, message: 'Internal server error' });
  }
}

async function checkEmailAvailability(req, res) {
  try {
    const email = normalizeEmail(req.query.email || req.body?.email);
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email is required' });
    }

    const existingUser = await findUserByEmail(email);
    return res.json({
      ok: true,
      available: !existingUser,
      message: existingUser ? 'Email already exists' : 'Email is available'
    });
  } catch (error) {
    console.error('Check email availability error:', error);
    return res.status(500).json({ ok: false, message: 'Unable to check email availability' });
  }
}

async function login(req, res) {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');
    if (!username || !password) {
      return res.status(400).json({ ok: false, message: 'Username and password are required' });
    }

    // Admins live in a dedicated table with their own login endpoint
    // (POST /api/auth/admin/login) — this endpoint only ever resolves
    // against users, so an email that also has an admin invite doesn't
    // collide with (or block) that same email's users-table account.
    // The clients label this field as Email, while older accounts may still
    // sign in with their username. Support both identifiers during login.
    const user = await findUserByUsername(username) || await findUserByEmail(username);
    if (!user) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    if (user.active === false) {
      return res.status(403).json({ ok: false, message: 'Account is inactive' });
    }

    if (requiresEmailVerification(user.role) && !user.emailVerifiedAt) {
      return res.status(403).json({ ok: false, message: 'Please verify your email before logging in' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, env.jwtSecret, { expiresIn: '24h' });

    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
    const socketId = req.body.socketId || null;
    try {
      await recordUserLogin({
        userId: user.id,
        username: user.username,
        role: user.role,
        ipAddress,
        socketId
      });
    } catch (loginError) {
      console.error('Failed to record user login:', loginError);
    }

    res.json({ ok: true, token, user: buildUserPayload(user) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ ok: false, message: 'Internal server error' });
  }
}

async function verifyEmail(req, res) {
  try {
    const token = String(req.query.token || req.body.token || '').trim();
    if (!token) {
      return res.status(400).json({ ok: false, message: 'Verification token is required' });
    }

    const user = await findUserByEmailVerificationToken(token);
    if (!user) {
      return res.status(400).send(`
        <html>
          <head>
            <title>Already Verified - BlueMind</title>
          </head>
          <body style="margin:0; padding:0; background-color:#0a1e33; font-family:Arial, Helvetica, sans-serif;">
            <div style="max-width:600px; margin:0 auto; padding:60px 20px; ">
              <div style="background:rgba(15,42,64,0.55); border:1px solid rgba(148,197,214,0.18); border-radius:20px; padding:50px 40px; text-align:center; box-shadow:0 8px 30px rgba(0,0,0,0.35);">
                <!-- Brand -->
                <table role="presentation" align="center" style="margin:0 auto 30px;">
                  <tr>
                    <td style="vertical-align:middle; padding-right:8px;">
                      <span style="display:inline-block; width:26px; height:26px; border:1.5px solid #7dd3c0;
                        border-radius:50%; color:#7dd3c0; font-size:14px; line-height:23px; text-align:center;
                      ">🌐</span>
                    </td>
                    <td style="vertical-align:middle;">
                      <span style="color:#f1f5f9; font-size:18px; font-weight:700; letter-spacing:0.3px;
                      ">BlueMind</span>
                    </td>
                  </tr>
                </table>

                <!-- Info Icon -->
                <div style="width:64px; height:64px; margin:0 auto 26px; border-radius:50%;
                  background:linear-gradient(135deg, rgba(96,165,250,0.25), rgba(59,130,246,0.1));
                  border:1px solid rgba(96,165,250,0.4); line-height:64px; font-size:28px; color:#60a5fa; ">
                  ℹ
                </div>

                <!-- Message -->
                <h1 style=" margin:0 0 12px; font-size:30px; font-weight:600; color:#f8fafc; ">
                  Email <span style="font-style:italic; font-weight:400; color:#60a5fa;">already verified.</span>
                </h1>
                <p style="margin:0 auto 34px; max-width:420px; font-size:15px; line-height:1.6; color:#94a3b8;">
                  Looks like this email was already confirmed. Your <strong style="color:#cbd5e1;">BlueMind</strong> account is active — no further action is needed.
                </p>
              </div>
            </div>
          </body>
          </html>
        `);
    }

    await markUserEmailVerified(user.id);

    return res.status(200).send(`
      <html>
        <head>
          <title>Email Verified - BlueMind</title>
        </head>
        <body style="
          margin:0;
          padding:0;
          background-color:#0a1e33;
          font-family:Arial, Helvetica, sans-serif;
        ">
          <div style="
            max-width:600px;
            margin:0 auto;
            padding:60px 20px;
          ">
            <div style="
              background:rgba(15,42,64,0.55);
              border:1px solid rgba(148,197,214,0.18);
              border-radius:20px;
              padding:50px 40px;
              text-align:center;
              box-shadow:0 8px 30px rgba(0,0,0,0.35);
            ">
              <!-- Brand -->
              <table role="presentation" align="center" style="margin:0 auto 30px;">
                <tr>
                  <td style="vertical-align:middle; padding-right:8px;">
                    <span style="
                      display:inline-block;
                      width:26px;
                      height:26px;
                      border:1.5px solid #7dd3c0;
                      border-radius:50%;
                      color:#7dd3c0;
                      font-size:14px;
                      line-height:23px;
                      text-align:center;
                    ">🌐</span>
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="
                      color:#f1f5f9;
                      font-size:18px;
                      font-weight:700;
                      letter-spacing:0.3px;
                    ">BlueMind</span>
                  </td>
                </tr>
              </table>

              <!-- Success Icon -->
              <div style="
                width:64px;
                height:64px;
                margin:0 auto 26px;
                border-radius:50%;
                background:linear-gradient(135deg, rgba(94,234,212,0.25), rgba(45,212,191,0.1));
                border:1px solid rgba(94,234,212,0.4);
                line-height:64px;
                font-size:30px;
                color:#5eead4;
              ">
                ✓
              </div>

              <!-- Success Message -->
              <h1 style="
                margin:0 0 12px;
                font-size:30px;
                font-weight:600;
                color:#f8fafc;
              ">
                Email Verified <span style="font-style:italic; font-weight:400; color:#5eead4;">successfully.</span>
              </h1>
              <p style="
                margin:0 auto 34px;
                max-width:420px;
                font-size:15px;
                line-height:1.6;
                color:#94a3b8;
              ">
                Your <strong style="color:#cbd5e1;">BlueMind</strong> account is now active and ready to use.
              </p>
              <!-- Login CTA -->
                <table role="presentation" align="center" style="margin:0 auto;">
                  <tr>
                    <td style="
                      background:linear-gradient(90deg, #2dd4bf, #5eead4);
                      border-radius:10px;
                    ">
                      <a href="https://bluemind-web.vercel.app/login" style="
                        display:inline-block;
                        padding:14px 36px;
                        font-size:14px;
                        font-weight:700;
                        letter-spacing:0.5px;
                        color:#062a29;
                        text-decoration:none;
                      ">
                        CONTINUE TO LOGIN &nbsp;&#8594;
                      </a>
                    </td>
                  </tr>
                </table>
            </div>
          </div>
        </body>
        </html>
    `);
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ ok: false, message: 'Failed to verify email' });
  }
}

async function requestPasswordReset(req, res) {
  try {
    const email = normalizeEmail(req.body.email || req.query.email);
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email is required' });
    }

    const user = await findUserByEmail(email);
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS).toISOString();

      await setUserPasswordResetToken(user.id, {
        tokenHash: hashToken(resetToken),
        expiresAt: resetTokenExpiresAt
      });

      const resetUrl = `${env.apiBaseUrl}/api/auth/reset-password?token=${resetToken}`;
      try {
        await sendPasswordResetEmail({
          to: user.email,
          firstName: user.firstName,
          resetUrl
        });
      } catch (mailError) {
        console.error('Password reset email error:', mailError);
        try {
          await clearUserPasswordResetToken(user.id);
        } catch (clearError) {
          console.error('Failed to clear password reset token after email error:', clearError);
        }
      }
    }

    return res.json({
      ok: true,
      message: 'If that email exists, we sent a reset link'
    });
  } catch (error) {
    console.error('Request password reset error:', error);
    return res.status(500).json({ ok: false, message: 'Unable to process password reset request' });
  }
}

async function renderPasswordResetPage(req, res) {
  try {
    const body = req.body || {};
    const token = String(req.query.token || body.token || '').trim();
    if (!token) {
      return res.status(400).send(renderPasswordResetNoticePage());
    }

    const user = await findUserByPasswordResetToken(token);
    if (!user) {
      return res.status(400).send(renderPasswordResetNoticePage());
    }

    return res.status(200).send(renderPasswordResetFormPage({ token }));
  } catch (error) {
    console.error('Render password reset page error:', error);
    return res.status(500).send(renderPasswordResetNoticePage());
  }
}

async function completePasswordReset(req, res) {
  try {
    const body = req.body || {};
    const token = String(body.token || req.query.token || '').trim();
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');

    if (!token) {
      return res.status(400).send(renderPasswordResetNoticePage());
    }

    const user = await findUserByPasswordResetToken(token);
    if (!user) {
      return res.status(400).send(renderPasswordResetNoticePage());
    }

    if (!password || !confirmPassword) {
      return res.status(400).send(renderPasswordResetFormPage({
        token,
        error: 'Please enter and confirm your new password.'
      }));
    }

    if (password !== confirmPassword) {
      return res.status(400).send(renderPasswordResetFormPage({
        token,
        error: 'Passwords do not match. Please try again.'
      }));
    }

    if (password.length < 8) {
      return res.status(400).send(renderPasswordResetFormPage({
        token,
        error: 'Please use at least 8 characters for your new password.'
      }));
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await updateUserPassword(user.id, hashedPassword);
    await clearUserPasswordResetToken(user.id);

    return res.status(200).send(renderPasswordResetSuccessPage());
  } catch (error) {
    console.error('Complete password reset error:', error);
    return res.status(500).send(renderPasswordResetNoticePage());
  }
}

async function adminLogin(req, res) {
  try {
    const email = normalizeEmail(req.body.username || req.body.email);
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ ok: false, message: 'Email and password are required' });
    }

    const admin = await findAdminByEmail(email);
    if (!admin) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    if (admin.active === false) {
      return res.status(403).json({ ok: false, message: 'Account is inactive' });
    }

    if (!admin.password) {
      return res.status(403).json({ ok: false, message: 'Please set your password using the invite link sent to your email' });
    }

    const isValid = await bcrypt.compare(password, admin.password);
    if (!isValid) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: admin.id, role: 'admin' }, env.jwtSecret, { expiresIn: '24h' });
    res.json({ ok: true, token, user: buildAdminPayload(admin) });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ ok: false, message: 'Internal server error' });
  }
}

async function validateInviteToken(req, res) {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) {
      return res.status(400).json({ ok: false, message: 'Invite token is required' });
    }

    const admin = await findAdminByInviteToken(token);
    if (!admin) {
      return res.status(400).json({ ok: false, message: 'This invite link is invalid or has expired' });
    }

    res.json({ ok: true, email: admin.email, firstName: admin.firstName });
  } catch (error) {
    console.error('Validate invite token error:', error);
    res.status(500).json({ ok: false, message: 'Unable to validate invite link' });
  }
}

async function setPassword(req, res) {
  try {
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!token) {
      return res.status(400).json({ ok: false, message: 'Invite token is required' });
    }

    const admin = await findAdminByInviteToken(token);
    if (!admin) {
      return res.status(400).json({ ok: false, message: 'This invite link is invalid or has expired' });
    }

    if (!password || !confirmPassword) {
      return res.status(400).json({ ok: false, message: 'Please enter and confirm your password' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ ok: false, message: 'Passwords do not match' });
    }

    if (password.length < 8) {
      return res.status(400).json({ ok: false, message: 'Please use at least 8 characters for your password' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await setAdminPassword(admin.id, hashedPassword);

    res.json({ ok: true, message: 'Password set successfully' });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ ok: false, message: 'Unable to set password' });
  }
}

async function verify(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.jwtSecret);

    if (decoded.role === 'admin') {
      const admin = await findAdminById(decoded.id);
      if (!admin) {
        return res.status(401).json({ ok: false, message: 'User not found' });
      }
      return res.json({ ok: true, user: buildAdminPayload(admin) });
    }

    const user = await findUserById(decoded.id);

    if (!user) {
      return res.status(401).json({ ok: false, message: 'User not found' });
    }

    res.json({ ok: true, user: buildUserPayload(user) });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(401).json({ ok: false, message: 'Invalid token' });
  }
}

async function logout(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.jwtSecret);

    await deleteUserLoginRecords(decoded.id);

    res.json({ ok: true, message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ ok: false, message: 'Failed to process logout' });
  }
}

async function updateProfile(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.jwtSecret);

    const profileData = {
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      jobTitle: req.body.jobTitle,
      yearsExperience: req.body.yearsExperience,
      profileImageUrl: req.body.profileImageUrl
    };

    const user = await updateUserProfile(decoded.id, profileData);
    if (!user) {
      return res.status(404).json({ ok: false, message: 'User not found' });
    }

    res.json({ 
      ok: true, 
      user: { 
        ...buildUserPayload(user)
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ ok: false, message: 'Failed to update profile' });
  }
}

export default {
  signup: asyncHandler(signup),
  checkEmailAvailability: asyncHandler(checkEmailAvailability),
  login: asyncHandler(login),
  adminLogin: asyncHandler(adminLogin),
  verify: asyncHandler(verify),
  verifyEmail: asyncHandler(verifyEmail),
  requestPasswordReset: asyncHandler(requestPasswordReset),
  renderPasswordResetPage: asyncHandler(renderPasswordResetPage),
  completePasswordReset: asyncHandler(completePasswordReset),
  validateInviteToken: asyncHandler(validateInviteToken),
  setPassword: asyncHandler(setPassword),
  logout: asyncHandler(logout),
  updateProfile: asyncHandler(updateProfile)
};
