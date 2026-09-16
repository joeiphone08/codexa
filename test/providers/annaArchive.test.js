const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const {
  AnnaArchiveProvider,
  detectImageContentType,
  hasSafeDeclaredArchiveSizes,
  parseDirectAcquisition,
  parseSearchResults,
  validateBookBuffer,
} = require('../../server/providers/annaArchive');
const { finiteEnv } = require('../../server/providers');
const { isPrivateAddress, mappedIpv4, safeFetch } = require('../../server/providers/httpSafety');

const fixtures = path.join(__dirname, '..', 'fixtures');
const searchHtml = fs.readFileSync(path.join(fixtures, 'anna-search.html'), 'utf8');
const detailHtml = fs.readFileSync(path.join(fixtures, 'anna-detail.html'), 'utf8');

function makeEpub() {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(
    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  ));
  zip.addFile('OEBPS/content.opf', Buffer.from('<package><metadata><dc:title>Alice</dc:title></metadata></package>'));
  return zip.toBuffer();
}

function makeCbz() {
  const zip = new AdmZip();
  zip.addFile('001.png', Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(256),
  ]));
  return zip.toBuffer();
}

test('parses table search results into normalized metadata', () => {
  const results = parseSearchResults(searchHtml, 'https://catalog.example.test');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    id: '0123456789abcdef0123456789abcdef',
    title: "Alice's Adventures in Wonderland",
    author: 'Lewis Carroll',
    format: 'epub',
    cover: 'https://catalog.example.test/covers/alice.jpg',
    detailUrl: 'https://catalog.example.test/md5/0123456789abcdef0123456789abcdef',
  });
  assert.equal(results[1].format, 'pdf');
});

test('only resolves direct supported files on an operator-approved host', () => {
  const approved = new Set(['files.example.test']);
  assert.deepEqual(parseDirectAcquisition(
    detailHtml,
    'https://catalog.example.test/md5/0123456789abcdef0123456789abcdef',
    approved,
    'epub',
  ), { url: 'https://files.example.test/public-domain/alice.epub', format: 'epub' });
  assert.equal(parseDirectAcquisition(detailHtml, 'https://catalog.example.test/book', new Set(), 'epub'), null);
});

test('CBR remains metadata-only for the provider trial', async () => {
  const cbrHtml = searchHtml.replace(/epub/gi, 'cbr');
  let detailRequests = 0;
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    directHosts: ['files.example.test'],
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchHtml: async url => {
      if (!url.includes('/search?')) detailRequests++;
      return url.includes('/search?') ? cbrHtml : detailHtml;
    },
  });
  const feed = await provider.search('alice', { userId: 1 });
  assert.equal(feed.entries[0].summary, '');
  assert.equal(feed.entries[0].acqHref, '');
  assert.equal(detailRequests, 1, 'the unchanged PDF fixture row may still resolve details');
  assert.equal(validateBookBuffer(Buffer.concat([Buffer.from('Rar!\x1a\x07'), Buffer.alloc(128)]), 'application/x-rar', 'cbr'), false);
});

test('parser stops at bounded row and anchor counts', () => {
  const validRow = searchHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/i)[0];
  const emptyRows = '<tr><td>x</td></tr>'.repeat(200);
  assert.equal(parseSearchResults(`${emptyRows}${validRow}`, 'https://catalog.example.test').length, 0);

  const approved = new Set(['files.example.test']);
  const decoys = '<a href="https://other.example.test/nope">Nope</a>'.repeat(200);
  const valid = '<a href="https://files.example.test/book.epub">Download EPUB</a>';
  assert.equal(parseDirectAcquisition(`${decoys}${valid}`, 'https://catalog.example.test/book', approved, 'epub'), null);
});

