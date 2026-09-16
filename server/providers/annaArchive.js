const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { safeFetch, parseHttpUrl } = require('./httpSafety');

// CBR remains supported by Codexa's ordinary import path. The external-provider trial excludes
// it because the current RAR-to-CBZ path can inflate data before the import size limit applies.
const SUPPORTED_FORMATS = new Set(['epub', 'pdf', 'cbz']);
const MD5_PATH_RE = /\/md5\/([a-f0-9]{32})(?:[/?#]|$)/i;
const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_SEARCH_ROWS = 200;
const MAX_DETAIL_ANCHORS = 200;
let processAcquisitionBytes = 0;

function finiteNumber(value, fallback, min, max) {
  const parsed = value === '' || value == null ? NaN : Number(value);
  return Math.max(min, Math.min(Number.isFinite(parsed) ? parsed : fallback, max));
}

function deadlineError() {
  return new Error('error.external_timeout');
}

function withTimeout(promise, timeoutMs) {
  if (timeoutMs <= 0) return Promise.reject(deadlineError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(deadlineError()), timeoutMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function approximateCacheBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') + 128; }
  catch { return 128; }
}

function safeCodePoint(value) {
  const codePoint = Number(value);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : '\ufffd';
}

function decodeHtml(value = '') {
  // Provider HTML is untrusted. Bound work per field before running the small entity/tag parser.
  return String(value).slice(0, 20_000)
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_, n) => safeCodePoint(n))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const match = String(tag).match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function firstMatchingTag(html, tagName, predicate = () => true, maxMatches = MAX_DETAIL_ANCHORS) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let inspected = 0;
  for (const match of String(html).matchAll(re)) {
    if (++inspected > maxMatches) break;
    if (predicate(match[0])) return match[0];
  }
  return '';
}

function resolveHttpUrl(href, baseUrl) {
  if (!href) return '';
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

function parseSearchResults(html, baseUrl, resultLimit = 30) {
  const results = [];
  const seen = new Set();
  const boundedLimit = Math.floor(finiteNumber(resultLimit, 30, 1, 30));
  let inspectedRows = 0;
  for (const row of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (++inspectedRows > MAX_SEARCH_ROWS || results.length >= boundedLimit) break;
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 3) continue;
    const detailTag = firstMatchingTag(row[1], 'a', tag => MD5_PATH_RE.test(attr(tag, 'href')));
    const detailHref = attr(detailTag, 'href');
    const md5 = detailHref.match(MD5_PATH_RE)?.[1]?.toLowerCase();
    if (!md5 || seen.has(md5)) continue;

    const title = decodeHtml(cells[1]);
    if (!title) continue;
    const author = decodeHtml(cells[2]);
    const formatText = decodeHtml(cells[9] || cells.at(-1) || '').toLowerCase();
    const format = [...SUPPORTED_FORMATS].find(item => new RegExp(`\\b${item}\\b`, 'i').test(formatText)) || '';
    const imageTag = firstMatchingTag(cells[0], 'img');
    const cover = resolveHttpUrl(attr(imageTag, 'src') || attr(imageTag, 'data-src'), baseUrl);

    seen.add(md5);
    results.push({
      id: md5,
      title,
      author,
      format,
      cover,
      detailUrl: resolveHttpUrl(detailHref, baseUrl),
    });
  }
  return results;
}

function parseDirectAcquisition(html, detailUrl, allowedHosts, expectedFormat = '') {
  const candidates = [];
  const anchorRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let inspectedAnchors = 0;
  for (const match of String(html).matchAll(anchorRe)) {
    if (++inspectedAnchors > MAX_DETAIL_ANCHORS) break;
    const openTag = match[0].match(/^<a\b[^>]*>/i)?.[0] || '';
    const href = resolveHttpUrl(attr(openTag, 'href'), detailUrl);
    if (!href) continue;
    const url = new URL(href);
    if (!allowedHosts.has(url.hostname.toLowerCase())) continue;

    const label = decodeHtml(match[0]).toLowerCase();
    const pathFormat = url.pathname.match(/\.(epub|pdf|cbz)(?:$|[.;])/i)?.[1]?.toLowerCase() || '';
    const labelledFormat = [...SUPPORTED_FORMATS].find(item => new RegExp(`\\b${item}\\b`, 'i').test(label)) || '';
    const format = pathFormat || labelledFormat || expectedFormat;
    const explicitlyDownloadable = /\bdownload\b/i.test(label) || /\sdownload(?:\s*=|\s|>)/i.test(openTag);
    if (!SUPPORTED_FORMATS.has(format) || (!pathFormat && !explicitlyDownloadable)) continue;
    if (expectedFormat && format !== expectedFormat) continue;
    candidates.push({ url: href, format });
  }
  return candidates[0] || null;
}

function hasSafeDeclaredArchiveSizes(entries) {
  if (!Array.isArray(entries) || entries.length > 5000) return false;
  let declaredTotal = 0;
  for (const entry of entries) {
    const size = Number(entry.header?.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_ENTRY_BYTES) return false;
    declaredTotal += size;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_ARCHIVE_TOTAL_BYTES) return false;
  }
  return true;
}

