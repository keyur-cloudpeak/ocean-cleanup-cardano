import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { findUserById } from '../services/userService.js';
import { findAdminById } from '../services/adminService.js';

// The JWT only proves who signed in; role and active state are read from the
// database on every request so a deactivated account or a changed role takes
// effect immediately instead of when the 24h token expires. Admins normally
// live in `admins`, but legacy admin accounts are still rows in `users`.
async function resolveAccount(decoded) {
  if (decoded.role === 'admin') {
    const admin = await findAdminById(decoded.id);
    if (admin) return { role: 'admin', active: admin.active };
  }

  const user = await findUserById(decoded.id);
  return user ? { role: user.role, active: user.active } : null;
}

export async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }

  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], env.jwtSecret);
  } catch (error) {
    return res.status(401).json({ ok: false, message: 'Invalid token' });
  }

  try {
    const account = await resolveAccount(decoded);
    if (!account) {
      return res.status(401).json({ ok: false, message: 'User not found' });
    }
    if (account.active === false) {
      return res.status(403).json({ ok: false, message: 'Account is inactive' });
    }

    req.user = { ...decoded, role: account.role };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * attachUserIfPresent — decodes a token when one is supplied, and carries
 * on regardless when it isn't. For routes that are legitimately reachable
 * both signed-in and signed-out and want to behave differently for each:
 * creating an organization happens both from signup (no token yet) and
 * from the submit form (token present, and the creator should be enrolled
 * as a member). An invalid token is ignored rather than rejected — this
 * middleware grants nothing on its own, so the route simply proceeds as
 * anonymous.
 */
export function attachUserIfPresent(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], env.jwtSecret);
    } catch {
      // Anonymous — deliberately not a 401 on a route that allows it.
    }
  }
  next();
}

export function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }
    next();
  };
}

// Guards routes that need a resolved req.user.id beyond just "is this token
// valid" (authenticate already covers that) — used where a handler would
// otherwise repeat `if (!req.user?.id) return res.status(401)...` itself.
export function requireAuthenticatedUser(req, res, next) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}
