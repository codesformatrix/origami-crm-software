# Origami CRM — implementation plan and status

**Current working copy:** `origami-crm/` assembled from the attached source files, preserving the Pages Functions directory layout. The original Cloudflare database has not been accessed or modified.

## Decisions made

- Keep the existing Cloudflare Pages + D1 architecture rather than rewrite the working CRM in Next.js/PostgreSQL. This avoids migration risk, preserves existing features, and is the lowest-cost path; no live deployment is available from this workspace.
- Keep AI drafts user-clicked and never auto-send. The current provider path is Groq → Gemini → OpenRouter, uses minimized CRM fields, rejects suppressed/inactive contacts, caps output, and has a 10-request-per-UTC-day meter.
- Default local development and tests to **no external provider keys**. Keys, when available, are configured only in private environment variables; no credentials are required for ordinary CRM use.
- Keep outreach human-approved. A 24/7 process may prepare reminders/drafts and maintain queues; it must not silently cold-send email or automate LinkedIn.
- Keep the prospect backup outside the static Pages output. Do not commit it or deploy it as a file.

## Work started in this iteration

### Implemented in this working copy

1. Reconstructed the source folder layout and fixed the D1 binding to the name the API actually uses (`DB`). Replaced the invalid JSON block in `wrangler.toml` with valid TOML.
2. Replaced the browser-stored bearer copy of `APP_KEY` with a 12-hour signed, `HttpOnly`, `SameSite=Strict` session cookie. The API fails closed if `APP_KEY` is missing. The production secret must be set with Wrangler's secret command, never in the TOML file.
3. Added security headers and a restrictive static Content Security Policy.
4. Changed unsubscribe tracking so GET only displays a confirmation; the suppression action is applied on POST. Tracking IDs now use cryptographic randomness; tracked redirect destinations must be HTTPS.
5. Initially added optional Cloudflare Workers AI drafting and daily D1 usage metering (`migrate5.sql`); Phase 0 now routes the existing user-clicked draft UI through the environment-keyed Groq/Gemini/OpenRouter fallback module instead. AI output still goes into editable fields only.
6. Replaced the vulnerable SheetJS `xlsx` npm package with ExcelJS, pinned/fixed transitive UUID, and added XLSX archive/size/row/column limits plus formula non-execution. Legacy `.xls` files must be converted to `.xlsx` or CSV.
7. Removed the supplied real prospect backup from the deployable site folder; kept a working private copy separately for local compatibility testing.
8. Added market-segmentation filters to People: stored location, job-title family, funding/hiring/news/reply/click/untouched/overdue signals, and prospect-local send-window status. Segment query parameters are bookmarkable/shareable; filtering does not auto-send.
9. Added local DOM, XLSX-import, security and segment integration tests. Updated the supported build environment to Node.js 22 to use the patched Wrangler toolchain.
10. Added **Outreach projects**: custom title/location matching rules, require-both or match-either behavior, automatic assignment on spreadsheet import, context notes, manual add/remove, persistent exclusions for removed automatic matches, project editing/deletion, and backup/restore support. Added `migrate6.sql` and City/Country import fields.
11. Completed Phase 0 foundation while keeping the existing Cloudflare Pages + D1 architecture: added `research_notes` and `replies` tables, sender profile/sending-window settings, manually managed Research and Inbox/Replies pages, and names for the requested dashboard sections. Added `migrate7.sql` for existing D1 databases.
12. Moved the existing user-clicked AI draft endpoint to a server-only Groq → Gemini → OpenRouter fallback chain with bounded exponential retries on HTTP 429; OpenRouter requires an explicitly selected `:free` model. Added key-name placeholders only—no actual keys—and blocked outbound message logging/sequence enrollment for unsubscribed, do-not-contact, and bounced contacts.

### Validation performed locally

- `npm ci` succeeded and the dependency audit reports zero known vulnerabilities at the pinned lockfile (`npm audit`); Wrangler now requires Node.js 22+.
- `wrangler.toml` parses as TOML and the D1 binding matches `env.DB`.
- Fresh local D1 schema initialized; supplied version-1 backup restored to local D1 (40 companies, 40 contacts). Current backups are version 5 and include projects, research notes, replies, enrichment jobs, provider counters, and membership.
- Syntax tests passed.
- Security smoke checks passed for anonymous API denial, session cookie flags, authenticated reads, logout, no static backup data, security headers, AI disabled by default in local mode, and protected backup endpoint.
- DOM smoke tests passed for login and the Jarvis, Companies, Prospects, Outreach projects, Research, Inbox, Pipeline, Sequence Builder, Tasks, Analytics, Templates and Settings routes.
- XLSX tests passed for parsing, duplicate headers, formulas not being evaluated, legacy/oversized file rejection and a zip-bomb-style archive rejection.
- Segment API integration test passed using disposable local fixture records: market, role family, stored signals, and local market-time filters all returned the expected prospects; fixtures were deleted.
- Outreach-project integration test passed: current-rule matches, spreadsheet auto-categorization, manual add/remove, exclusion behavior, editing and safe project deletion; fixtures were deleted.
- DOM tests passed for segment preselection/shareable URLs, Outreach projects, Research and Inbox routes, and fail-closed AI controls.
- Phase 0 API integration test passed for research-note creation, inbound reply capture, reply classification, sender settings, outbound suppression and blocked sequence enrollment.
- LLM unit test passed for Groq → Gemini → OpenRouter ordering, 429 exponential retry/fallback behavior, server-only keys and no-provider fail-closed behavior.
- Local unsubscribe behavior verified: GET does not change state; confirmation POST does.