function validateBookBuffer(buffer, contentType, format) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) return false;
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/json') || ct.startsWith('text/')) return false;
  if (format === 'pdf') return buffer.subarray(0, 5).toString() === '%PDF-';
  if ((format === 'epub' || format === 'cbz') && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      const zip = new AdmZip(buffer);
      const allEntries = zip.getEntries();
      if (!hasSafeDeclaredArchiveSizes(allEntries)) return false;
      const entries = allEntries.filter(entry => !entry.isDirectory);
      if (!entries.length || entries.length > 5000) return false;
      if (format === 'epub') {
        const mimetype = entries.find(entry => entry.entryName === 'mimetype');
        const container = entries.find(entry => entry.entryName === 'META-INF/container.xml');
        if (!mimetype || mimetype.header.size > 64 || !container || container.header.size > 1024 * 1024 ||
            mimetype.getData().toString('utf8').trim() !== 'application/epub+zip') return false;
        const containerXml = container.getData().toString('utf8');
        const opfPath = containerXml.match(/<rootfile\b[^>]*\bfull-path\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
        const normalizedOpf = (opfPath?.[1] || opfPath?.[2] || '').replace(/^\/+/, '');
        if (!normalizedOpf || normalizedOpf.split('/').includes('..')) return false;
        return entries.some(entry => entry.entryName === normalizedOpf && entry.header.size <= 16 * 1024 * 1024);
      }
      if (entries.some(entry => entry.entryName === 'mimetype')) return false;
      for (const entry of entries) {
        if (/\.(?:jpe?g|png|webp)$/i.test(entry.entryName) && entry.header.size <= 32 * 1024 * 1024 &&
            detectImageContentType(entry.getData())) return true;
      }
      return false;
    } catch { return false; }
  }
  return false;
}

function detectImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}

