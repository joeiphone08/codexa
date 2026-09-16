/**
 * epub.js — server-side EPUB metadata + cover extraction
 * Treats EPUB files as ZIP archives and parses the OPF XML directly.
 */

const AdmZip      = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');

const xmlParser = new XMLParser({
  ignoreAttributes:     false,
  attributeNamePrefix:  '@_',
  textNodeName:         '#text',
  allowBooleanAttributes: true,
  parseAttributeValue:  false,
  processEntities:      false,   // decode manually so entity-encoded HTML doesn't confuse the parser
  isArray: (name) => ['item', 'opf:item', 'meta', 'opf:meta', 'dc:creator', 'dc:title'].includes(name),
});

// Decode standard XML/HTML entities (manual, since processEntities is off)
function decodeEntities(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g,            (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// ── Archive-entry safety limits ───────────────────────────────────────────────
// Every byte below comes out of an untrusted, user-uploaded ZIP. adm-zip inflates an entry
// straight into a Buffer sized by that entry's OWN declared uncompressed length, so a tiny
// "zip bomb" (a few KB of highly-compressible data declaring gigabytes) makes a single
// getData() call allocate gigabytes and OOM-kill the whole container. Check the declared
// size first and skip the entry instead — a real container.xml/OPF/ComicInfo.xml is a few
// KB, and a real cover image is a few MB.
const MAX_XML_BYTES   = 16 * 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;

function readEntryCapped(entry, maxBytes, label) {
  const declared = entry?.header?.size ?? 0;
  if (declared > maxBytes) {
    console.warn(`[epub] skipping oversized ${label} entry (${declared} bytes declared)`);
    return null;
  }
  const data = entry.getData();
  if (data.length > maxBytes) {
    console.warn(`[epub] skipping oversized ${label} entry (${data.length} bytes)`);
    return null;
  }
  return data;
}

// The cover's filename extension is taken from an href inside the uploaded file's own OPF
// manifest (or from a ZIP entry name), and the resulting file is served unauthenticated from
// /covers by express.static — a path that gets no per-page CSP (server/index.js only applies
// one to files that exist under SERVE_DIR). An href of "cover.svg" or "cover.html" declared
// with an image/* media-type would therefore publish attacker-authored, script-executing,
// SAME-ORIGIN content on this server; anyone who opens that link has their JWT (localStorage
// 'br_token') read straight out from under them. Only ever write an extension whose served
// content-type cannot execute script.
const SAFE_COVER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);

// Prefer the extension the BYTES say, not the one the archive claims, so a legitimate cover
// always lands with the content-type express.static will actually serve it as.
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)                      return '.jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png';
  if (buf.toString('ascii', 0, 3) === 'GIF')                                      return '.gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buf.toString('ascii', 0, 2) === 'BM')                                       return '.bmp';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && buf.toString('ascii', 8, 12).startsWith('avi')) return '.avif';
  return null;
}

// Returns the extension to publish this cover under, or null meaning "don't publish it at all".
// Falling back to the declared extension is only ever allowed for a known raster type: an
// href of "cover.svg"/"cover.html" (or a bare "cover" with an HTML body) declared with an
// image/* media-type would otherwise land as script-executing, SAME-ORIGIN content under
// /covers — which express.static serves unauthenticated and which gets no CSP at all
// (server/index.js only builds one for files that exist under SERVE_DIR). Anyone who opened
// that link would have their JWT (localStorage 'br_token') read straight out from under them.
// A cover we refuse to publish just falls back to the same placeholder any coverless book gets.
function coverExtFor(buf, name) {
  const sniffed = sniffImageExt(buf);
  if (sniffed) return sniffed;
  const ext = path.extname(String(name || '')).toLowerCase();
  return SAFE_COVER_EXTS.has(ext) ? ext : null;
}

// ── File hash ─────────────────────────────────────────────────────────────────
function computeFileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 40);
}

