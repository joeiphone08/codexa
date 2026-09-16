// Encryption at rest for third-party sync credentials (BookOrbit / KOSync).
//
// These are *reversible* secrets: unlike the local account password (bcrypt-hashed
// in `users`), Codexa has to replay them verbatim to an upstream server, so they
// cannot be hashed. They used to be written as bare plaintext into columns named
// `*_enc`, which meant anyone holding the SQLite file or a backup held every
// user's upstream credentials.
//
// Format (self-describing, single TEXT column, no schema migration):
//
//   v1:<base64 iv>:<base64 auth tag>:<base64 ciphertext>
//
// AES-256-GCM, fresh random 12-byte IV per encryption, 16-byte auth tag stored
// alongside. The key is derived from JWT_SECRET (mandatory and validated at
// >=64 chars in server/index.js) via HKDF-SHA256 with an app-specific `info`
// string, so the credential key is domain-separated from JWT signing — leaking
// one does not hand over the other.
//
// Backward compatibility is the point of the `v1:` prefix: rows written before
// this change hold bare plaintext, and decryptSecret() returns anything that is
// not a well-formed v1 blob unchanged. That makes a mixed plaintext/ciphertext
// table safe, so existing users' sync keeps working across the upgrade and rows
// migrate lazily the next time the user saves a password.

const crypto = require('crypto');

const PREFIX     = 'v1';
const ALGO       = 'aes-256-gcm';
const IV_BYTES   = 12;
const TAG_BYTES  = 16;
const KEY_BYTES  = 32;
const HKDF_INFO  = 'codexa-credential-encryption-v1';
const HKDF_SALT  = 'codexa-credential-encryption-v1';

// Derived lazily (dotenv runs before any route is hit, not necessarily before
// this module is required) and cached per JWT_SECRET value so a rotated secret
// in a long-lived process still re-derives.
let cachedKey = null;
let cachedFrom = null;

function getKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set — cannot derive credential encryption key');
  if (cachedKey && cachedFrom === secret) return cachedKey;
  const bits = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), KEY_BYTES);
  cachedKey  = Buffer.from(bits);
  cachedFrom = secret;
  return cachedKey;
}

// True only for a syntactically well-formed v1 blob. Anything else is treated as
// legacy plaintext by decryptSecret().
function isEncrypted(stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  try {
    const iv  = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    return iv.length === IV_BYTES && tag.length === TAG_BYTES;
  } catch {
    return false;
  }
}

// Returns '' for empty input so that "" keeps meaning "no password configured"
// (the GET /api/settings has_* booleans compare against '').
function encryptSecret(plaintext) {
  if (plaintext === undefined || plaintext === null) return '';
  const text = String(plaintext);
  if (text === '') return '';

  const iv     = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv, { authTagLength: TAG_BYTES });
  const ct     = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();

  return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

// Never throws. Three outcomes:
//   - well-formed v1 blob that authenticates -> the plaintext
//   - anything unprefixed/unparseable        -> returned as-is (legacy plaintext row)
//   - v1 blob that fails to decrypt (corrupt, or JWT_SECRET was rotated) -> ''
//     so the caller falls through its normal "no credentials / auth failed" path
//     instead of crashing a request handler or a background sync loop.
function decryptSecret(stored) {
  if (stored === undefined || stored === null) return '';
  if (typeof stored !== 'string') return String(stored);
  if (!isEncrypted(stored)) return stored;

  try {
    const [, ivB64, tagB64, ctB64] = stored.split(':');
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately no logging: the value itself must never reach a log line, and
    // the reason (bad tag / rotated key) is not actionable per-request.
    return '';
  }
}

module.exports = { encryptSecret, decryptSecret, isEncrypted };
