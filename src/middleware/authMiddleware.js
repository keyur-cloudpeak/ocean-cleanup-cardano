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
