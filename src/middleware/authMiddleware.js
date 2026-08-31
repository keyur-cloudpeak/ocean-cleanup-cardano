import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, message: 'Invalid token' });
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
