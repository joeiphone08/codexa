# External book provider architecture plan

Status: superseded by the user-approved in-process MVP now implemented in Codexa. The earlier
Librarr bridge analysis remains below as research context; it is no longer the implementation
recommendation.

The accepted rollout keeps Codexa's existing Online Library interface and adds a small provider
contract in `server/providers/`. The first adapter is disabled by default, uses ordinary HTML
only, and exposes Add/Peek solely for structurally validated direct EPUB/PDF/CBZ files on an
operator allowlist. It adds no container and implements no challenge or access-control bypass.

Research snapshot: 2026-09-15. Codexa source was inspected at commit `69b403e764b445423e45af68dae993add649ae22`. Librarr was inspected at commit [`2f98cb302d413893b797355a3c70360228a494d6`](https://github.com/JeremiahM37/librarr/commit/2f98cb302d413893b797355a3c70360228a494d6). The repository named in the request uses the canonical GitHub owner `JeremiahM37`; the `jeremiah-m37` URL does not resolve.

## 1. Current Codexa architecture

Codexa is a static browser application with a Node.js backend:

- Frontend: plain HTML, CSS, and browser JavaScript in `public/`, built with esbuild into `dist/`. It is not React/Vue/Svelte.
- Backend: Express 4 on Node.js 24 (`server/index.js`).
- Database: SQLite through `better-sqlite3`, with WAL and foreign keys enabled (`server/db.js:1-20`).
- Storage: the SQLite database plus user-scoped book files, covers, fonts, and temporary files beneath `DATA_DIR`; Docker sets this to `/data`.
- Deployment: a multi-stage Alpine Docker image. The build stage runs esbuild; the runtime is non-root and exposes port 3000. `docker-compose.sample.yaml` currently defines one `codexa` service and one persistent `codexa_data` volume.
- Supported imported/read formats: EPUB/KEPUB, PDF, CBZ, and CBR converted to CBZ. MOBI and AZW3 are not accepted by the upload or OPDS import paths (`server/routes/books.js:23-48`, `server/routes/opds.js:1041-1155`).
- Authentication: Codexa APIs use its JWT middleware. OPDS upstreams may use no authentication, HTTP Basic, or Calibre-style HTTP Digest.

BookOrbit is an integration with a specific library service, not a general provider interface. Its code has BookOrbit-specific context, API calls, result normalization, asset download, import, and sync functions (`server/services/bookorbitSync.js`, `server/routes/bookorbit.js`). Some import mechanics can inform future refactoring, but there is no `BookProvider` abstraction that OPDS and BookOrbit both implement.

## 2. Existing OPDS implementation

The exact Codexa files are:

| Responsibility | File |
|---|---|
| OPDS upstream configuration UI | `public/settings.html`, `public/js/settings.js:766-926` |
| Catalog browser, search, download, peek, and shelf sync UI | `public/opds.html`, `public/js/opds.js` |
| OPDS proxy, authentication, parsing, search, download, peek, and shelf sync | `server/routes/opds.js` |
| OPDS server configuration and source-link schema | `server/db.js:49-56`, `server/db.js:118-125` |
| Settings persistence | `server/routes/settings.js` |
| Route mount | `server/index.js:311-325` |

### Protocol and authentication

`server/routes/opds.js` is a server-side proxy, which avoids browser CORS restrictions. It parses OPDS 1.x Atom XML and OPDS 2 JSON into one internal entry shape: `id`, `title`, `author`, `summary`, `cover`, one `acqHref`/`acqType`, one `navHref`, and `isNav` (`server/routes/opds.js:455-576`). Relative links are resolved against the fetched feed URL. Pagination is followed for shelf sync, with a 20-page ceiling.

When a configured username exists, `opdsFetch()` first sends Basic authentication and can discover and retry HTTP Digest challenges. Digest state is cached per URL and username (`server/routes/opds.js:330-449`).

There is one security debt relevant to this project: each user's OPDS configuration, including its password, is serialized into the `user_settings.opds_servers` JSON column in plaintext (`server/routes/opds.js:737-770`). BookOrbit and KOReader credentials already use AES-256-GCM through `server/utils/credentialCrypto.js`; OPDS credentials do not. A bridge API key must therefore remain in the bridge container environment and must never be entered in Codexa's OPDS password field.

### Search

`GET /api/opds/search/:id` fetches the configured root feed, locates a `rel=search` link, follows an OpenSearch description when present, substitutes `{searchTerms}`, and fetches the resulting OPDS feed. If discovery fails, it guesses `<catalog-root>/search?q=...` (`server/routes/opds.js:816-887`). The browser calls this endpoint from `public/js/opds.js:673-701`.

There are two compatibility limitations:

1. OPDS 2 browsing is parsed, but search discovery is implemented by parsing the root as Atom XML. An OPDS 2-only catalog cannot advertise search to this code.
2. Multiple editions or acquisition links are collapsed to the first link whose relation contains `acquisition` or whose MIME type contains `epub`. Format choice is therefore not preserved.

The historical bridge design would have emitted OPDS 1.2 plus OpenSearch and returned one entry per edition/file. This remains research context only.

### Download and import

For a single result, `POST /api/opds/download/:id` fetches the acquisition URL with the configured upstream credentials, checks its response content type, detects PDF/CBR/CBZ versus EPUB, converts CBR to CBZ, hashes the file, rejects duplicates, extracts embedded metadata and a cover, and inserts the book into the current user's library (`server/routes/opds.js:1041-1155`). If embedded cover extraction fails, it can persist the catalog cover.

Bulk shelf sync performs the same basic work for every acquisition entry and records the source URL in `book_opds_sources`. A later browse/search uses that table to show local ownership. OPDS imports therefore already become normal Codexa `books` rows; no new Codexa import pipeline is required for EPUB, PDF, or CBZ.

## 3. Existing projects investigated

### Librarr

Librarr is a Go service with a web UI, SQLite-backed local library, multiple search-source drivers, download clients, Docker deployment, a REST API, Torznab, and OPDS 1.2. Its provider implementations are registered behind a `Searcher` factory, while endpoint/mirror configuration is loaded from a separate `librarr-sources` registry. Sources include OPDS, public APIs, Prowlarr/Torznab, and provider-specific integrations. See its [registry implementation](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/search/registry.go#L10-L35) and [source loader](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/sources/load.go).

Its Docker image is a multistage Node UI plus Go build with a non-root Alpine runtime on port 5050. The reference compose file persists its database and separate ebook/audiobook/manga directories: [Dockerfile](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/Dockerfile#L1-L35), [compose](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/docker-compose.yml).

### Calibre-Web-Automated Book Downloader and Shelfmark

The requested `yatesco/calibre-web-automated-book-downloader` repository is a small, old fork of the project now developed as [Shelfmark](https://github.com/calibrain/shelfmark). The older fork is a Flask/Docker search-and-download UI that writes supported formats to an ingest directory; it is not an OPDS server. Its documented workflow also includes Cloudflare bypass infrastructure, which is outside this plan.

Shelfmark is the current upstream and is a broad manual search/request/download application. It separates metadata providers (for example, Open Library, Google Books, and Hardcover) from acquisition sources and destinations. It has Docker deployment and application authentication, but its project scope explicitly stops at delivering files to an ingest directory rather than managing a library. The project describes itself as feature-stable and maintained on a best-effort basis. Its standard direct-download image includes browser challenge solving; neither that component nor an external bypasser is acceptable for this integration. Shelfmark is useful as an architecture reference, but deploying it does not give Codexa a verified OPDS endpoint.

### Anna's Archive Calibre plugin

[`ScottBot10/calibre_annas_archive`](https://github.com/ScottBot10/calibre_annas_archive/blob/main/annas_archive.py) is a Calibre desktop Store plugin, not a service. Its `search()` builds an Anna search-page URL, `_search()` parses fixed HTML table columns, and `get_details()` parses source-specific download panels. It returns useful metadata and formats within Calibre, but supplies no OPDS endpoint, Docker service, stable API boundary, or reusable server-side provider package. It is evidence of the maintenance cost of coupling to page structure.

### Anna's Archive KOReader plugins and forks

The inspected `fischer-hub/annas.koplugin`, `IT-Yohan/annas.koplugin`, and `ThePixelPro366/annas.koplugin` variants are KOReader Lua plugins. They scrape HTML, choose mirrors, and download to the reader. Their fallbacks and repair forks demonstrate page/mirror fragility. They do not expose an OPDS server or reusable provider service. Some code varies browser headers or uses WAF-oriented behavior; none of that should be copied.

### BookLore, Calibre-Web, and public-domain alternatives

BookLore documents an authenticated OPDS catalog and search over books already present in its libraries. That is library search, not verified live external-provider discovery. Calibre-Web likewise centers on serving an existing Calibre library; no source evidence found in this investigation established live external acquisition results through its OPDS feed.

[Gutendex](https://gutendex.com/) is a documented JSON API for Project Gutenberg metadata. It supplies title, authors, languages, copyright flag, pagination, MIME-keyed format URLs, and image links where available. It is not OPDS, but it is a suitable authorized/public-domain fixture for proving a bridge because a bridge can map its direct format URLs without implementing search logic. Standard Ebooks is also a sensible authorized source to assess later, but it was not source-verified as a complete searchable OPDS replacement in this research.

## 4. How the candidates actually work

| Candidate | Search surface | Catalog/download behavior | Architectural result |
|---|---|---|---|
| Librarr | Live search fans out through registered external `Searcher` implementations | Local library is served through OPDS; rich remote results are returned by REST; downloads are managed by Librarr | Best existing provider backend, but its present OPDS serialization is insufficient |
| yatesco CWA Downloader | Provider-specific web search in a Flask UI | Downloads files into a watched ingest directory | No OPDS; historical fork; bypass dependency excludes the documented default path |
| Shelfmark | Metadata-first or direct multi-source search | Sends completed downloads to a configured destination | No verified OPDS; larger UI/workflow than needed; challenge-solving paths excluded |
| Calibre Anna plugin | Scrapes Anna HTML within Calibre | Resolves source links through more HTML parsing | Desktop plugin, not a service or stable API |
| KOReader plugins/forks | Scrape Anna HTML within KOReader | Download directly to a device directory | Reader-specific and fragile; no service boundary |
| BookLore/Calibre-Web | Search an existing managed library | OPDS acquires already-ingested files | Useful downstream library servers, not live external discovery |
| Gutendex | Documented public JSON API | Direct Project Gutenberg format URLs | Good public-domain adapter/test source; needs a small OPDS translation layer |

## 5. Does Librarr OPDS support live provider search?

**Yes, but only as incomplete discovery results.** This is the important source-level distinction.

- `/opds/books` queries Librarr's downloaded local-library records and emits acquisition links to local files.
- `/opds/search?q=...` calls `searchMgr.Search(context, "main", query)`, so the query does fan out to configured external providers. It is not limited to downloaded books.
- The resulting OPDS entries contain a generated identifier, title, update time, and optional author. They omit cover, format, source identity, edition identity, and every acquisition link. Although the handler computes a MIME type, it does not add it to the entry.
- `/opds/download/{id}` looks up a local library record/file. It cannot download an arbitrary live-search result.

The implementation is visible in [local OPDS browse](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/api/opds.go#L81-L170), [live OPDS search](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/api/opds.go#L174-L223), and [local-only OPDS download](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/api/opds.go#L225-L260).

This means entering `http://librarr:5050/opds` in Codexa today allows local-library browsing. A search can return titles and authors, but Codexa cannot add them because its normalized entry has no `acqHref`.

Librarr's supported integration surface is its richer REST API. `GET /api/search?q=...&author=...` returns provider/source IDs, title, author, URL, cover, format, size, language, publisher, year, direct/magnet/hash/protocol fields, and local-ownership fields when available. Fields vary by provider. See the [handler](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/api/search.go#L11-L58) and [result model](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/models/book.go#L6-L63). Its streaming search API is optional and unnecessary for a first OPDS bridge.

One additional deployment concern was found: Librarr's authentication middleware exempts `/opds*`, and the handlers do not perform their own authentication, despite README guidance that clients can supply a username/password. Treat the current OPDS endpoints as unauthenticated and keep them on the Docker network or behind a reverse proxy. The JSON API accepts an `X-Api-Key` or query key and grants API-key callers admin privileges, so that key must remain server-side: [middleware](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/api/middleware.go#L28-L56), [API-key privileges](https://github.com/JeremiahM37/librarr/blob/2f98cb302d413893b797355a3c70360228a494d6/internal/api/middleware.go#L101-L119).

## 6. Gap analysis

Legend: **Yes** means verified in source/docs; **Local** means only already-ingested books; **Partial** means present with a material limitation; **No** means absent from the integration surface; **Unknown** means it was not established strongly enough to design against.

| Capability | Codexa | Librarr | CWA Downloader (yatesco) | Other candidate: Shelfmark | Missing for target? |
|---|---|---|---|---|---|
| OPDS catalog | Yes, client | Yes, server | No | No verified OPDS | Bridge must publish a compatible feed |
| OPDS search | Yes, OPDS 1/OpenSearch client | Partial: live titles/authors, no acquisition | No | No verified OPDS | Yes |
| Remote search | Via upstream OPDS only | Yes, provider drivers | Yes, provider-specific | Yes, multiple configured sources | No if Librarr is reused |
| Metadata | Parses title, author, summary; extracts imported files | Partial and provider-dependent | Partial | Yes through metadata providers | Normalize only reliable fields |
| Covers | Yes | REST results can include `cover_url`; OPDS search omits it | Yes/partial | Yes | Bridge mapping needed |
| Authors | Yes | Yes | Yes/partial | Yes | No |
| Language | Stored/extracted; not parsed from OPDS entries | REST result optional; OPDS search omits it | Filter/support documented | Yes | Bridge can preserve for future; Codexa UI will not display it yet |
| EPUB | Yes | Yes/provider-dependent | Yes | Yes/provider-dependent | No for public-domain proof |
| PDF | Yes | Yes/provider-dependent | Historical workflow limitation | Yes/provider-dependent | No if selected result is supported |
| MOBI/AZW3 | No import/reader support | Results may expose them | Yes | Yes/provider-dependent | Yes; filter them out initially |
| Download/import | Yes for direct OPDS acquisition | Local OPDS download plus REST-managed remote downloads | Ingest-directory delivery | Ingest-directory delivery | Direct authorized acquisition mapping or an async handoff contract is needed |
| Authentication | Codexa JWT; upstream Basic/Digest | API key/session; OPDS exemption is a security issue | No stable integration auth verified | Built-in/OIDC/proxy/Calibre-Web auth | Bridge-to-Librarr secret handling needed |
| Docker deployment | Yes | Yes | Yes | Yes | Compose wiring only |
| Active maintenance | Active current repository | v1.4.0 commit inspected on 2026-09-15 | Old 22-commit fork | Feature-stable, best-effort | Prefer Librarr; pin a tested image digest/version |
| Provider abstraction | No generic interface | Yes, Go searcher factory plus source registry | Provider-specific | Separates metadata, sources, and delivery | Reuse Librarr; do not recreate provider drivers |

## 7. Historical architecture considered before the accepted MVP

The following Librarr bridge is retained only as historical research. It is not an active
recommendation or implementation plan. The accepted architecture is the in-process provider MVP
described at the top of this document.

```text
Codexa (existing OPDS 1.2 client)
        |
        | HTTP, Docker network
        v
Codexa OPDS Bridge
  - Atom/OpenSearch serialization only
  - short-lived opaque result cache
  - format and acquisition safety policy
        |
        | GET /api/search, X-Api-Key
        v
Librarr
  - provider registry and search drivers
  - provider-specific download resolution
        |
        +-- authorized/public APIs and OPDS catalogs
        +-- user-configured sources
```

The bridge should have no Anna-specific module. Its upstream is `LibrarrSearchProvider`, and its job is limited to:

1. Translate Codexa-compatible OpenSearch requests to Librarr `GET /api/search`.
2. Normalize each Librarr result into one edition/file entry rather than merging formats.
3. Emit only EPUB, PDF, and CBZ/CBR acquisitions in the first release; CBR may be labeled for Codexa's existing conversion path. MOBI/AZW3 remain visible only if Codexa gains reader/import support later.
4. Use a bounded, short-lived server-side result cache and opaque result IDs. Never place the Librarr API key, provider credentials, raw serialized result objects, or privileged upstream URLs in the feed.
5. Emit an acquisition link only when the result supplies a direct, authorized HTTP(S) file URL that the bridge can validate and stream. Otherwise emit discovery metadata with no acquisition link. Do not turn challenge pages, external landing pages, magnets, or pending jobs into OPDS acquisition links.
6. Proxy eligible files with timeouts, redirect limits, a maximum size, content-type and magic-byte checks, and no arbitrary caller-supplied URL. The cache entry, not a query parameter, determines the upstream URL.

This narrow rule gives a complete public-domain end-to-end path through a Gutenberg-compatible result while the asynchronous Librarr download-job contract is tested separately. If Librarr's download API can provide a stable result-to-completed-local-file mapping, a later bridge phase can queue a job, poll with a bounded timeout, and stream the completed Librarr OPDS file. That extension must be based on a pinned, tested API contract; it must not guess paths or read Librarr's volume/database directly.

An upstream Librarr contribution that adds full acquisition entries to its own OPDS search could eventually remove the bridge. It should be pursued after the compatibility proof, not assumed as an available interface.

## 8. Historical bridge deployment architecture

The bridge and Librarr should be internal Docker services. Only Codexa's port needs host exposure.

```yaml
services:
  codexa:
    # existing configuration
    depends_on:
      book-provider:
        condition: service_healthy

  book-provider:
    build: ./services/opds-bridge
    environment:
      LIBRARR_URL: http://librarr:5050
      LIBRARR_API_KEY_FILE: /run/secrets/librarr_api_key
      ALLOWED_FORMATS: epub,pdf,cbz,cbr
    secrets:
      - librarr_api_key
    expose:
      - "7070"

  librarr:
    image: ghcr.io/jeremiahm37/librarr:<tested-version-or-digest>
    # Persist Librarr's own data and book directories.
    expose:
      - "5050"

secrets:
  librarr_api_key:
    file: ./secrets/librarr_api_key
```

After deployment, the existing Codexa settings are sufficient:

```text
Server name: External Books
Catalog URL: http://book-provider:7070/opds
Username: (empty)
Password: (empty)
```

The sample above is a design target, not an instruction to commit a real secret. For local development, an ignored environment file may supply the key if Compose secrets are impractical. Production should use a secret mount. The bridge must not publish its host port by default. Add health checks for the bridge and Librarr, pin versions, and document upgrade verification because both result shape and provider behavior can change.

## 9. Historical bridge security and interface constraints

- Do not implement CAPTCHA, Cloudflare, WAF, browser-verification, rate-limit, or access-control bypasses. Do not deploy Shelfmark/CWA bypass components as part of this architecture.
- Use only provider interfaces and content sources the operator is authorized to automate. A search result is metadata, not proof of download authorization.
- [Anna's official FAQ](https://annas-archive.gl/faq#api) documents one stable member JSON endpoint, `/dyn/api/fast_download.json`, for resolving fast-download URLs. It does not document a general search API or OPDS endpoint; for custom search it points users to downloadable Elasticsearch/MariaDB datasets. Exact request/auth fields were not verified without a configured membership and must not be inferred from third-party environment variable names.
- Librarr's Anna search driver currently parses HTML. Reusing Librarr keeps that provider-specific code out of Codexa, but it does not make HTML scraping an official or stable interface. Leave that source disabled unless its use is authorized and works without challenge circumvention.
- Keep the Librarr API key only in the bridge. Librarr API-key requests have admin-level access.
- Do not expose current Librarr OPDS directly; the inspected middleware exempts it from authentication.
- The bridge acquisition endpoint must never accept a raw URL. Use unpredictable cached IDs bound to the corresponding search result, short TTLs, and one normalized allowed scheme.
- Apply DNS/IP checks on every redirect to prevent the acquisition proxy from reaching loopback, link-local, metadata, or unrelated private services. Allow the configured Librarr service explicitly.
- Cap response size and duration; validate content type and magic bytes before streaming. Do not return HTML/JSON error bodies as books.
- Never log API keys, membership credentials, source tokens, full signed URLs, or download response bodies.
- Before implementation, either encrypt OPDS passwords with the existing credential helper or explicitly document the current plaintext-at-rest limitation. The recommended internal bridge connection avoids adding another OPDS password.

## 10. Historical bridge implementation plan

### Phase 0: pin and prove upstream contracts

1. Pin the tested Librarr version/digest and record its `/api/search` response fixture for a public-domain title.
2. Verify the actual REST authentication header, error responses, pagination/limit behavior, and timeout behavior against a local container.
3. Verify which result fields identify an edition/file and which direct URLs are valid without challenge handling.
4. Exercise Librarr's download endpoints separately and document whether a remote result can be mapped deterministically to a completed local-library ID. Do not implement async OPDS acquisition until this is proven.
5. Verify that Librarr can search a configured authorized source such as Project Gutenberg and that disabling excluded providers/bypass behavior is persistent.

Allowed APIs for the first bridge are OPDS 1.2 Atom/OpenSearch on the client side and Librarr's documented/source-verified `GET /api/search` with `X-Api-Key` on the upstream side. Do not invent REST fields or couple to Librarr's SQLite schema.

### Phase 1: implement the thin bridge

1. Create a standalone service with `GET /health`, `GET /opds`, `GET /opds/opensearch.xml`, `GET /opds/search?q=`, `GET /opds/cover/:resultId`, and `GET /opds/acquire/:resultId`.
2. Add a `LibrarrClient.search(query)` adapter whose normalized result contains provider/source ID, edition/file identity, title, author, language, cover URL, format/MIME, size, and an acquisition classification.
3. Serialize [OPDS 1.2 Atom](https://specs.opds.io/opds-1.2) using the specification's navigation/acquisition relations. Emit one entry per format. Add `rel=search` on the root pointing to the OpenSearch descriptor.
4. Add an in-memory bounded TTL cache keyed by a random opaque ID. Cache only the minimum result/acquisition data needed; restart may invalidate links safely.
5. Classify acquisitions as `direct`, `external_page`, `authentication_required`, `manual_verification_required`, `queued`, or `unavailable`. Emit an OPDS acquisition link only for `direct` and supported formats.
6. Stream direct authorized downloads through the bridge with redirect/DNS checks, size/time limits, MIME/magic validation, and abort propagation.
7. Return covers through the same constrained cached-result model so Codexa can fetch them without learning privileged upstream headers.

Anti-pattern guards: no Anna class, HTML parser, mirror discovery, browser automation, raw URL proxy, provider credential in a feed, direct Librarr database/volume read, invented Librarr endpoint, or MOBI/AZW3 mislabeled as EPUB.

### Phase 2: deployment integration

1. Add bridge and pinned Librarr services, private networking, health checks, volumes, and secrets to the sample Compose deployment.
2. Add non-secret environment examples and operator documentation.
3. Configure Codexa with `http://book-provider:7070/opds`; make no OPDS UI changes unless compatibility testing identifies a real defect.
4. Keep all external providers disabled by default. Document how an operator enables only authorized sources in Librarr.

### Phase 3: optional queued acquisition

Proceed only if Phase 0 proves a stable REST sequence from search result to completed local file:

1. Submit the original normalized Librarr result through the documented download endpoint.
2. Store only bridge job state and opaque IDs; poll documented job status with a bounded deadline.
3. When Librarr exposes a completed local-library ID, fetch through its supported authenticated/local download surface and stream to Codexa.
4. Represent pending/failed/manual-action states honestly. OPDS must not return a fake ebook while work is pending.

If the contract cannot provide a deterministic completed file, stop at direct authorized acquisitions. Do not compensate with filesystem/database coupling. That result would trigger a new architecture review rather than silently expanding the bridge into a provider gateway.

### Final verification

Run unit tests for serialization, field normalization, result-ID expiry, format filtering, URL/redirect blocking, response-size limits, and magic-byte validation. Then run the end-to-end test matrix below against the pinned containers. Compare emitted XML to OPDS 1.2 requirements and run an XML parser/validator. Grep for forbidden browser/bypass dependencies and secrets before release.

## 11. Files the historical bridge would have changed

The user-approved in-process implementation uses these files:

```text
server/providers/index.js             # provider contract and opt-in registration
server/providers/annaArchive.js       # isolated provider parser and normalized assets
server/providers/httpSafety.js        # pinned outbound connections and response limits
server/routes/opds.js                 # existing Online Library search/import/Peek integration
public/js/opds.js                     # provider-aware actions in the existing UI
test/providers/*.test.js              # parser, file validation, cache, and network policy
test/routes/*.test.js                 # authenticated search/import/Peek integration
docker-compose.sample.yaml
.env.example
README.md
```

The adapter remains environment-managed and does not add provider-specific database columns or
new UI screens.

## 12. Historical bridge test matrix

The acceptance test uses an EPUB that is public domain in the deployment jurisdiction, selected from an authorized Project Gutenberg/Gutendex-compatible source.

| Test | Required evidence |
|---|---|
| Root OPDS feed | HTTP 200, Atom content type, valid feed metadata, OpenSearch link |
| Navigation | Codexa opens the configured server and can return/up-navigate without malformed URLs |
| OpenSearch | Codexa discovers the descriptor and a title/author query reaches Librarr through the bridge |
| Title | Correct title shown in Codexa |
| Author | Correct author shown in Codexa |
| Cover | Image loads through the bridge/Codexa cover proxy; bad content type is rejected |
| Format | EPUB/PDF/CBZ/CBR has the correct MIME and distinct entry; MOBI/AZW3 gets no acquisition link |
| Acquisition | Authorized direct URL streams only from cached result state; redirects and private-network targets are tested |
| Codexa consumption | Existing `GET /api/opds/browse/:id` and search path parse the bridge response without app changes |
| Import | Public-domain EPUB becomes a normal Codexa `books` row, opens in the reader, and records `book_opds_sources` |
| Duplicate | Repeating acquisition returns/handles Codexa's existing duplicate behavior without a second book |
| Authentication | Missing/wrong Librarr secret fails closed and never appears in response/logs |
| Limits | Slow, oversized, HTML, JSON, truncated, and wrong-magic downloads fail without leaving a book/temp artifact |
| Provider state | Disabled/excluded providers do not appear; manual-verification results have no acquisition link |
| Docker | Fresh `docker compose up` reaches healthy state using service names; only intended host ports are published |

The end-to-end result must demonstrate all ten requested behaviors: root load, navigation, search, title, author, cover, format, authorized acquisition, Codexa consumption, and import of a public-domain EPUB.

## Accepted implementation

**Current choice: the user-approved in-process provider MVP.**

This preserves Codexa's interface and avoids a second service. Provider-specific parsing is
isolated behind a small server-side contract, while search references, network policy, format
validation, import, and Peek remain controlled by Codexa. The provider is opt-in through the
documented environment variables and can be removed without migrating library data.

The text below records the earlier bridge recommendation and why it was initially attractive;
it is retained for decision history rather than as the active implementation plan.

Option A is not sufficient today. Librarr is close: its OPDS search really does query live external providers, but its entries cannot be acquired and its OPDS download route serves only books already in Librarr's local library. The other investigated services either expose only an existing library, require a separate UI/ingest workflow, or provide provider-specific scraper plugins rather than a usable OPDS service.

The historical analysis favored a narrow Librarr bridge because it would have kept provider
maintenance outside Codexa. That conclusion was superseded when the user chose the smaller
in-process MVP. It is preserved only to explain the earlier tradeoff.
