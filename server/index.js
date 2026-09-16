require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { initDb, closeDb, DATA_DIR } = require('./db');

const authRoutes     = require('./routes/auth');
const oidcRoutes     = require('./routes/oidc');
const settingsRoutes = require('./routes/settings');
const booksRoutes    = require('./routes/books');
const progressRoutes = require('./routes/progress');
const fontsRoutes    = require('./routes/fonts');
const { kosyncRouter, proxyRouter } = require('./routes/kosync');
const opdsRoutes       = require('./routes/opds');
const dictionaryRoutes = require('./routes/dictionary');
const shelvesRoutes    = require('./routes/shelves');
const bookmarksRoutes    = require('./routes/bookmarks');
const annotationsRoutes  = require('./routes/annotations');
const statsRoutes        = require('./routes/stats');
const bookorbitRoutes    = require('./routes/bookorbit');
const bookorbitSync      = require('./services/bookorbitSync');
const { installConsolePrefix } = require('./utils/logger');

// Prefix every log line with a local timestamp + the current user (when known).
installConsolePrefix();

// Last-resort safety net. Without this, ANY unhandled error anywhere in the app (a stray
// write to a socket the client already closed, a rejected promise nobody attached a .catch
// to, etc.) crashes this entire process — and since this process is the whole container,
// that means every user's session dies too, not just the one request that went wrong.
// Confirmed live cause of a real "container exited with code 132" crash: /api/bookorbit's
// import-sse route (server/routes/bookorbit.js) writing an SSE progress event to a response
// whose client had already disconnected, with nothing listening for the resulting error.
// That specific case is now also fixed at the source (req.on('close') there), but this stays
// as the backstop for the next unforeseen one — log loudly and keep serving everyone else,
// rather than let one bad request take the whole app down.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException (process kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection (process kept alive):', reason);
});

const app  = express();
const PORT = process.env.PORT || 3000;
const { version } = require('../package.json');

const DIST_DIR   = path.join(__dirname, '../dist');
const PUBLIC_DIR = path.join(__dirname, '../public');
const SERVE_DIR  = fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : PUBLIC_DIR;

// ── Startup ──────────────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 64) {
  console.error('[fatal] JWT_SECRET is missing or too short (must be ≥64 chars). Set it in .env');
  process.exit(1);
}

initDb();