test('non-finite and excessive provider settings fall back or clamp', () => {
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    searchLimit: Infinity,
    maxBookBytes: Infinity,
    cacheTtlMs: NaN,
    cacheMaxPerUser: Infinity,
    cacheMaxUsers: -Infinity,
    searchTimeoutMs: Infinity,
    downloadTimeoutMs: 999999999,
    detailConcurrency: Infinity,
  });
  assert.equal(provider.searchLimit, 12);
  assert.equal(provider.maxBookBytes, 150 * 1024 * 1024);
  assert.equal(provider.cacheTtlMs, 15 * 60_000);
  assert.equal(provider.cacheMaxPerUser, 100);
  assert.equal(provider.cacheMaxUsers, 1000);
  assert.equal(provider.searchTimeoutMs, 15_000);
  assert.equal(provider.downloadTimeoutMs, 120_000);
  assert.equal(provider.detailConcurrency, 3);
  assert.equal(finiteEnv('Infinity', 12, 1, 30), 12);
  assert.equal(finiteEnv('', 12, 1, 30), 12);
  assert.equal(finiteEnv('999', 12, 1, 30), 30);
});

test('overall search deadline bounds unresolved provider work', async () => {
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchHtml: async () => new Promise(() => {}),
  });
  provider.searchTimeoutMs = 25;
  const started = Date.now();
  await assert.rejects(provider.search('alice', { userId: 1 }), /error\.external_timeout/);
  assert.ok(Date.now() - started < 250);
});

test('provider returns opaque user-bound references and validates acquisition bytes', async () => {
  const epub = makeEpub();
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    directHosts: ['files.example.test'],
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchHtml: async url => url.includes('/search?') ? searchHtml : detailHtml,
    fetchAsset: async () => ({ ok: true, status: 200, contentType: 'application/epub+zip', buffer: epub }),
  });

  const feed = await provider.search('alice', { userId: 7 });
  assert.equal(feed.entries.length, 2);
  const entry = feed.entries[0];
  assert.match(entry.acqHref, /^provider:anna:acquire:[A-Za-z0-9_-]{32}$/);
  assert.ok(!entry.acqHref.includes('0123456789abcdef'));

  const asset = await provider.fetchAcquisition(entry.acqHref, { userId: 7 });
  assert.equal(asset.ok, true);
  assert.equal(asset.format, 'epub');
  assert.deepEqual(asset.buffer, epub);
  asset.release();
  assert.equal((await provider.fetchAcquisition(entry.acqHref, { userId: 8 })).status, 410);
  assert.equal((await provider.fetchAcquisition('provider:anna:acquire:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { userId: 7 })).status, 410);
});

test('metadata-only mode never exposes Add or Peek acquisition references', async () => {
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchHtml: async () => searchHtml,
  });
  const feed = await provider.search('alice', { userId: 1 });
  assert.ok(feed.entries.every(entry => entry.acqHref === ''));
});

test('book magic and private-address checks reject unsafe responses', () => {
  const epub = makeEpub();
  const cbz = makeCbz();
  const html = Buffer.concat([Buffer.from('<!doctype html>'), Buffer.alloc(256)]);
  assert.equal(validateBookBuffer(epub, 'application/epub+zip', 'epub'), true);
  assert.equal(validateBookBuffer(epub, 'application/zip', 'cbz'), false);
  assert.equal(validateBookBuffer(cbz, 'application/octet-stream', 'cbz'), true);
  assert.equal(validateBookBuffer(cbz, 'application/octet-stream', 'epub'), false);
  assert.equal(hasSafeDeclaredArchiveSizes([{ header: { size: 64 * 1024 * 1024 + 1 } }]), false);
  assert.equal(hasSafeDeclaredArchiveSizes(Array.from({ length: 9 }, () => ({ header: { size: 64 * 1024 * 1024 } }))), false);
  assert.equal(hasSafeDeclaredArchiveSizes([{ header: { size: 1024 } }]), true);
  assert.equal(validateBookBuffer(html, 'text/html', 'epub'), false);
  assert.equal(detectImageContentType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)])), 'image/jpeg');
  assert.equal(detectImageContentType(html), '');
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('192.0.2.10'), true);
  assert.equal(isPrivateAddress('100.64.12.3'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:c0a8:101'), true);
  assert.equal(isPrivateAddress('::ffff:0808:0808'), false);
  assert.equal(isPrivateAddress('::192.168.1.1'), true);
  assert.equal(isPrivateAddress('64:ff9b::c0a8:101'), true);
  assert.equal(isPrivateAddress('fe80::1'), true);
  assert.equal(isPrivateAddress('fec0::1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('2001:db8::1'), true);
  assert.equal(isPrivateAddress('ff02::1'), true);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
  assert.equal(mappedIpv4('::ffff:c0a8:101'), '192.168.1.1');
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('per-user cache is LRU bounded and expired references ask the client to search again', async () => {
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    directHosts: ['files.example.test'],
    cacheMaxPerUser: 10,
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchHtml: async url => url.includes('/search?') ? searchHtml : detailHtml,
    fetchAsset: async () => ({ ok: true, status: 200, contentType: 'application/octet-stream', buffer: makeEpub() }),
  });
  const feed = await provider.search('alice', { userId: 42 });
  const token = feed.entries[0].acqHref.split(':').at(-1);
  provider.cache.get('42').get(token).expiresAt = 0;
  const expired = await provider.fetchAcquisition(feed.entries[0].acqHref, { userId: 42 });
  assert.equal(expired.status, 410);
  assert.equal(expired.error, 'error.external_reference_expired');
});

test('global user cache is LRU bounded and sweeps users whose entries expired', () => {
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    cacheMaxUsers: 10,
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
  });
  const tokens = new Map();
  for (let userId = 1; userId <= 10; userId++) {
    tokens.set(userId, provider._put(userId, { id: `book-${userId}` }));
  }
  provider._lookup(1, `provider:anna:cover:${tokens.get(1)}`, 'cover'); // touch user 1
  provider._put(11, { id: 'book-11' });
  assert.equal(provider.cache.size, 10);
  assert.equal(provider.cache.has('1'), true);
  assert.equal(provider.cache.has('2'), false);

  const userThree = provider.cache.get('3');
  for (const value of userThree.values()) value.expiresAt = 0;
  provider._put(12, { id: 'book-12' });
  assert.equal(provider.cache.has('3'), false);
  assert.equal(provider.cache.size, 10);
});

