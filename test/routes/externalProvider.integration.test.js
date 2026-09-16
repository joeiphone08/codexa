const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const AdmZip = require('adm-zip');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexa-provider-integration-'));
process.env.DATA_DIR = testDataDir;
process.env.JWT_SECRET = 'integration-test-secret-that-is-deliberately-longer-than-sixty-four-characters';

const { initDb, getDb, closeDb } = require('../../server/db');
const { signToken } = require('../../server/routes/auth');
const { AnnaArchiveProvider } = require('../../server/providers/annaArchive');
const { registry } = require('../../server/providers');

function makePublicDomainEpub() {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  ));
  zip.addFile('OEBPS/content.opf', Buffer.from(
    '<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '<dc:title>Alice\'s Adventures in Wonderland</dc:title><dc:creator>Lewis Carroll</dc:creator>' +
    '<dc:language>en</dc:language></metadata><manifest/><spine/></package>',
  ));
  zip.addFile('OEBPS/chapter.xhtml', Buffer.from('<html><body><p>Public domain test fixture.</p></body></html>'));
  return zip.toBuffer();
}

function makeCbz() {
  const zip = new AdmZip();
  zip.addFile('001.png', Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(512),
  ]));
  return zip.toBuffer();
}

function searchHtml() {
  const row = (md5, title, author, format) => `<tr>
    <td><a href="/md5/${md5}">detail</a></td><td>${title}</td><td>${author}</td>
    <td></td><td></td><td></td><td></td><td></td><td></td><td>${format}</td>
  </tr>`;
  return `<table>${row('0123456789abcdef0123456789abcdef', "Alice's Adventures", 'Lewis Carroll', 'EPUB')}
    ${row('fedcba9876543210fedcba9876543210', 'Public Domain Comic', 'Example Artist', 'CBZ')}</table>`;
}

function request(server, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: url,
      method,
      headers: {
        ...headers,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        } : {}),
      },
      agent: false,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Integration request timed out')));
    req.end(payload);
  });
}

test('authenticated provider search imports structurally valid EPUB and preserves CBZ through generic MIME', async t => {
  t.after(() => {
    closeDb();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });
  initDb();
  const db = getDb();
  const user = db.prepare("INSERT INTO users (username, name, password_hash) VALUES ('reader', 'Reader', 'unused')").run();
  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(user.lastInsertRowid);
  const token = signToken({ id: user.lastInsertRowid, username: 'reader', name: 'Reader' });

  const epub = makePublicDomainEpub();
  const cbz = makeCbz();
  const provider = new AnnaArchiveProvider({
    id: 'fixture',
    name: 'Fixture Books',
    baseUrl: 'https://catalog.example.test',
    directHosts: ['files.example.test'],
    referenceSecret: 'integration-test-provider-reference-secret',
    fetchHtml: async url => {
      if (url.includes('q=blocked')) throw new Error('HTTP 403');
      if (url.includes('q=limited')) throw new Error('HTTP 429');
      if (url.includes('/search?')) return searchHtml();
      if (url.includes('0123456789abcdef')) return '<a download href="https://files.example.test/alice.epub">Download EPUB</a>';
      return '<a download href="https://files.example.test/comic.cbz">Download CBZ</a>';
    },
    fetchAsset: async url => ({
      ok: true,
      status: 200,
      contentType: 'application/octet-stream',
      buffer: url.endsWith('.cbz') ? cbz : epub,
    }),
  });
  registry.register(provider);

  const app = express();
  app.use(express.json());
  app.use('/api/opds', require('../../server/routes/opds'));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  const auth = { authorization: `Bearer ${token}` };

  const denied = await request(server, 'GET', '/api/opds/search/provider:fixture?q=alice');
  assert.equal(denied.status, 401);

  const blocked = await request(server, 'GET', '/api/opds/search/provider:fixture?q=blocked', { headers: auth });
  assert.equal(blocked.status, 502);
  assert.equal(blocked.json().error, 'error.external_search_rejected');
  const limited = await request(server, 'GET', '/api/opds/search/provider:fixture?q=limited', { headers: auth });
  assert.equal(limited.status, 429);
  assert.equal(limited.json().error, 'error.external_busy');

  const search = await request(server, 'GET', '/api/opds/search/provider:fixture?q=alice', { headers: auth });
  assert.equal(search.status, 200);
  const feed = search.json();
  assert.equal(feed.entries.length, 2);
  assert.equal(feed.entries[0].acqType, 'application/epub+zip');
  assert.equal(feed.entries[1].acqType, 'application/vnd.comicbook+zip');

  for (const entry of feed.entries) {
    const imported = await request(server, 'POST', '/api/opds/download/provider:fixture', {
      headers: auth,
      body: { href: entry.acqHref, title: entry.title, author: entry.author },
    });
    assert.equal(imported.status, 201, imported.text);
  }
  assert.equal(provider.activeAcquisitions, 0, 'route releases acquisition permits after import processing');

  const rows = db.prepare('SELECT title, author, format, filename FROM books ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.format), ['epub', 'cbz']);
  assert.match(rows[0].filename, /\.epub$/);
  assert.match(rows[1].filename, /\.cbz$/);
  assert.equal(rows[0].title, "Alice's Adventures in Wonderland");
  assert.equal(rows[0].author, 'Lewis Carroll');

  const peek = await request(server, 'POST', '/api/opds/peek/provider:fixture', {
    headers: auth,
    body: { href: feed.entries[1].acqHref, title: feed.entries[1].title, author: feed.entries[1].author },
  });
  assert.equal(peek.status, 201);
  assert.equal(peek.json().ephemeral, false);

});