// ── Registration policy override (optional) ───────────────────────────────────
// Self-service registration is otherwise always open on a brand-new instance, and the FIRST
// account created becomes the admin (server/routes/auth.js's isAdmin() = lowest user id). On a
// publicly reachable deploy that is a land-grab race: whoever registers first owns the instance,
// and after that anyone on the internet can still create accounts until the admin happens to
// toggle it off in the UI. Setting REGISTRATION_ENABLED=false pins the stored policy closed on
// every boot, so the window can be shut from the deployment config instead of from the UI.
// Unset = leave whatever the admin toggle stored (previous behavior, unchanged).
if (process.env.REGISTRATION_ENABLED === 'false' || process.env.REGISTRATION_ENABLED === 'true') {
  const enabled = process.env.REGISTRATION_ENABLED === 'true' ? '1' : '0';
  try {
    require('./db').getDb()
      .prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('registration_enabled', ?)")
      .run(enabled);
    console.log(`[server] REGISTRATION_ENABLED=${process.env.REGISTRATION_ENABLED} enforced from env`);
  } catch (err) {
    console.warn('[server] could not apply REGISTRATION_ENABLED:', err.message);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
// Trust the first proxy hop (nginx/traefik/etc.) so express-rate-limit can
// read the real client IP from X-Forwarded-For correctly.
app.set('trust proxy', 1);

// Gzip every response (JS/CSS/HTML/JSON) — nothing was compressing these before, so every asset
// (main.css, reader.js, etc.) was going out over the wire at full size on every request.
// Placed before static/route handlers so it wraps all of them; a reverse proxy in front (see
// README's "Self-Hosting Behind a Reverse Proxy") may also compress, which is harmless — this
// just guarantees it happens even for users running Codexa directly with no proxy at all.
//
// EXCEPT text/event-stream: the `compressible` mime lookup this package uses under the hood
// actually says SSE is compressible, so without this override every SSE route (BookOrbit/OPDS
// sync progress, the "Add to Codexa" download-progress bar) gets silently wrapped in a gzip
// Transform stream that buffers output until enough has accumulated — the client saw nothing
// but 0% for the whole download, then got the final result all at once. Worse, on a long enough
// gap with zero bytes actually reaching the browser, EventSource's own auto-reconnect kicked in
// and re-ran the entire import from scratch, downloading (and re-inserting) the same book twice.
// compression()'s own default filter is otherwise fine — only override the one content-type.
app.use(compression({
  filter: (req, res) => {
    // Express's res.set('Content-Type', 'text/event-stream') auto-appends "; charset=utf-8",
    // so this has to be a prefix check, not strict equality (confirmed live — a strict === here
    // silently never matched and gzip kept right on buffering the SSE stream).
    if (String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

// A wildcard CORS origin is fine on a LAN box and actively dangerous once this is reachable
// from the open internet: it invites every website a logged-in user visits to read this API's
// responses cross-origin. `credentials: true` alongside it is also a combination browsers
// reject outright, so it never did what it looked like it did. Refuse to boot on it in
// production; in dev, allow it but drop credentials so the semantics are honest.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (CORS_ORIGINS.includes('*')) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[fatal] CORS_ORIGIN="*" is not allowed in production. List explicit origins ' +
                  '(comma-separated, e.g. https://books.example.com), or leave it blank for same-origin only.');
    process.exit(1);
  }
  console.warn('[cors] CORS_ORIGIN="*" — any origin allowed (dev only), credentials disabled');
  app.use(cors({ origin: '*', credentials: false }));
} else if (CORS_ORIGINS.length) {
  app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
}
// Explicit body caps on both parsers — an unbounded (or default-but-unstated) limit is a free
// memory-exhaustion DoS for any anonymous caller once this is publicly reachable.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ── Rate limiting (global API floor) ──────────────────────────────────────────
// server/routes/auth.js already puts a tight per-IP limiter on login/register/OIDC. This is the
// floor under everything else: without it, every other endpoint — BookOrbit imports, EPUB
// parsing, search proxying, book downloads — is an unmetered, anonymous-reachable resource on a
// public deploy. Deliberately generous (well above what any real reading session produces) so it
// only ever bites automated abuse. Keyed on the real client IP, which works because of the
// numeric `trust proxy` hop count set above.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  // Plain prose, not an i18n key: there is no locale entry for this, and the nearest one
  // ('error.too_many_attempts') promises a 15-minute wait that does not match this window.
  // public/js/api.js renders an unknown body.error verbatim, so this shows up correctly.
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});
app.use('/api', apiLimiter);

// ── Baseline security headers (every response) ─────────────────────────────────
// The heavier, nonce-bearing Content-Security-Policy is set per-HTML-page below (it needs a
// fresh nonce per request); these three are cheap, meaningful on every response type (not just
// HTML), and never need per-request state.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');           // blocks MIME-sniffing a served file into something executable
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');                // legacy clickjacking guard, belt-and-suspenders with frame-ancestors below
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // HSTS, but only on a request that actually arrived over TLS (req.secure reads
  // X-Forwarded-Proto, which is trustworthy here because of the `trust proxy` hop count above).
  // Gating on req.secure rather than NODE_ENV means a plain-HTTP LAN/dev instance never pins
  // itself to https:// in the browser's HSTS store, while a public HTTPS deploy always does.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── Browser-friendly module fallback for vendored Flow imports
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (path.extname(req.path)) return next();

  const publicDir = SERVE_DIR;

  if (req.path.startsWith('/js/flow/')) {
    const filePath = path.join(publicDir, `${req.path}.js`);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }

    const indexPath = path.join(publicDir, req.path, 'index.js');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
  }

  if (req.path.startsWith('/js/utils/')) {
    const rewritten = `/js/flow${req.path.slice('/js'.length)}`;
    const filePath = path.join(publicDir, `${rewritten}.js`);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    const indexPath = path.join(publicDir, rewritten, 'index.js');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
  }

  if (req.path === '/js/mapping') {
    const filePath = path.join(publicDir, 'js/flow/mapping.js');
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }

  next();
});

// ── Debug flag injection + per-page Content-Security-Policy ────────────────────
// Injects the DEBUG flag into HTML files (window.__DEBUG) and sw.js (__DEBUG).
// Set DEBUG=true in .env to enable verbose frontend console logging.
const CLIENT_DEBUG = process.env.DEBUG === 'true';
const _swSnippet   = `const __DEBUG=${CLIENT_DEBUG};\n`;

// Matches every <script> tag that has no src= attribute — i.e. every inline script block in
// our own HTML shells (a handful of small first-party snippets per page: the anti-FOUC
// visibility toggle, feature detection, the debug flag, etc.) so each can be tagged with the
// per-request nonce below. <script src="..."> tags are left alone — same-origin script FILES
// are already covered by script-src 'self', nonce or not.
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>/gi;