test('acquisition permit and byte reservation remain held until the consumer releases them', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    acquisitionGlobalLimit: 1,
    acquisitionPerUserLimit: 1,
    downloadTimeoutMs: 5000,
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchAsset: async () => pending,
  });
  const firstToken = provider._put(1, {
    id: 'first', acquisition: { url: 'https://files.example.test/first.epub', format: 'epub' },
  });
  const secondToken = provider._put(2, {
    id: 'second', acquisition: { url: 'https://files.example.test/second.epub', format: 'epub' },
  });
  const first = provider.fetchAcquisition(`provider:anna:acquire:${firstToken}`, { userId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const busy = await provider.fetchAcquisition(`provider:anna:acquire:${secondToken}`, { userId: 2 });
  assert.equal(busy.status, 429);
  assert.equal(busy.error, 'error.external_busy');
  assert.equal(provider.activeAcquisitionsByUser.size, 1);
  finish({ ok: true, status: 200, contentType: 'application/epub+zip', buffer: makeEpub() });
  const asset = await first;
  assert.equal(asset.ok, true);
  assert.equal(provider.activeAcquisitions, 1);
  assert.equal(provider.activeAcquisitionsByUser.size, 1);
  asset.release();
  assert.equal(provider.activeAcquisitions, 0);
  assert.equal(provider.activeAcquisitionsByUser.size, 0);
});

test('process-wide acquisition byte budget rejects a second reserved maximum', async () => {
  const options = {
    baseUrl: 'https://catalog.example.test',
    maxBookBytes: 1024 * 1024,
    acquisitionMaxInflightBytes: 1024 * 1024,
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchAsset: async () => ({ ok: true, status: 200, contentType: 'application/epub+zip', buffer: makeEpub() }),
  };
  const firstProvider = new AnnaArchiveProvider({ ...options, id: 'bytes-one' });
  const secondProvider = new AnnaArchiveProvider({ ...options, id: 'bytes-two' });
  const firstToken = firstProvider._put(1, {
    id: 'first', acquisition: { url: 'https://files.example.test/first.epub', format: 'epub' },
  });
  const secondToken = secondProvider._put(2, {
    id: 'second', acquisition: { url: 'https://files.example.test/second.epub', format: 'epub' },
  });

  const first = await firstProvider.fetchAcquisition(`provider:bytes-one:acquire:${firstToken}`, { userId: 1 });
  assert.equal(first.ok, true);
  const busy = await secondProvider.fetchAcquisition(`provider:bytes-two:acquire:${secondToken}`, { userId: 2 });
  assert.equal(busy.status, 429);
  assert.equal(busy.error, 'error.external_busy');
  first.release();
  const second = await secondProvider.fetchAcquisition(`provider:bytes-two:acquire:${secondToken}`, { userId: 2 });
  assert.equal(second.ok, true);
  second.release();
});

