import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { findUserByUsername, findUserByEmail, createUser, findUserById, recordUserLogin, deleteUserLoginRecords, setUserWalletAddress } from '../services/userService.js';

// Bech32 Cardano address prefixes we accept: mainnet (addr1) and
// testnets/Preprod/Preview (addr_test1). Stake addresses aren't valid here.
const CARDANO_ADDRESS_PATTERN = /^(addr1|addr_test1)[a-z0-9]+$/;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function signup(req, res) {
  try {
    const firstName = String(req.body.firstName || '').trim();
    const lastName = String(req.body.lastName || '').trim();
    const email = normalizeEmail(req.body.email);
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');
    const role = String(req.body.role || '').trim();
    const organizationId = req.body.organizationId || null;

    if (!firstName || !lastName || !email || !username || !password || !role) {
      return res.status(400).json({ ok: false, message: 'All fields are required' });
    }

    const validRoles = ['admin', 'contributor', 'verifier'];
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
    const user = await createUser({ firstName, lastName, email, username, password: hashedPassword, role, organizationId });

    const token = jwt.sign({ id: user.id, role: user.role }, env.jwtSecret, { expiresIn: '24h' });
    res.json({ ok: true, token, user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, role: user.role, organizationId: user.organizationId, walletAddress: user.walletAddress } });
  } catch (error) {
    console.error('Signup error:', error);
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

    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    if (user.active === false) {
      return res.status(403).json({ ok: false, message: 'Account is inactive' });
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

    res.json({ ok: true, token, user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, role: user.role, organizationId: user.organizationId, walletAddress: user.walletAddress } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ ok: false, message: 'Internal server error' });
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

    res.json({ ok: true, user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, role: user.role, organizationId: user.organizationId, walletAddress: user.walletAddress } });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(401).json({ ok: false, message: 'Invalid token' });
  }
}

async function updateWallet(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.jwtSecret);

    const walletAddress = String(req.body.walletAddress || '').trim();
    if (!walletAddress || !CARDANO_ADDRESS_PATTERN.test(walletAddress)) {
      return res.status(400).json({ ok: false, message: 'A valid Cardano address is required' });
    }

    const user = await setUserWalletAddress(decoded.id, walletAddress);
    if (!user) {
      return res.status(404).json({ ok: false, message: 'User not found' });
    }

    res.json({ ok: true, user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, role: user.role, organizationId: user.organizationId, walletAddress: user.walletAddress } });
  } catch (error) {
    console.error('Update wallet error:', error);
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

export default { signup, login, verify, logout, updateWallet };