**Not verified:** Live provider inference or external provider calls (no API keys were supplied); remote deployment or remote D1 migrations; production Cron execution; Gmail OAuth/sync or mail sending. The enrichment pipeline and scheduler were validated with mocks and a local dry-run only.

## Phase 1 — prospect enrichment — complete locally

- Added CSV/simple-header and manual prospect entry, per-email deduplication, and persistent queueing.
- Added hourly scheduled-worker entrypoint plus D1 max-10/hour guard, provider daily/monthly counters, editable provider caps, and non-retrying Apollo/Hunter quota handling with `needs_manual_email` tasks.
- Added public-only company research (Firecrawl homepage/about/blog, Tavily searches, Serper fallback), LLM synthesis and ICP settings, research-note storage, manual LinkedIn paste/URL input without direct LinkedIn fetching, and per-prospect progress/requeue UI.
- Added `migrate8.sql` and fresh-schema changes. No production D1 migration or deployment was run.
- Validation passed: syntax, mocked provider/usage tests (including Tavily→Serper, Apollo/Hunter no-retry behavior, manual LinkedIn URL/text policy, and the hourly ceiling), local API tests, DOM/security tests, and all Phase 0 suites. The separate Worker configuration passed Wrangler dry-run. No deployment or remote D1 access occurred. Stop here and wait for the next phase instruction.

## Next phases

### Earlier secure release packaging — complete in this workspace

- Reviewed the release package and confirmed the Pages output contains no backup, `.dev.vars`, `node_modules`, or `.wrangler` state.
- Dependency audit passes with zero known vulnerabilities at the current lockfile.
- Packaged the source as `Origami_CRM_secure_build.zip`. The private prospect backup is intentionally excluded; use the original backup privately in the authenticated restore screen after verifying the destination database.

### Deferred production cutover (owner action; do not start until instructed)

1. Confirm whether an existing live CRM is in use and which database ID/site URL is the intended target.
2. The owner downloads a fresh backup from the live CRM before any migration/deployment.
3. The owner configures `APP_KEY` as a Cloudflare Pages secret and only the desired AI provider keys as Cloudflare secrets. Never expose them in client code or commit them.
4. Back up and review the current D1 first; apply `migrate6.sql`, `migrate7.sql`, and `migrate8.sql` for project/research/reply/enrichment features, plus `migrate5.sql` only if the AI usage meter is absent. For a new/empty database, initialize `schema.sql` instead.
5. Deploy and verify login, data visibility, backups, opt-out, and the AI quota before any routine use.

Never request Cloudflare passwords, API tokens, OAuth client secrets, or mailbox credentials in chat. Use the owner's local Wrangler login and dashboard.

### Future work — reliable 24/7 assistance

- Add a separate scheduled Worker or an equivalent supported Cloudflare scheduled task to refresh due follow-ups, stale-record flags and task queues. It should be idempotent, logged, retry-safe and quiet on errors.
- Send only internal reminder notifications after the user selects a provider. Do not send prospects automatically in the initial release.
- Later, if the owner explicitly wants outbound email, add an approved provider integration, per-mailbox limits, bounce/reply processing, suppression checks, audit log, manual kill switch and staged rollout. LinkedIn auto-messaging/scraping remains out of scope.

## Connectors and setup needed

- **Google Drive:** already connected; sufficient for reading the source folder and working files.
- **GitHub:** no GitHub connector is available in this agent session. It is not needed for local implementation or a downloadable package. Add a repository manually later if version history/CI is desired; never commit `.dev.vars`, backup data or secrets.
- **Cloudflare:** no Cloudflare account connector is available here. No additional connector is required for local development. The owner will need to use Cloudflare Dashboard/Wrangler locally to set production secrets, verify the D1 database, apply reviewed migrations, and deploy.
- **Mailbox:** Gmail OAuth is only reserved in the environment example. No mailbox connector or credentials were needed for Phase 0; Gmail sync/send remain future work.

## Free-provider guardrails

Provider free quotas, models, and eligibility can change and should be rechecked in each provider's official dashboard before keys are configured. The AI endpoint has its own 10-draft-per-UTC-day cap. OpenRouter is deliberately limited to model IDs with the `:free` suffix to avoid unexpected paid usage. No actual provider or Gmail credentials were supplied or stored in this workspace.