test('search and cover work enforce per-user concurrency and release permits', async () => {
  let finishSearch;
  const pendingSearch = new Promise(resolve => { finishSearch = resolve; });
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    searchGlobalLimit: 2,
    searchPerUserLimit: 1,
    coverGlobalLimit: 2,
    coverPerUserLimit: 1,
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchHtml: async () => pendingSearch,
  });
  const firstSearch = provider.search('alice', { userId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(provider.search('rabbit', { userId: 1 }), /error\.external_busy/);
  finishSearch('<table></table>');
  await firstSearch;
  assert.equal(provider.activeSearches, 0);
  assert.equal(provider.activeSearchesByUser.size, 0);

  let finishCover;
  const pendingCover = new Promise(resolve => { finishCover = resolve; });
  provider.fetchCoverAssetOverride = async () => pendingCover;
  const token = provider._put(1, { id: 'cover', cover: 'https://catalog.example.test/cover.jpg' });
  const reference = `provider:anna:cover:${token}`;
  const firstCover = provider.fetchCover(reference, { userId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const busyCover = await provider.fetchCover(reference, { userId: 1 });
  assert.equal(busyCover.status, 429);
  finishCover({
    ok: true,
    status: 200,
    contentType: 'image/jpeg',
    buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]),
  });
  assert.equal((await firstCover).ok, true);
  assert.equal(provider.activeCovers, 0);
  assert.equal(provider.activeCoversByUser.size, 0);
});

test('search and cover global limits reject work from another user', async () => {
  let finishSearch;
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    searchGlobalLimit: 1,
    searchPerUserLimit: 2,
    coverGlobalLimit: 1,
    coverPerUserLimit: 2,
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
    fetchHtml: async () => new Promise(resolve => { finishSearch = resolve; }),
  });
  const firstSearch = provider.search('alice', { userId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(provider.search('rabbit', { userId: 2 }), /error\.external_busy/);
  finishSearch('<table></table>');
  await firstSearch;

  let finishCover;
  provider.fetchCoverAssetOverride = async () => new Promise(resolve => { finishCover = resolve; });
  const firstToken = provider._put(1, { id: 'cover-one', cover: 'https://catalog.example.test/one.jpg' });
  const secondToken = provider._put(2, { id: 'cover-two', cover: 'https://catalog.example.test/two.jpg' });
  const firstCover = provider.fetchCover(`provider:anna:cover:${firstToken}`, { userId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const busy = await provider.fetchCover(`provider:anna:cover:${secondToken}`, { userId: 2 });
  assert.equal(busy.status, 429);
  finishCover({
    ok: true,
    status: 200,
    contentType: 'image/jpeg',
    buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]),
  });
  assert.equal((await firstCover).ok, true);
});

test('cache byte budget evicts the oldest user without scanning unrelated users', () => {
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    cacheMaxBytes: 64 * 1024,
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
  });
  provider._put(1, { id: 'one', title: 'a'.repeat(40 * 1024) });
  provider._put(2, { id: 'two', title: 'b'.repeat(40 * 1024) });
  assert.equal(provider.cache.has('1'), false);
  assert.equal(provider.cache.has('2'), true);
  assert.ok(provider.cacheBytes <= provider.cacheMaxBytes);

  const staleToken = provider._put(3, { id: 'stale' });
  provider.cache.get('3').get(staleToken).expiresAt = 0;
  provider._put(4, { id: 'fresh' });
  assert.equal(provider.cache.has('3'), true, 'unrelated users are not fully swept on every insert');
  assert.equal(provider._lookup(3, `provider:anna:cover:${staleToken}`, 'cover').status, 410);
  assert.equal(provider.cache.has('3'), false, 'expired entries are pruned when their user is accessed');
});

test('opaque references require the expected provider action and exact prefix', async () => {
  const provider = new AnnaArchiveProvider({
    baseUrl: 'https://catalog.example.test',
    referenceSecret: 'test-only-reference-secret-with-sufficient-entropy',
  });
  const token = provider._put(1, { id: 'book', cover: 'https://catalog.example.test/cover.jpg' });
  assert.equal((await provider.fetchCover(`wrong:prefix:cover:${token}`, { userId: 1 })).status, 404);
  assert.equal((await provider.fetchCover(`provider:anna:acquire:${token}`, { userId: 1 })).status, 404);
});

