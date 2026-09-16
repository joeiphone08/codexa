'use strict';
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const multer    = require('multer');
const AdmZip    = require('adm-zip');
const { DATA_DIR } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const StarDict  = require('../utils/stardict');

const TMP_DIR = path.join(DATA_DIR, 'tmp');

const router   = express.Router();
const DICT_DIR = path.join(DATA_DIR, 'dictionaries');
const cache    = new Map(); // relative-id → loaded StarDict instance

function ensureDictDir() {
  if (!fs.existsSync(DICT_DIR)) fs.mkdirSync(DICT_DIR, { recursive: true });
}

// Recursively find all .ifo files under DICT_DIR.
// Returns objects: { id, ifoPath }
// `id` is the path relative to DICT_DIR without the .ifo extension,
// e.g. "en-en/merriam-webster" for DICT_DIR/en-en/merriam-webster.ifo
function findAllIfo(dir = DICT_DIR, base = '') {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const e of entries) {
    if (e.isDirectory()) {
      results.push(...findAllIfo(path.join(dir, e.name), base ? `${base}/${e.name}` : e.name));
    } else if (e.isFile() && e.name.endsWith('.ifo')) {
      const stem = e.name.slice(0, -4);
      const id   = base ? `${base}/${stem}` : stem;
      results.push({ id, ifoPath: path.join(dir, e.name) });
    }
  }
  return results;
}

// Resolve a dictionary id to its .ifo path, verifying it's still inside DICT_DIR (no traversal).
function resolveIfoPath(id) {
  const resolved = path.resolve(DICT_DIR, id + '.ifo');
  if (!resolved.startsWith(path.resolve(DICT_DIR) + path.sep) && resolved !== path.resolve(DICT_DIR)) {
    const err = new Error('Invalid dictionary id: ' + id);
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(resolved)) {
    const err = new Error('Dictionary not found: ' + id);
    err.status = 404;
    throw err;
  }
  return resolved;
}

function loadDict(id) {
  if (cache.has(id)) return cache.get(id);
  const d = new StarDict(resolveIfoPath(id));
  d.load();
  cache.set(id, d);
  return d;
}

// Lightweight variant for listing: only reads the .ifo file (name/wordcount are both declared
// there directly), never the .idx/.syn — those can be genuinely large for CJK dictionaries
// (hundreds of thousands of entries) and fully parsing every installed dictionary just to list
// them was blocking/crashing the Settings → Dictionaries tab on some setups. Reuses an
// already-fully-loaded instance from `cache` when one exists (nothing extra to do), but never
// caches a meta-only instance under the same key — that would poison later lookups by making
// them think the dictionary is already loaded when it never parsed the actual index.
function loadDictMeta(id) {
  if (cache.has(id)) return cache.get(id);
  const d = new StarDict(resolveIfoPath(id));
  d.loadMeta();
  return d;
}

// Infer source/target language from dict id directory prefix.
// Matches leading "XX-YY" or "XXX-YYY" (ISO 639-1/3) optionally followed by "/".
// Returns { lang_from, lang_to } with null values if pattern not found.
const LANG_PREFIX_RE = /^([a-z]{2,3})-([a-z]{2,3})(?:\/|$)/i;
function inferDictLangs(id) {
  const m = LANG_PREFIX_RE.exec(id);
  return m
    ? { lang_from: m[1].toLowerCase(), lang_to: m[2].toLowerCase() }
    : { lang_from: null,               lang_to: null };
}

