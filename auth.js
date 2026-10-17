// Host authentication: bcrypt passwords and a JWT stored in an httpOnly cookie.
// The same cookie authenticates page requests, API calls and the host's Socket.io connection.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'qe_token';
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const IS_PROD = process.env.NODE_ENV === 'production';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PROD) {
    console.error('\n  JWT_SECRET is not set. Add it to the environment (e.g. Render > Environment) and restart.\n');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('  JWT_SECRET is not set; using a random secret for this run (logins reset on restart).');
}

const hashPassword = (plain) => bcrypt.hash(plain, 10);
const checkPassword = (plain, hash) => bcrypt.compare(plain, hash);

function signToken(user) {
  return jwt.sign({ sub: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns { id, email } for a logged-in host, or null.
function userFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE_NAME];
  return token ? verifyToken(token) : null;
}

function setAuthCookie(res, user) {
  res.cookie(COOKIE_NAME, signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/' });
}

// Express middleware. Pages redirect to /login; API routes answer 401.
function requireAuth({ api = false } = {}) {
  return (req, res, next) => {
    const user = userFromCookieHeader(req.headers.cookie);
    if (user) {
      req.user = user;
      return next();
    }
    if (api) return res.status(401).json({ error: 'Please log in.' });
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  };
}

module.exports = { hashPassword, checkPassword, setAuthCookie, clearAuthCookie, userFromCookieHeader, requireAuth };