test('safe fetch pins the validated address, preserves Host, and revalidates redirect hosts', async () => {
  const originalLookup = dns.lookup;
  const originalRequest = http.request;
  const requests = [];
  let redirect = false;
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  http.request = (options, callback) => {
    requests.push(options);
    const req = new EventEmitter();
    req.end = () => {
      const response = Readable.from(redirect ? [] : [Buffer.from('fixture')]);
      response.statusCode = redirect ? 302 : 200;
      response.headers = redirect
        ? { location: 'http://blocked.example.test/file.epub' }
        : { 'content-type': 'application/octet-stream' };
      callback(response);
    };
    req.destroy = error => req.emit('error', error);
    return req;
  };
  try {
    const result = await safeFetch('http://catalog.example.test/book', {
      allowedHosts: new Set(['catalog.example.test']),
    });
    assert.equal(result.ok, true);
    assert.equal(requests[0].hostname, '93.184.216.34');
    assert.equal(requests[0].headers.Host, 'catalog.example.test');

    redirect = true;
    await assert.rejects(
      safeFetch('http://catalog.example.test/redirect', {
        allowedHosts: new Set(['catalog.example.test']),
      }),
      /error\.external_host_not_allowed/,
    );
    assert.equal(requests.length, 2, 'redirect target was rejected before opening another connection');
  } finally {
    dns.lookup = originalLookup;
    http.request = originalRequest;
  }
});

test('safe HTTPS fetch falls back across validated addresses and preserves TLS SNI', async () => {
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  const requests = [];
  dns.lookup = async () => [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ];
  https.request = (options, callback) => {
    requests.push(options);
    const req = new EventEmitter();
    req.end = () => {
      if (options.family === 6) return req.emit('error', new Error('ENETUNREACH'));
      const response = Readable.from([Buffer.from('tls fixture')]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/octet-stream' };
      callback(response);
    };
    req.destroy = error => req.emit('error', error);
    return req;
  };
  try {
    const result = await safeFetch('https://catalog.example.test/book', {
      allowedHosts: new Set(['catalog.example.test']),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(requests.map(item => item.hostname), ['2606:4700:4700::1111', '1.1.1.1']);
    assert.ok(requests.every(item => item.servername === 'catalog.example.test'));
    assert.ok(requests.every(item => item.headers.Host === 'catalog.example.test'));
  } finally {
    dns.lookup = originalLookup;
    https.request = originalRequest;
  }
});

test('safe fetch enforces one wall-clock deadline while a body trickles data', async () => {
  const originalLookup = dns.lookup;
  const originalRequest = http.request;
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  http.request = (options, callback) => {
    const req = new EventEmitter();
    let response;
    req.end = () => {
      let interval;
      response = new Readable({
        read() {
          if (interval) return;
          interval = setInterval(() => this.push(Buffer.from('x')), 5);
          this.once('close', () => clearInterval(interval));
        },
      });
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/octet-stream' };
      callback(response);
    };
    req.destroy = error => {
      req.emit('error', error);
      response?.destroy(error);
    };
    return req;
  };
  const started = Date.now();
  try {
    await assert.rejects(
      safeFetch('http://catalog.example.test/slow', {
        allowedHosts: new Set(['catalog.example.test']),
        timeoutMs: 30,
      }),
      /error\.external_timeout/,
    );
    assert.ok(Date.now() - started < 250);
  } finally {
    dns.lookup = originalLookup;
    http.request = originalRequest;
  }
});

test('safe fetch wall-clock deadline also bounds DNS resolution', async () => {
  const originalLookup = dns.lookup;
  dns.lookup = async () => new Promise(() => {});
  const started = Date.now();
  try {
    await assert.rejects(
      safeFetch('http://catalog.example.test/book', {
        allowedHosts: new Set(['catalog.example.test']),
        timeoutMs: 25,
      }),
      /error\.external_timeout/,
    );
    assert.ok(Date.now() - started < 250);
  } finally {
    dns.lookup = originalLookup;
  }
});