// KOReader partial MD5 — exact port of util.partialMD5 from KOReader Lua source.
// Reads up to 12 sparse 1 KB chunks at offsets: lshift(1024, 2*i) for i = -1..10
// i = -1 → 256, i = 0 → 1024, i = 1 → 4096, … i = 10 → 1073741824
// JS << with negative count is wrong (treats as unsigned mod 32), so we use >> for i < 0.
function computeFileMd5(filePath) {
  console.log('[md5] computing partial MD5 for:', filePath);
  const fd   = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('md5');
  const buf  = Buffer.alloc(1024);
  try {
    for (let i = -1; i <= 10; i++) {
      const offset    = i < 0 ? 0 : (1024 << (2 * i));
      const bytesRead = fs.readSync(fd, buf, 0, 1024, offset);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  const result = hash.digest('hex');
  console.log('[md5] result:', result);
  return result;
}

// ── Get string value from a parsed dc: element ───────────────────────────────
function dcText(val) {
  if (!val) return '';
  const first = Array.isArray(val) ? val[0] : val;
  let text;
  if (typeof first === 'string') text = first.trim();
  else if (typeof first === 'object') text = String(first['#text'] || '').trim();
  else return '';
  return decodeEntities(text);
}

// ── Main extraction function ──────────────────────────────────────────────────
function extractEpubMetadata(epubPath, coversDir, fileHash) {
  // title deliberately starts empty rather than falling back to the filename — epubPath is
  // always the hash-renamed destination file (e.g. "<hash>.epub") by the time this runs in
  // every caller, so a filename-derived fallback here would just be the hash, masking the
  // fact that no real title was found and preventing callers (BookOrbit/OPDS import, upload)
  // from falling back to a better source (the catalog entry's own title, the original upload
  // filename). Callers are responsible for the final "nothing found at all" fallback.
  const result = { title: '', author: '', cover_path: '', series_name: '', series_number: '', description: '', publisher: '', language: '', isbn: '', genres: '', pages: '' };

  try {
    const zip = new AdmZip(epubPath);

    // 1. Locate the OPF file via META-INF/container.xml
    const containerEntry = zip.getEntry('META-INF/container.xml');
    if (!containerEntry) return result;

    const containerData = readEntryCapped(containerEntry, MAX_XML_BYTES, 'container.xml');
    if (!containerData) return result;

    const container = xmlParser.parse(containerData.toString('utf8'));
    const rootfiles  = container?.container?.rootfiles?.rootfile;
    const rootfile   = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
    const opfPath    = rootfile?.['@_full-path'];
    if (!opfPath) return result;

    // 2. Parse the OPF file
    const opfEntry = zip.getEntry(opfPath);
    if (!opfEntry) return result;

    const opfData = readEntryCapped(opfEntry, MAX_XML_BYTES, 'OPF');
    if (!opfData) return result;

    const opf = xmlParser.parse(opfData.toString('utf8'));
    // Some EPUB2 files (real-world example: an older publish, later metadata-edited by
    // Calibre, which preserves the prefixed form) put a namespace prefix directly on the
    // package/metadata/manifest/item elements themselves (<opf:package>, <opf:metadata>, ...)
    // instead of leaving them unprefixed under a default xmlns — fast-xml-parser keeps
    // whatever prefix the source XML actually used (no removeNSPrefix here, same as the
    // dc:*/opf:meta handling throughout this function), so both spellings need checking at
    // each level. Confirmed via a real reported file: without this, opf?.package is
    // undefined, extraction silently returns empty, and the book imports with no metadata
    // or cover at all despite the file itself having complete metadata.
    const pkg      = opf?.package ?? opf?.['opf:package'];
    const metadata = pkg?.metadata ?? pkg?.['opf:metadata'];
    if (!metadata) {
      // Distinguishes "this file genuinely has no OPF metadata" from "the parser didn't
      // recognise this file's structure" — the latter used to fail silently here, which is
      // exactly what made the namespace-prefix case above hard to tell apart from a real
      // empty file until someone dug into the parsed object by hand.
      console.warn(`[epub] no <metadata> found in OPF (unrecognised structure?): ${opfPath}`);
      return result;
    }

    // Title
    const titleVal = dcText(metadata['dc:title']);
    if (titleVal) result.title = titleVal;

    // Author (may have multiple creators)
    const creatorVal = dcText(metadata['dc:creator']);
    if (creatorVal) result.author = creatorVal;

    // Description
    const descRaw = metadata['dc:description'];
    if (descRaw) result.description = dcText(descRaw);

    // Publisher
    const pubRaw = metadata['dc:publisher'];
    if (pubRaw) result.publisher = dcText(pubRaw);

    // Language
    const langRaw = metadata['dc:language'];
    if (langRaw) result.language = dcText(langRaw);

    // Genres (dc:subject — may appear multiple times)
    const subjectRaw = metadata['dc:subject'];
    if (subjectRaw) {
      const subjects = Array.isArray(subjectRaw) ? subjectRaw : [subjectRaw];
      result.genres = subjects.map(s => dcText(s)).filter(Boolean).join(', ');
    }

    // ISBN — from dc:identifier with scheme ISBN or urn:isbn: prefix
    const identRaw = metadata['dc:identifier'];
    if (identRaw) {
      const identList = Array.isArray(identRaw) ? identRaw : [identRaw];
      for (const id of identList) {
        const scheme = String(id?.['@_opf:scheme'] || id?.['@_scheme'] || '').toUpperCase();
        const text   = decodeEntities(typeof id === 'string' ? id.trim() : String(id?.['#text'] || '').trim());
        const clean  = text.replace(/^urn:isbn:/i, '').replace(/[-\s]/g, '');
        if (scheme === 'ISBN' || /^(978|979)\d{10}$/.test(clean) || /^\d{10}$/.test(clean)) {
          result.isbn = text.replace(/^urn:isbn:/i, '');
          break;
        }
      }
    }

    // Collect <meta> elements — may appear as 'meta' or 'opf:meta' depending on namespace
    const metasRaw = [
      ...(Array.isArray(metadata?.meta)       ? metadata.meta       : metadata?.meta       ? [metadata.meta]       : []),
      ...(Array.isArray(metadata?.['opf:meta']) ? metadata['opf:meta'] : metadata?.['opf:meta'] ? [metadata['opf:meta']] : []),
    ];
    // Normalise: strip any 'opf:' prefix from property/name attributes
    const metas = metasRaw.map(m => ({
      ...m,
      '@_property': String(m['@_property'] || '').replace(/^opf:/, ''),
      '@_name':     String(m['@_name']     || '').replace(/^opf:/, ''),
    }));

    // Calibre series tags + page count from named/property metas
    for (const m of metas) {
      if (m['@_name'] === 'calibre:series')        result.series_name   = decodeEntities(String(m['@_content'] || '').trim());
      if (m['@_name'] === 'calibre:series_index')  result.series_number = decodeEntities(String(m['@_content'] || '').trim());
      if (!result.pages && ['calibre:num_pages', 'schema:numberOfPages'].includes(m['@_name'])) {
        const v = String(m['@_content'] || '').trim();
        if (v && v !== '0') result.pages = v;
      }
      if (!result.pages && ['schema:numberOfPages', 'numberOfPages'].includes(m['@_property'])) {
        const v = String(m['#text'] || '').trim();
        if (v && v !== '0') result.pages = v;
      }
    }
    // EPUB 3: belongs-to-collection + group-position (linked via refines="#id")
    if (!result.series_name) {
      // Find all collection metas that have an id
      const collections = metas.filter(m => m['@_property'] === 'belongs-to-collection' && m['@_id']);
      for (const col of collections) {
        const colId    = col['@_id'];
        const position = metas.find(m => m['@_property'] === 'group-position' && m['@_refines'] === `#${colId}`);
        result.series_name   = decodeEntities(String(col['#text'] || '').trim());
        result.series_number = position ? decodeEntities(String(position['#text'] || '').trim()) : '';
        if (result.series_name) break;
      }
      // Fallback: no refines — just grab first of each
      if (!result.series_name) {
        const col = metas.find(m => m['@_property'] === 'belongs-to-collection');
        if (col) {
          result.series_name = decodeEntities(String(col['#text'] || '').trim());
          const pos = metas.find(m => m['@_property'] === 'group-position');
          if (pos) result.series_number = decodeEntities(String(pos['#text'] || '').trim());
        }
      }
    }
    // 3. Find cover image in manifest
    const opfDir   = path.posix.dirname(opfPath); // e.g. "OEBPS" or "."
    const manifestNode = pkg?.manifest ?? pkg?.['opf:manifest'];
    const manifest      = manifestNode?.item ?? manifestNode?.['opf:item'] ?? [];
    const items    = Array.isArray(manifest) ? manifest : [manifest];

    // Determine cover item ID from <meta name="cover"> or <meta property="cover-image">
    let coverId  = null;
    for (const m of metas) {
      if (m['@_name'] === 'cover')           { coverId = m['@_content']; break; }
      if (m['@_property'] === 'cover-image') { coverId = String(m['#text'] || '').trim(); break; }
    }

    // Cover must be an actual image item (not an xhtml wrapper page)
    const isImageItem = i => (i['@_media-type'] || '').startsWith('image/');

    let coverItem = null;

    // 1. Highest priority: item with properties="cover-image" that is an image
    coverItem = items.find(i =>
      (i['@_properties'] || '').includes('cover-image') && isImageItem(i)
    );

    // 2. Item whose id matches <meta name="cover"> and is an image
    if (!coverItem && coverId) {
      const byId = items.find(i => i['@_id'] === coverId);
      if (byId && isImageItem(byId)) coverItem = byId;
    }

    // 2b. Some non-compliant EPUB2 files put the image's href directly in <meta name="cover">
    // content= instead of an item id (spec violation, but seen from real-world converters —
    // confirmed on a book whose cover was otherwise undetectable: content="Images/xyz.jpg"
    // with no item id or filename containing "cover" at all). Match content against href too.
    if (!coverItem && coverId) {
      const byHref = items.find(i => (i['@_href'] || '').toLowerCase() === coverId.toLowerCase());
      if (byHref && isImageItem(byHref)) coverItem = byHref;
    }

    // 3. Item with id="cover" or id="cover-image" that is an image
    if (!coverItem) {
      coverItem = items.find(i =>
        ['cover', 'cover-image'].includes((i['@_id'] || '').toLowerCase()) && isImageItem(i)
      );
    }

    // 4. Any image item whose href contains "cover"
    if (!coverItem) {
      coverItem = items.find(i =>
        isImageItem(i) && (i['@_href'] || '').toLowerCase().includes('cover')
      );
    }

    // 5. Last resort: properties="cover-image" even without image media-type declared
    if (!coverItem) {
      coverItem = items.find(i => (i['@_properties'] || '').includes('cover-image'));
    }

    if (coverItem) {
      const coverHref     = coverItem['@_href'];
      const zipCoverPath  = opfDir === '.' ? coverHref
                          : `${opfDir}/${coverHref}`;

      // adm-zip normalises separators — try both slash styles
      const coverEntry = zip.getEntry(zipCoverPath)
                      || zip.getEntry(zipCoverPath.replace(/\//g, '\\'));

      if (coverEntry) {
        const coverData = readEntryCapped(coverEntry, MAX_COVER_BYTES, 'cover');
        const coverExt  = coverData && coverExtFor(coverData, coverHref);
        if (coverExt) {
          const coverFilename = `${fileHash}${coverExt}`;
          fs.writeFileSync(path.join(coversDir, coverFilename), coverData);
          result.cover_path = coverFilename;
        } else if (coverData) {
          console.warn(`[epub] cover not published — not a recognised image: ${coverHref}`);
        }
      }
    }
  } catch (err) {
    console.error('[epub] metadata extraction failed:', err.message);
  }

  return result;
}

// ── CBZ metadata extraction ───────────────────────────────────────────────────
function extractCbzMetadata(cbzPath, coversDir, fileHash) {
  const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
  // See extractEpubMetadata's comment above — title starts empty, not filename-derived.
  const result = {
    title: '', author: '', cover_path: '',
    series_name: '', series_number: '', description: '', publisher: '',
    language: '', isbn: '', genres: '', pages: '',
  };

  try {
    const zip = new AdmZip(cbzPath);

    // ComicInfo.xml for title/author
    const ci = zip.getEntry('ComicInfo.xml');
    if (ci) {
      try {
        const ciData = readEntryCapped(ci, MAX_XML_BYTES, 'ComicInfo.xml');
        const parsed = ciData ? xmlParser.parse(ciData.toString('utf8')) : {};
        const info   = parsed?.ComicInfo || parsed?.comicinfo || {};
        const txt    = (v) => (v !== undefined && v !== null) ? decodeEntities(String(v).trim()) : '';
        if (txt(info.Title))   result.title       = txt(info.Title);
        if (txt(info.Series))  result.series_name = txt(info.Series);
        if (txt(info.Number))  result.series_number = txt(info.Number);
        if (txt(info.Summary)) result.description = txt(info.Summary);
        if (txt(info.Genre))   result.genres      = txt(info.Genre);
        // Combine writer and penciller into author field
        const writers = [txt(info.Writer), txt(info.Penciller)].filter(Boolean);
        if (writers.length) result.author = writers.join(', ');
      } catch { /* ignore */ }
    }

    // First sorted image → cover
    const imageEntries = zip.getEntries()
      .filter(e => !e.isDirectory && IMAGE_EXT.test(e.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));

    if (imageEntries.length > 0) {
      result.pages = String(imageEntries.length);
      const first = imageEntries[0];
      try {
        const coverData = readEntryCapped(first, MAX_COVER_BYTES, 'cover');
        const coverExt  = coverData && coverExtFor(coverData, first.entryName);
        if (coverExt) {
          const coverFilename = `${fileHash}${coverExt}`;
          fs.writeFileSync(path.join(coversDir, coverFilename), coverData);
          result.cover_path = coverFilename;
        }
      } catch { /* cover extraction failed */ }
    }
  } catch (err) {
    console.error('[cbz] metadata extraction failed:', err.message);
  }

  return result;
}

module.exports = { computeFileHash, computeFileMd5, extractEpubMetadata, extractCbzMetadata };