// ── GET /api/dictionary ───────────────────────────────────────────────────────
// List all available dictionaries (recursive scan of DATA_DIR/dictionaries).
router.get('/', authenticateToken, (req, res) => {
  ensureDictDir();
  try {
    const dicts = findAllIfo().map(({ id }) => {
      try {
        const d    = loadDictMeta(id);
        const langs = inferDictLangs(id);
        return { id, name: d.name, wordcount: d.wordcount, ...langs };
      } catch { return null; }
    }).filter(Boolean);
    res.json(dicts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/dictionary/lookup?word=hello[&dicts=id1,id2] ─────────────────────
// `dicts` is a comma-separated list of relative ids in desired search order.
router.get('/lookup', authenticateToken, (req, res) => {
  const word = (req.query.word || '').trim();
  if (!word) return res.status(400).json({ error: 'error.word_required' });
  ensureDictDir();

  const requested = req.query.dicts
    ? req.query.dicts.split(',').map(s => s.trim()).filter(Boolean)
    : findAllIfo().map(e => e.id);

  const results = [];
  for (const id of requested) {
    try {
      const d    = loadDict(id);
      const hits = d.lookupFuzzy(word);
      for (const hit of hits) {
        results.push({ dict: id, dictName: d.name, word: hit.word, matchedForm: hit.matchedForm, definition: hit.definition, type: hit.type });
      }
    } catch { /* skip missing/broken dicts */ }
  }
  res.json({ word, results });
});

const uploadDict = multer({
  dest: TMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.zip');
    cb(ok ? null : new Error('error.zip_required'), ok);
  },
});

// ── POST /api/dictionary — upload one or many StarDict ZIP archives ────────────
router.post('/', authenticateToken, uploadDict.array('dict', 10), (req, res) => {
  ensureDictDir();
  const results = [];
  for (const file of req.files) {
    try {
      const zip = new AdmZip(file.path);
      const entries = zip.getEntries();
      const hasIfo  = entries.some(e => e.entryName.endsWith('.ifo'));
      if (!hasIfo) {
        results.push({ file: file.originalname, error: 'no .ifo found in ZIP' });
        continue;
      }
      // Never extract an entry whose name escapes the destination folder — a "zip slip"
      // archive (entry named "../../server/index.js", or an absolute path) would otherwise be
      // written straight over the app's own files by any logged-in user.
      const unsafe = entries.find(e => {
        const n = e.entryName.replace(/\\/g, '/');
        return n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..');
      });
      if (unsafe) {
        results.push({ file: file.originalname, error: 'unsafe path in ZIP' });
        continue;
      }
      const baseName = path.basename(file.originalname, '.zip').replace(/[^\w.\-]/g, '_');
      const destDir  = path.join(DICT_DIR, baseName);
      fs.mkdirSync(destDir, { recursive: true });
      zip.extractAllTo(destDir, true);
      results.push({ file: file.originalname, id: baseName });
    } catch (e) {
      results.push({ file: file.originalname, error: e.message });
    } finally {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }
  res.json({ results });
});

// ── DELETE /api/dictionary/* — remove a dictionary's files ───────────────────
// id may be a slash-separated path like "en-en/merriam-webster" — but that's
// "<subdirectory>/<basename>" (see findAllIfo), not a real path on disk. A StarDict
// dictionary is several sibling files sharing that basename (.ifo/.idx/.dict[.dz]/.syn)
// inside the subdirectory, so removing `id` itself as a single file/directory always 404'd.
router.delete('/*', authenticateToken, (req, res) => {
  const id       = req.params[0];
  const resolved = path.resolve(DICT_DIR, id);
  if (!resolved.startsWith(path.resolve(DICT_DIR) + path.sep)) {
    return res.status(400).json({ error: 'error.invalid_path' });
  }
  for (const k of cache.keys()) {
    if (k === id || k.startsWith(id + '/')) cache.delete(k);
  }
  const dir  = path.dirname(resolved);
  const stem = path.basename(resolved);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'error.not_found' });
  const siblings = fs.readdirSync(dir).filter(f => f === stem || f.startsWith(stem + '.'));
  if (!siblings.length) return res.status(404).json({ error: 'error.not_found' });
  for (const f of siblings) fs.rmSync(path.join(dir, f), { force: true });
  // Upload creates one folder per ZIP (see POST above) — clean it up once its last
  // dictionary is gone instead of leaving an empty folder behind in the listing.
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* not empty, leave it */ }
  res.json({ ok: true });
});

// ── PUT /api/dictionary/* — set/clear a dictionary's default language pair ───
// Reuses the same folder-based convention findAllIfo()/inferDictLangs() already read from
// (see above) instead of adding new storage: moves the dictionary's sibling files into (or out
// of) a "<lang_from>-<lang_to>/" folder, keeping its own basename intact so two dictionaries
// sharing a language pair (e.g. two different en-sl dictionaries) never collide — same as how
// manually-placed dictionaries already coexist under one lang-pair folder today.
// body: { lang_from, lang_to } — both optional/nullable; omitting both moves it back to a bare
// "<basename>/" folder (no inferred language, same shape as a fresh, never-tagged upload).
// Returns the new id, since renaming/moving inherently changes it.
const LANG_CODE_RE = /^[a-z]{2,3}$/i;

router.put('/*', authenticateToken, (req, res) => {
  const id       = req.params[0];
  const resolved = path.resolve(DICT_DIR, id);
  if (!resolved.startsWith(path.resolve(DICT_DIR) + path.sep)) {
    return res.status(400).json({ error: 'error.invalid_path' });
  }

  const oldDir = path.dirname(resolved);
  const stem   = path.basename(resolved);
  if (!fs.existsSync(oldDir)) return res.status(404).json({ error: 'error.not_found' });
  const siblings = fs.readdirSync(oldDir).filter(f => f === stem || f.startsWith(stem + '.'));
  if (!siblings.length) return res.status(404).json({ error: 'error.not_found' });

  let { lang_from, lang_to } = req.body || {};
  lang_from = lang_from ? String(lang_from).trim().toLowerCase() : null;
  lang_to   = lang_to   ? String(lang_to).trim().toLowerCase()   : null;
  if ((lang_from && !LANG_CODE_RE.test(lang_from)) || (lang_to && !LANG_CODE_RE.test(lang_to))) {
    return res.status(400).json({ error: 'error.invalid_lang_code' });
  }

  const newDirName = (lang_from && lang_to) ? `${lang_from}-${lang_to}` : stem;
  const newDir     = path.join(DICT_DIR, newDirName);

  if (path.resolve(newDir) !== path.resolve(oldDir)) {
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of siblings) {
      if (fs.existsSync(path.join(newDir, f))) {
        return res.status(409).json({ error: 'error.dict_name_conflict' });
      }
    }
    for (const f of siblings) fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
    try { if (!fs.readdirSync(oldDir).length) fs.rmdirSync(oldDir); } catch { /* not empty, leave it */ }
  }

  for (const k of cache.keys()) {
    if (k === id || k.startsWith(id + '/')) cache.delete(k);
  }

  res.json({ id: `${newDirName}/${stem}`, lang_from, lang_to });
});

module.exports = router;
