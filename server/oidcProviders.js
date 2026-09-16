const { Issuer } = require('openid-client');

// Generic, config-driven OIDC provider registry. Each entry in OIDC_PROVIDERS is a
// lowercase key with matching OIDC_<KEY>_ISSUER / _CLIENT_ID / _CLIENT_SECRET / _NAME
// env vars — this is what lets Google, Apple, and any self-hosted IdP (Dex, Authelia,
// Keycloak, ...) all work through the exact same code path with zero provider-specific
// branches. See README's OIDC section for the full env var reference.

const _clientCache = new Map(); // key -> openid-client Client instance

function configuredProviderKeys() {
  const raw = process.env.OIDC_PROVIDERS || '';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function envPrefix(key) {
  return `OIDC_${key.toUpperCase()}_`;
}

// The key reaching providerConfig()/getClient() is `req.params.provider` — attacker-chosen text
// used to build an environment-variable name and, previously, accepted on nothing more than
// "the matching OIDC_<KEY>_* vars happen to exist". Two things follow from that:
//
//  1. OIDC_PROVIDERS stopped being the switch it looks like. Dropping a provider from that list
//     is the documented way to turn it off, but its OIDC_<KEY>_ISSUER/_CLIENT_ID/_CLIENT_SECRET
//     usually stay behind in the env file — and /api/auth/oidc/<key>/start would still discover
//     and use them. An operator narrowing OIDC_PROVIDERS to their internal IdP (the obvious move
//     when going public, since an unrecognized OIDC identity auto-provisions a new account in
//     routes/oidc.js) kept a fully working "sign in with <removed provider>" route.
//  2. Nothing constrained the shape of the key, so it could name arbitrary env lookups.
//
// So: reject anything not syntactically a provider key, and require it to be listed in
// OIDC_PROVIDERS. The list is now the single source of truth it was documented to be.
function isKnownProviderKey(key) {
  if (typeof key !== 'string' || !/^[a-z0-9_]{1,32}$/.test(key)) return false;
  return configuredProviderKeys().includes(key);
}

function providerConfig(key) {
  if (!isKnownProviderKey(key)) return null;
  const prefix = envPrefix(key);
  const issuer = process.env[`${prefix}ISSUER`];
  const clientId = process.env[`${prefix}CLIENT_ID`];
  const clientSecret = process.env[`${prefix}CLIENT_SECRET`];
  const name = process.env[`${prefix}NAME`] || key;
  if (!issuer || !clientId || !clientSecret) return null;
  return { key, issuer, clientId, clientSecret, name };
}

function redirectUri(key) {
  const base = (process.env.OIDC_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/api/auth/oidc/${key}/callback`;
}

// Lazily discovers + caches a Client for a provider key. Discovery is deliberately not
// done at server boot: in a Docker Compose stack a self-hosted IdP (e.g. Dex) may not be
// reachable yet the instant Codexa starts, and Codexa shouldn't crash-loop waiting on it.
// A provider that fails discovery is simply unavailable until the next request retries it.
async function getClient(key) {
  if (!isKnownProviderKey(key)) return null;
  if (_clientCache.has(key)) return _clientCache.get(key);
  const cfg = providerConfig(key);
  if (!cfg) return null;
  if (!process.env.OIDC_BASE_URL) {
    console.warn(`[oidc] OIDC_BASE_URL is not set — provider "${key}" cannot build a callback URL`);
    return null;
  }
  try {
    const issuer = await Issuer.discover(cfg.issuer);
    const client = new issuer.Client({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uris: [redirectUri(key)],
      response_types: ['code'],
    });
    _clientCache.set(key, client);
    return client;
  } catch (err) {
    console.warn(`[oidc] discovery failed for provider "${key}":`, err.message);
    return null;
  }
}

// Returns the public { id, name } list for every provider that currently discovers
// successfully — used by the login page to render buttons. Failures are silent per-provider
// (already logged by getClient) so one misconfigured/unreachable IdP doesn't hide the rest.
async function listAvailableProviders() {
  const keys = configuredProviderKeys();
  const results = await Promise.all(keys.map(async key => {
    const cfg = providerConfig(key);
    if (!cfg) return null;
    const client = await getClient(key);
    return client ? { id: key, name: cfg.name } : null;
  }));
  return results.filter(Boolean);
}

module.exports = { configuredProviderKeys, providerConfig, getClient, listAvailableProviders };
