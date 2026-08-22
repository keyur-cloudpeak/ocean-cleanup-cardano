import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { sendVerificationEmail } from '../services/emailService.js';
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
  deleteUserById
} from '../services/userService.js';
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
      return res.status(400).json({ ok: false, message: 'Invalid or expired verification token' });
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

async function verify(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.jwtSecret);
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
  verify: asyncHandler(verify),
  verifyEmail: asyncHandler(verifyEmail),
  logout: asyncHandler(logout),
  updateProfile: asyncHandler(updateProfile)
};
