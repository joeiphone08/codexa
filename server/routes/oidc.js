const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { generators } = require('openid-client');
const { getDb } = require('../db');
const { getClient, listAvailableProviders, providerConfig } = require('../oidcProviders');
const { signToken, isValidUsername, normalizeEmail, isRegistrationEnabled, SALT_ROUNDS, authLimiter } = require('./auth');

const router = express.Router();

// No server-side session store exists in this app (JWT + localStorage only, see api.js),
// so instead of stashing the PKCE code_verifier server-side between /start and /callback,
// it's packed into a short-lived signed JWT and round-tripped through the provider as the
// `state` param itself — nothing new to store or clean up, consistent with the rest of the app.
function signState(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '5m' });
}
function verifyState(state) {
  // algorithms pinned, same reasoning as server/middleware/auth.js.
  return jwt.verify(state, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}

function deriveUsername(claims) {
  const raw = (claims.preferred_username || (claims.email || '').split('@')[0] || claims.name || 'user')
    .toString().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  return raw.length >= 3 ? raw : `user_${raw}`.slice(0, 32);
}

function uniqueUsername(db, base) {
  let candidate = isValidUsername(base) ? base : `oidc_user`;
  let suffix = 0;
  while (db.prepare('SELECT id FROM users WHERE username = ?').get(candidate)) {
    suffix += 1;
    candidate = `${base}${suffix}`.slice(0, 32);
  }
  return candidate;
}

// Apple's ID tokens send email_verified as the *string* "true"/"false" rather than a JSON
// boolean — a known quirk of its OIDC implementation. Everyone else (Google, Dex, ...) sends
// a real boolean, so both forms need to be accepted here.
function isEmailVerified(claims) {
  return claims.email_verified === true || claims.email_verified === 'true';
}

// Only auto-link when the provider actually vouches for the email, and only onto an account
// that isn't already linked to some other identity — otherwise a provider that lets users
// claim an arbitrary unverified email could hijack an unrelated local account, and an already-
// linked account could get silently reassigned to a second, unrelated identity.
function findLinkableAccountByEmail(db, claims) {
  if (!isEmailVerified(claims) || !claims.email) return null;
  const email = normalizeEmail(claims.email);
  if (!email) return null;
  return db.prepare(
    'SELECT * FROM users WHERE email = ? AND oidc_provider IS NULL'
  ).get(email) || null;
}

router.get('/providers', async (req, res) => {
  res.json(await listAvailableProviders());
});

router.get('/:provider/start', authLimiter, async (req, res) => {
  const key = req.params.provider;
  const cfg = providerConfig(key);
  const client = cfg ? await getClient(key) : null;
  if (!client) return res.status(404).json({ error: 'error.oidc_provider_unknown' });

  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const state = signState({ provider: key, code_verifier });

  const url = client.authorizationUrl({
    scope: 'openid email profile',
    state,
    code_challenge,
    code_challenge_method: 'S256',
  });
  res.redirect(url);
});

router.get('/:provider/callback', authLimiter, async (req, res) => {
  const key = req.params.provider;
  try {
    const { provider, code_verifier } = verifyState(req.query.state);
    if (provider !== key) throw new Error('provider mismatch');

    const client = await getClient(key);
    if (!client) throw new Error('provider unavailable');

    const redirectUri = client.metadata.redirect_uris[0];
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(redirectUri, params, { code_verifier, state: req.query.state });
    const claims = tokenSet.claims();

    const db = getDb();
    let user = db.prepare('SELECT * FROM users WHERE oidc_provider = ? AND oidc_sub = ?').get(key, claims.sub);

    if (!user) {
      // Second chance before creating a new account: an existing, still-unlinked local
      // account whose verified email matches this identity gets linked instead — this is
      // what makes "log in with the same email you already registered with" work, rather
      // than silently spawning a duplicate account every time.
      const linkable = findLinkableAccountByEmail(db, claims);
      if (linkable) {
        db.prepare('UPDATE users SET oidc_provider = ?, oidc_sub = ? WHERE id = ?')
          .run(key, claims.sub, linkable.id);
        user = linkable;
      }
    }

    if (!user) {
      // Respect the same "registration_enabled" admin toggle that gates local self-service
      // registration (POST /register) — an unrecognized OIDC identity is just another form
      // of a new sign-up, and shouldn't be able to create an account when that's turned off.
      const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
      if (hasUsers && !isRegistrationEnabled(db)) {
        return res.redirect('/login.html?error=oidc_registration_disabled');
      }

      const username = uniqueUsername(db, deriveUsername(claims));
      const name = (claims.name || '').toString().trim().slice(0, 100);
      // Only keep an email the provider actually vouched for. `users.email` is a login
      // identifier in its own right (auth.js's /login matches username OR email) and the key
      // findLinkableAccountByEmail links future identities on, so an IdP that lets a user
      // self-assert an arbitrary unverified address must not be able to plant someone else's
      // here. Unverified just means no email on the account — everything else works the same.
      const email = isEmailVerified(claims) ? (normalizeEmail(claims.email).slice(0, 255) || null) : null;
      const placeholderHash = await bcrypt.hash(crypto.randomUUID(), SALT_ROUNDS);
      const result = db.prepare(
        'INSERT INTO users (username, name, password_hash, oidc_provider, oidc_sub, email) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(username, name, placeholderHash, key, claims.sub, email);
      db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);
      user = { id: result.lastInsertRowid, username, name };
    }

    const token = signToken(user);
    res.redirect(`/oidc-callback.html#token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error(`[oidc] callback error for provider "${key}":`, err.message);
    res.redirect('/login.html?error=oidc_failed');
  }
});

module.exports = router;
