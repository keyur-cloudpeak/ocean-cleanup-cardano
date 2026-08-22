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
      try {
        await sendVerificationEmail({
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
        message: 'Verification email sent',
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

    const verifiedUser = await markUserEmailVerified(user.id);
    return res.json({
      ok: true,
      message: 'Email verified successfully',
      user: buildUserPayload(verifiedUser)
    });
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

export default { signup, login, verify, verifyEmail, logout, updateProfile };