async function mapWithConcurrency(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

class AnnaArchiveProvider {
  constructor(options = {}) {
    this.id = options.id || 'anna';
    this.name = options.name || 'External Books';
    this.baseUrl = parseHttpUrl(options.baseUrl).href.replace(/\/$/, '');
    this.baseHost = new URL(this.baseUrl).hostname.toLowerCase();
    this.directHosts = new Set((options.directHosts || []).map(host => host.trim().toLowerCase()).filter(Boolean));
    this.coverHosts = new Set([this.baseHost, ...(options.coverHosts || []).map(host => host.trim().toLowerCase()).filter(Boolean)]);
    this.allowPrivateNetwork = options.allowPrivateNetwork === true;
    this.searchLimit = Math.floor(finiteNumber(options.searchLimit, 12, 1, 30));
    this.cacheTtlMs = finiteNumber(options.cacheTtlMs, 15 * 60_000, 60_000, 24 * 60 * 60_000);
    this.cacheMaxPerUser = Math.floor(finiteNumber(options.cacheMaxPerUser, 100, 10, 500));
    this.cacheMaxUsers = Math.floor(finiteNumber(options.cacheMaxUsers, 1000, 10, 5000));
    this.cacheMaxBytes = Math.floor(finiteNumber(options.cacheMaxBytes, 32 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024));
    this.maxBookBytes = Math.floor(finiteNumber(options.maxBookBytes, 150 * 1024 * 1024, 1024 * 1024, 250 * 1024 * 1024));
    this.searchTimeoutMs = Math.floor(finiteNumber(options.searchTimeoutMs, 15_000, 1_000, 30_000));
    this.htmlTimeoutMs = Math.floor(finiteNumber(options.htmlTimeoutMs, 12_000, 1_000, 15_000));
    this.downloadTimeoutMs = Math.floor(finiteNumber(options.downloadTimeoutMs, 60_000, 5_000, 120_000));
    this.detailConcurrency = Math.floor(finiteNumber(options.detailConcurrency, 3, 1, 5));
    this.acquisitionGlobalLimit = Math.floor(finiteNumber(options.acquisitionGlobalLimit, 4, 1, 8));
    this.acquisitionPerUserLimit = Math.floor(finiteNumber(options.acquisitionPerUserLimit, 2, 1, 4));
    this.acquisitionMaxInflightBytes = Math.max(this.maxBookBytes, Math.floor(finiteNumber(
      options.acquisitionMaxInflightBytes, 300 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024,
    )));
    this.searchGlobalLimit = Math.floor(finiteNumber(options.searchGlobalLimit, 8, 1, 32));
    this.searchPerUserLimit = Math.floor(finiteNumber(options.searchPerUserLimit, 2, 1, 8));
    this.coverGlobalLimit = Math.floor(finiteNumber(options.coverGlobalLimit, 16, 1, 64));
    this.coverPerUserLimit = Math.floor(finiteNumber(options.coverPerUserLimit, 8, 1, 16));
    this.referenceSecret = String(options.referenceSecret || process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'));
    this.fetchHtmlOverride = options.fetchHtml || null;
    this.fetchAssetOverride = options.fetchAsset || null;
    this.fetchCoverAssetOverride = options.fetchCoverAsset || null;
    this.cache = new Map(); // user id -> insertion-ordered token map (LRU)
    this.cacheBytes = 0;
    this.activeAcquisitions = 0;
    this.activeAcquisitionsByUser = new Map();
    this.activeSearches = 0;
    this.activeSearchesByUser = new Map();
    this.activeCovers = 0;
    this.activeCoversByUser = new Map();
  }

  descriptor() {
    return { id: `provider:${this.id}`, name: this.name, type: 'provider', providerId: this.id };
  }

  browse() {
    return { version: 1, title: this.name, self: '', up: '', next: '', entries: [] };
  }

  _token(userId, sourceId) {
    return crypto.createHmac('sha256', this.referenceSecret)
      .update(`${this.id}\0${userId}\0${sourceId}`)
      .digest('base64url')
      .slice(0, 32);
  }

  _put(userId, result) {
    const now = Date.now();
    const userKey = String(userId);
    this._pruneUser(userKey, now);
    const isNewUser = !this.cache.has(userKey);
    while (isNewUser && this.cache.size >= this.cacheMaxUsers) {
      this._deleteUser(this.cache.keys().next().value);
    }
    const userCache = this.cache.get(userKey) || new Map();
    const token = this._token(userId, result.id);
    this._deleteEntry(userCache, token);
    while (userCache.size >= this.cacheMaxPerUser) this._deleteEntry(userCache, userCache.keys().next().value);
    const cached = { ...result, token, expiresAt: now + this.cacheTtlMs };
    cached.cacheBytes = approximateCacheBytes(cached);
    userCache.set(token, cached);
    this.cacheBytes += cached.cacheBytes;
    this.cache.delete(userKey);
    this.cache.set(userKey, userCache);
    while (this.cacheBytes > this.cacheMaxBytes && this.cache.size > 1) {
      this._deleteUser(this.cache.keys().next().value);
    }
    while (this.cacheBytes > this.cacheMaxBytes && userCache.size > 1) {
      this._deleteEntry(userCache, userCache.keys().next().value);
    }
    return token;
  }

  _deleteEntry(userCache, token) {
    const cached = userCache?.get(token);
    if (!cached) return;
    this.cacheBytes = Math.max(0, this.cacheBytes - (cached.cacheBytes || approximateCacheBytes(cached)));
    userCache.delete(token);
  }

  _deleteUser(userKey) {
    const userCache = this.cache.get(userKey);
    if (!userCache) return;
    for (const token of [...userCache.keys()]) this._deleteEntry(userCache, token);
    this.cache.delete(userKey);
  }

  _pruneUser(userKey, now = Date.now()) {
    const userCache = this.cache.get(userKey);
    if (!userCache) return;
    for (const [token, value] of userCache) if (value.expiresAt <= now) this._deleteEntry(userCache, token);
    if (!userCache.size) this.cache.delete(userKey);
  }

  _lookup(userId, reference, action) {
    const match = String(reference || '').match(new RegExp(`^provider:${this.id}:${action}:([A-Za-z0-9_-]{32})$`));
    const token = match?.[1];
    if (!token) return { cached: null, status: 404 };
    const userCache = this.cache.get(String(userId));
    this._pruneUser(String(userId));
    const cached = userCache?.get(token);
    if (!cached) return { cached: null, status: 410 };
    userCache.delete(token);
    userCache.set(token, cached);
    const userKey = String(userId);
    this.cache.delete(userKey);
    this.cache.set(userKey, userCache);
    return { cached, status: 200 };
  }

  _tryLimitedWork(userId, activeField, byUserField, globalLimit, perUserLimit) {
    const userKey = String(userId);
    const byUser = this[byUserField];
    const userActive = byUser.get(userKey) || 0;
    if (this[activeField] >= globalLimit || userActive >= perUserLimit) return null;
    this[activeField]++;
    byUser.set(userKey, userActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this[activeField]--;
      const remaining = (byUser.get(userKey) || 1) - 1;
      if (remaining) byUser.set(userKey, remaining);
      else byUser.delete(userKey);
    };
  }

  _tryAcquire(userId) {
    if (processAcquisitionBytes + this.maxBookBytes > this.acquisitionMaxInflightBytes) return null;
    const releaseConcurrency = this._tryLimitedWork(
      userId, 'activeAcquisitions', 'activeAcquisitionsByUser',
      this.acquisitionGlobalLimit, this.acquisitionPerUserLimit,
    );
    if (!releaseConcurrency) return null;
    processAcquisitionBytes += this.maxBookBytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      processAcquisitionBytes = Math.max(0, processAcquisitionBytes - this.maxBookBytes);
      releaseConcurrency();
    };
  }

  async _fetchHtml(url, deadline = Date.now() + this.htmlTimeoutMs) {
    const timeoutMs = Math.min(this.htmlTimeoutMs, deadline - Date.now());
    if (this.fetchHtmlOverride) return withTimeout(this.fetchHtmlOverride(url), timeoutMs);
    const asset = await safeFetch(url, {
      allowedHosts: new Set([this.baseHost]),
      allowPrivateNetwork: this.allowPrivateNetwork,
      timeoutMs,
      maxRedirects: 2,
      maxBytes: 2 * 1024 * 1024,
      accept: 'text/html,application/xhtml+xml',
    });
    if (!asset.ok) throw new Error(`HTTP ${asset.status}`);
    if (asset.contentType && !asset.contentType.toLowerCase().includes('html')) {
      throw new Error('error.external_unexpected_content_type');
    }
    return asset.buffer.toString('utf8');
  }

  async search(query, { userId } = {}) {
    const release = this._tryLimitedWork(
      userId, 'activeSearches', 'activeSearchesByUser', this.searchGlobalLimit, this.searchPerUserLimit,
    );
    if (!release) throw new Error('error.external_busy');
    try {
      const q = String(query || '').trim().slice(0, 200);
      if (!q) throw new Error('error.search_query_required');
      const url = new URL('/search', `${this.baseUrl}/`);
      url.searchParams.set('page', '1');
      url.searchParams.set('q', q);
      url.searchParams.set('display', 'table');
      const deadline = Date.now() + this.searchTimeoutMs;
      const results = parseSearchResults(await this._fetchHtml(url.href, deadline), this.baseUrl, this.searchLimit);

      // Direct links are resolved during search so Codexa only presents Add/Peek when the adapter
      // has already found a supported link on an operator-approved host. With no direct-host
      // allowlist, discovery remains metadata-only.
      await withTimeout(mapWithConcurrency(results, this.detailConcurrency, async result => {
        if (Date.now() >= deadline) throw deadlineError();
        if (result.detailUrl && result.format && this.directHosts.size) {
          try {
            const detailHtml = await this._fetchHtml(result.detailUrl, deadline);
            result.acquisition = parseDirectAcquisition(detailHtml, result.detailUrl, this.directHosts, result.format);
          } catch (error) {
            if (error.message === 'error.external_timeout') throw error;
            result.acquisition = null;
          }
        }
        result.token = this._put(userId, result);
      }), deadline - Date.now());

      return {
        version: 1,
        title: `${this.name}: ${q}`,
        self: '', up: '', next: '',
        entries: results.map(result => ({
          id: `provider:${this.id}:item:${result.token}`,
          title: result.title,
          author: result.author,
          summary: result.format ? result.format.toUpperCase() : '',
          cover: result.cover ? `provider:${this.id}:cover:${result.token}` : '',
          acqHref: result.acquisition ? `provider:${this.id}:acquire:${result.token}` : '',
          acqType: result.acquisition ? ({ epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip' }[result.acquisition.format] || 'application/octet-stream') : '',
          navHref: '',
          isNav: false,
        })),
      };
    } finally {
      release();
    }
  }

  async fetchCover(reference, { userId } = {}) {
    const { cached, status } = this._lookup(userId, reference, 'cover');
    if (!cached) return { ok: false, status, error: status === 410 ? 'error.external_reference_expired' : 'error.external_reference_invalid', buffer: Buffer.alloc(0), contentType: '' };
    if (!cached.cover) return { ok: false, status: 404, error: 'error.external_cover_unavailable', buffer: Buffer.alloc(0), contentType: '' };
    const release = this._tryLimitedWork(
      userId, 'activeCovers', 'activeCoversByUser', this.coverGlobalLimit, this.coverPerUserLimit,
    );
    if (!release) return { ok: false, status: 429, error: 'error.external_busy', buffer: Buffer.alloc(0), contentType: '' };
    try {
      const asset = this.fetchCoverAssetOverride
        ? await withTimeout(this.fetchCoverAssetOverride(cached.cover), 8_000)
        : await safeFetch(cached.cover, {
          allowedHosts: this.coverHosts,
          allowPrivateNetwork: this.allowPrivateNetwork,
          timeoutMs: 8_000,
          maxRedirects: 2,
          maxBytes: 5 * 1024 * 1024,
          accept: 'image/*',
        });
      const detectedType = detectImageContentType(asset.buffer);
      if (!asset.ok || !detectedType || (asset.contentType && !asset.contentType.toLowerCase().startsWith('image/'))) {
        return { ok: false, status: 404, buffer: Buffer.alloc(0), contentType: '' };
      }
      asset.contentType = detectedType;
      return asset;
    } finally {
      release();
    }
  }

  async fetchAcquisition(reference, { userId } = {}) {
    const { cached, status } = this._lookup(userId, reference, 'acquire');
    if (!cached) return { ok: false, status, error: status === 410 ? 'error.external_reference_expired' : 'error.external_reference_invalid', buffer: Buffer.alloc(0), contentType: '' };
    if (!cached.acquisition) return { ok: false, status: 404, error: 'error.external_acquisition_unavailable', buffer: Buffer.alloc(0), contentType: '' };
    const release = this._tryAcquire(userId);
    if (!release) return { ok: false, status: 429, error: 'error.external_busy', buffer: Buffer.alloc(0), contentType: '' };
    let transferred = false;
    try {
      const asset = this.fetchAssetOverride
        ? await withTimeout(this.fetchAssetOverride(cached.acquisition.url), this.downloadTimeoutMs)
        : await safeFetch(cached.acquisition.url, {
        allowedHosts: this.directHosts,
        allowPrivateNetwork: this.allowPrivateNetwork,
        timeoutMs: this.downloadTimeoutMs,
        maxRedirects: 3,
        maxBytes: this.maxBookBytes,
        accept: 'application/epub+zip,application/pdf,application/zip,application/octet-stream',
        });
      if (!asset.ok || !Buffer.isBuffer(asset.buffer) || asset.buffer.length > this.maxBookBytes ||
          !validateBookBuffer(asset.buffer, asset.contentType, cached.acquisition.format)) {
        return { ok: false, status: 502, error: 'error.external_invalid_book_file', buffer: Buffer.alloc(0), contentType: '' };
      }
      asset.format = cached.acquisition.format;
      asset.release = release;
      transferred = true;
      return asset;
    } catch (error) {
      if (error.message === 'error.external_timeout') {
        return { ok: false, status: 504, error: error.message, buffer: Buffer.alloc(0), contentType: '' };
      }
      throw error;
    } finally {
      if (!transferred) release();
    }
  }
}

module.exports = {
  AnnaArchiveProvider,
  decodeHtml,
  detectImageContentType,
  finiteNumber,
  hasSafeDeclaredArchiveSizes,
  parseDirectAcquisition,
  parseSearchResults,
  validateBookBuffer,
};
