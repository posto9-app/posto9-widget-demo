// Acme Success Hub: a demo portal with the Posto9 chat widget embedded.
//
// It plays the part of YOUR portal's backend:
//   - a (demo) sign-in that puts the signed-in CSM in a session cookie,
//   - the token endpoint the widget calls: it signs a short-lived Posto9 token
//     for the CSM in the session, never for an email the browser sends.
//
// No dependencies: Node 18+ only. Configure it with a .env file (see .env.example).

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────────────────────

function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const POSTO9_URL = required('POSTO9_URL').replace(/\/+$/, '');
const WIDGET_ID = required('POSTO9_WIDGET_ID');
const WIDGET_SECRET = required('POSTO9_WIDGET_SECRET');
const PORT = Number(process.env.PORT || 3000);

// DEMO_USERS: "Sarah Chen <sarah@yourcompany.com>, Michael Ross <michael@yourcompany.com>"
const DEMO_USERS = required('DEMO_USERS')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const m = entry.match(/^(.*?)\s*<\s*([^>]+)\s*>$/);
    return m ? { name: m[1] || m[2], email: m[2] } : { name: entry, email: entry };
  });

// Signs the session cookie, so a browser cannot edit it into someone else.
// A fresh key per process: restarting the server signs everyone out.
const SESSION_KEY = randomBytes(32);

// ── The Posto9 token (docs/SETUP_GUIDE.md, Step 3) ──────────────────────────

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function posto9WidgetToken({ email, customer }) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'HS256', typ: 'JWT', kid: WIDGET_ID });
  const body = b64url({
    email,
    ...(customer ? { customer } : {}),
    iat: now,
    exp: now + 300, // 5 minutes; Posto9 accepts at most 10
    jti: randomUUID(), // a token works once
  });
  const sig = createHmac('sha256', WIDGET_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// ── Demo session ─────────────────────────────────────────────────────────────

function sign(value) {
  return createHmac('sha256', SESSION_KEY).update(value).digest('base64url');
}

function sessionUser(req) {
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('demo_session='));
  if (!cookie) return null;
  const [email64, mac] = cookie.slice('demo_session='.length).split('.');
  if (!email64 || !mac) return null;
  const expected = Buffer.from(sign(email64));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const email = Buffer.from(email64, 'base64url').toString();
  return DEMO_USERS.find((u) => u.email === email) || null;
}

function sessionCookie(email) {
  const email64 = Buffer.from(email).toString('base64url');
  return `demo_session=${email64}.${sign(email64)}; HttpOnly; SameSite=Lax; Path=/`;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function send(res, status, body, type = 'application/json', headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const page = () => readFileSync(join(ROOT, 'public', 'index.html'), 'utf8').replaceAll('__POSTO9_URL__', POSTO9_URL);
const accounts = () => JSON.parse(readFileSync(join(ROOT, 'data', 'accounts.json'), 'utf8'));

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const user = sessionUser(req);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, page(), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/api/session') {
    return send(res, 200, { user, users: DEMO_USERS });
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { email } = await readJson(req);
    const match = DEMO_USERS.find((u) => u.email === email);
    if (!match) return send(res, 403, { error: 'not a demo user' });
    return send(res, 200, { user: match }, 'application/json', { 'Set-Cookie': sessionCookie(match.email) });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'demo_session=; Max-Age=0; Path=/' });
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    if (!user) return send(res, 401, { error: 'sign in first' });
    return send(res, 200, accounts());
  }
  if (req.method === 'GET' && url.pathname === '/api/posto9-token') {
    // The CSM comes from the session. The only thing taken from the browser is the
    // account on screen, which the widget passes as `customer`.
    if (!user) return send(res, 401, 'sign in first', 'text/plain');
    const customer = url.searchParams.get('customer') || '';
    return send(res, 200, posto9WidgetToken({ email: user.email, customer }), 'text/plain');
  }
  send(res, 404, 'not found', 'text/plain');
}).listen(PORT, () => {
  console.log(`Acme Success Hub on http://localhost:${PORT}`);
  console.log(`Posto9 widget from ${POSTO9_URL}, demo users: ${DEMO_USERS.map((u) => u.email).join(', ')}`);
});