// Every external origin this app's own pages legitimately talk to. Everything else (including
// book content, rendered separately into a sandboxed iframe — see cxreader/renderer.js's
// _sanitizeDoc for that side of the defense) has no reason to run script, load a stylesheet
// from, or connect out to anywhere but this server itself.
const GITHUB_API = 'https://api.github.com';

function buildCsp(nonce) {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    // Inline STYLE is left permissive: reader themes/fonts are applied via JS-created <style>
    // elements with no server-issued nonce to give them, and CSS-only injection is a far
    // narrower, lower-value attack surface than script — not worth the functional risk here.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data: blob:`,
    `media-src 'self' blob:`,   // some EPUBs embed <audio>/<video>, rewritten to blob: URLs too
    // blob: is required here (not just in frame-src below): the EPUB/CBZ parser fetch()es
    // each resource — chapter HTML, images, stylesheets — from blob: URLs it created via
    // URL.createObjectURL, from the top-level page's own JS, not from inside the book iframe.
    `connect-src 'self' blob: ${GITHUB_API}`,
    `frame-src 'self' blob:`,   // book content renders into a blob: iframe (cxreader/renderer.js)
    `worker-src 'self'`,        // pdf.js's worker is a same-origin vendored file
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
  ].join('; ');
}

app.use((req, res, next) => {
  // express.static resolves a bare directory request ("/") to its index.html itself, which
  // would otherwise skip this middleware entirely (req.path stays "/", which is neither
  // *.html nor /sw.js below) — meaning the app's actual entry page would ship with no CSP
  // and no debug-flag injection. Map it to the real file explicitly instead.
  const reqPath  = req.path.endsWith('/') ? req.path + 'index.html' : req.path;
  const filePath = path.resolve(SERVE_DIR, '.' + reqPath);
  // The containment check has to include the trailing separator: a bare startsWith(SERVE_DIR)
  // is a string prefix test, not a path test, so with SERVE_DIR = <root>/public a request for
  // "/../public_notes/x.html" resolves to <root>/public_notes/x.html — which passes a plain
  // prefix check and would be read off disk and served. Comparing against SERVE_DIR + sep makes
  // it a real "is inside this directory" test.
  if (!filePath.startsWith(SERVE_DIR + path.sep) || !fs.existsSync(filePath)) return next();

  if (reqPath.endsWith('.html')) {
    const nonce = crypto.randomBytes(16).toString('base64');
    // Insert the debug snippet plain (no nonce of its own) — the blanket replace just below
    // tags EVERY inline script, this one included, exactly once, from one code path.
    let html = fs.readFileSync(filePath, 'utf8')
      .replace('<head>', `<head>\n  <script>window.__DEBUG=${CLIENT_DEBUG};</script>`);
    html = html.replace(INLINE_SCRIPT_RE, (_m, attrs) => `<script nonce="${nonce}"${attrs}>`);
    res.setHeader('Content-Security-Policy', buildCsp(nonce));
    return res.type('html').send(html);
  }
  if (reqPath === '/sw.js') {
    const js = fs.readFileSync(filePath, 'utf8');
    return res.type('js').send(_swSnippet + js);
  }
  next();
});

