const { AnnaArchiveProvider } = require('./annaArchive');

function finiteEnv(value, fallback, min, max) {
  const parsed = value === '' || value == null ? NaN : Number(value);
  return Math.max(min, Math.min(Number.isFinite(parsed) ? parsed : fallback, max));
}

class ProviderRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    providers.forEach(provider => this.register(provider));
  }

  register(provider) {
    for (const method of ['descriptor', 'browse', 'search', 'fetchCover', 'fetchAcquisition']) {
      if (typeof provider?.[method] !== 'function') throw new TypeError(`Provider is missing ${method}()`);
    }
    if (!provider.id || this.providers.has(provider.id)) throw new TypeError('Provider id must be unique');
    this.providers.set(provider.id, provider);
  }

  list() { return [...this.providers.values()].map(provider => provider.descriptor()); }
  get(id) { return this.providers.get(String(id || '').replace(/^provider:/, '')) || null; }
  fromCatalogId(id) { return String(id || '').startsWith('provider:') ? this.get(id) : null; }
}

function fromEnvironment(env = process.env) {
  const providers = [];
  if (env.EXTERNAL_BOOKS_ANNA_BASE_URL) {
    providers.push(new AnnaArchiveProvider({
      baseUrl: env.EXTERNAL_BOOKS_ANNA_BASE_URL,
      name: env.EXTERNAL_BOOKS_ANNA_NAME || 'External Books',
      directHosts: String(env.EXTERNAL_BOOKS_ANNA_DIRECT_HOSTS || '').split(','),
      coverHosts: String(env.EXTERNAL_BOOKS_ANNA_COVER_HOSTS || '').split(','),
      allowPrivateNetwork: env.EXTERNAL_BOOKS_ALLOW_PRIVATE_NETWORK === 'true',
      searchLimit: finiteEnv(env.EXTERNAL_BOOKS_SEARCH_LIMIT, 12, 1, 30),
      maxBookBytes: finiteEnv(env.EXTERNAL_BOOKS_MAX_BOOK_MB, 150, 1, 250) * 1024 * 1024,
      cacheTtlMs: finiteEnv(env.EXTERNAL_BOOKS_CACHE_TTL_MINUTES, 15, 1, 1440) * 60 * 1000,
      cacheMaxPerUser: finiteEnv(env.EXTERNAL_BOOKS_CACHE_MAX_PER_USER, 100, 10, 500),
      cacheMaxUsers: finiteEnv(env.EXTERNAL_BOOKS_CACHE_MAX_USERS, 1000, 10, 5000),
      cacheMaxBytes: finiteEnv(env.EXTERNAL_BOOKS_CACHE_MAX_MB, 32, 1, 256) * 1024 * 1024,
      searchTimeoutMs: finiteEnv(env.EXTERNAL_BOOKS_SEARCH_TIMEOUT_MS, 15000, 1000, 30000),
      downloadTimeoutMs: finiteEnv(env.EXTERNAL_BOOKS_DOWNLOAD_TIMEOUT_MS, 60000, 5000, 120000),
      detailConcurrency: finiteEnv(env.EXTERNAL_BOOKS_DETAIL_CONCURRENCY, 3, 1, 5),
      searchGlobalLimit: finiteEnv(env.EXTERNAL_BOOKS_SEARCH_GLOBAL_LIMIT, 8, 1, 32),
      searchPerUserLimit: finiteEnv(env.EXTERNAL_BOOKS_SEARCH_PER_USER_LIMIT, 2, 1, 8),
      coverGlobalLimit: finiteEnv(env.EXTERNAL_BOOKS_COVER_GLOBAL_LIMIT, 16, 1, 64),
      coverPerUserLimit: finiteEnv(env.EXTERNAL_BOOKS_COVER_PER_USER_LIMIT, 8, 1, 16),
      acquisitionGlobalLimit: finiteEnv(env.EXTERNAL_BOOKS_ACQUISITION_GLOBAL_LIMIT, 4, 1, 8),
      acquisitionPerUserLimit: finiteEnv(env.EXTERNAL_BOOKS_ACQUISITION_PER_USER_LIMIT, 2, 1, 4),
      acquisitionMaxInflightBytes: finiteEnv(env.EXTERNAL_BOOKS_ACQUISITION_MAX_INFLIGHT_MB, 300, 1, 1024) * 1024 * 1024,
    }));
  }
  return new ProviderRegistry(providers);
}

const registry = fromEnvironment();

module.exports = { ProviderRegistry, finiteEnv, fromEnvironment, registry };