// ── Static files ──────────────────────────────────────────────────────────────
// dotfiles: 'deny' — express.static's default ('ignore') merely falls through, which lands on
// the SPA/404 handling below instead of refusing outright; 'deny' is the explicit answer for
// anything like a stray .env/.git dropped into a served directory. index: false on the DATA_DIR
// mounts so a request for the bare directory can never resolve to an uploaded file named
// index.html. These are user-writable directories (covers are extracted from uploaded books,
// fonts are uploaded outright), so they get the stricter treatment.
app.use(express.static(SERVE_DIR, { dotfiles: 'deny' }));
// Expose extracted covers and user-uploaded fonts to the browser.
// The nonce-CSP middleware above only fires for paths that resolve to a file under SERVE_DIR, so
// these two mounts would otherwise be served with no CSP at all. They hold the only bytes on disk
// that originate from an uploaded file, so they get their own locked-down headers: "sandbox" and
// "default-src 'none'" mean that even if something executable did land here, navigating straight
// to it yields an opaque origin that can't reach the API or read this origin's localStorage (where
// the JWT lives), and nosniff stops a mislabelled image being re-interpreted as HTML. This is
// defence-in-depth behind the magic-byte check in utils/epub.js, not a substitute for it.
const untrustedAssetHeaders = (res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
};
app.use('/covers',     express.static(path.join(DATA_DIR, 'covers'), { dotfiles: 'deny', index: false, setHeaders: untrustedAssetHeaders }));
app.use('/user-fonts', express.static(path.join(DATA_DIR, 'fonts'),  { dotfiles: 'deny', index: false, setHeaders: untrustedAssetHeaders }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/auth/oidc', oidcRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/books',    booksRoutes);
app.use('/api/shelves',  shelvesRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/fonts',    fontsRoutes);
app.use('/api/kosync',     proxyRouter);   // JWT-protected proxy to external server
app.use('/api/opds',       opdsRoutes);
app.use('/api/dictionary', dictionaryRoutes);
app.use('/api/bookmarks',    bookmarksRoutes);
app.use('/api/annotations',  annotationsRoutes);
app.use('/api/stats',        statsRoutes);
app.use('/api/bookorbit',    bookorbitRoutes);

// KOReader kosync protocol — must be AFTER /api routes to avoid shadowing
// KOReader devices point their sync settings to this server's base URL.
app.use(kosyncRouter);

// ── Public metadata ─────────────────────────────────────────────────────────
app.get('/api/version', (_req, res) => res.json({ version }));

// ── 404 for unknown /api/* paths ──────────────────────────────────────────────
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Full detail (including the stack) stays in the server log; the client only ever gets the
  // generic string — an error message echoed back verbatim is how absolute filesystem paths,
  // internal hostnames and SQL fragments leak to an anonymous caller.
  console.error('[error]', err.stack || err.message);
  // Once headers are on the wire (every SSE route here writes them immediately) there is no
  // status left to set — handing it back to Express lets it destroy the socket instead of
  // throwing ERR_HTTP_HEADERS_SENT out of the error handler itself.
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[server] Codexa running on http://localhost:${PORT}`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
// Without this, SIGTERM (every `docker stop`/restart) kills the process immediately —
// better-sqlite3 never gets to checkpoint its WAL file, which has been implicated in
// native-addon crashes (Assertion failed in RemoveEnvironmentCleanupHook) on the next start.
// server.close() alone isn't enough to bound the wait: opds.js and bookorbit.js hold
// long-lived SSE connections open that it would otherwise wait on indefinitely, so a
// force-exit timer backs it up — either way, closeDb() runs before the process actually exits.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down...`);

  const forceExitTimer = setTimeout(() => {
    console.warn('[server] shutdown timed out waiting for connections to drain, forcing exit');
    closeDb();
    process.exit(1);
  }, 5000);

  server.close(() => {
    clearTimeout(forceExitTimer);
    closeDb();
    console.log('[server] shutdown complete');
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── BookOrbit extended sync — periodic background reconcile ───────────────────
// Event-driven triggers (on highlight/session/status change) sync just the
// affected book promptly. This loop is the only FULL sweep — it backfills
// server-side / other-device changes for every opted-in user, so it runs
// infrequently and paces its requests. No-op for users without sync enabled.
const { getDb } = require('./db');
const BOOKORBIT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
// Stagger each user's full sweep instead of firing them all in the same tick — every
// opted-in user hitting BookOrbit at once (each doing several requests per book) was enough
// concurrent load to trip 502s on BookOrbit's own end (seen in its logs as a failed
// match-check right as the burst starts) and to slow down Codexa's own page loads while the
// sweep was in flight. Spreading starts out over the interval keeps the same total work but
// avoids the concurrent spike.
const BOOKORBIT_SYNC_STAGGER_MS = 45 * 1000;
setInterval(() => {
  let users;
  try {
    users = getDb().prepare('SELECT user_id FROM user_settings WHERE bookorbit_sync_enabled = 1').all();
  } catch { return; }
  users.forEach((u, i) => {
    setTimeout(() => bookorbitSync.triggerSync(u.user_id), i * BOOKORBIT_SYNC_STAGGER_MS).unref();
  });
}, BOOKORBIT_SYNC_INTERVAL_MS).unref();

// ── Ephemeral "peek" book cleanup — background sweep ──────────────────────────
// The reader signals a clean close via POST /api/books/:id/peek-cleanup (best-effort), but a
// forced close/crash can't be trusted to fire that. This sweep is the actual guarantee: any
// ephemeral peek row (+ its temp file) past its expiry gets reclaimed regardless.
const { sweepExpiredPeeks } = require('./utils/peekCleanup');
const PEEK_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
sweepExpiredPeeks(); // reclaim anything already expired across a restart
setInterval(sweepExpiredPeeks, PEEK_SWEEP_INTERVAL_MS).unref();
