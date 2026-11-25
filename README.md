# Origami Outreach CRM

A Cloudflare Pages + D1 CRM for prospect research and reviewed outreach. Gmail delivery starts only after an authenticated user explicitly schedules an eligible sequence; LinkedIn is never automated.

## Security and data handling

- The API fails closed unless an `APP_KEY` secret is configured.
- Sign-in uses a 12-hour HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie. The secret is never returned to the browser or stored in `localStorage`.
- Do not put secrets in `wrangler.jsonc`, source control, chat, or the deployed static directory. Gmail refresh and access tokens are AES-GCM encrypted in D1 using `GMAIL_TOKEN_ENCRYPTION_KEY`; OAuth tokens are excluded from backups.
- The prospect backup is intentionally kept outside this deployable folder. Never put a real CRM backup, `.dev.vars`, `.env`, or D1 state inside the Pages output directory.
- Back up the live D1 database before migrations or deployments. Do not run remote migrations until you have verified the target account/database and saved a backup.

## Run locally

Requirements: Node.js 22+ (the pinned Wrangler toolchain requires it).

```bash
npm ci
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and replace the placeholder with a long, unique secret. Keep `.dev.vars` private; it is gitignored.

Initialize a **local** D1 database and start the development server:

```bash
npx wrangler d1 execute origami-crm --local --file=schema.sql --yes --persist-to .wrangler/state
npm run dev
```

Open <http://localhost:8788>. To import the supplied private backup, choose it from its private location using **Backup & settings → Restore from backup**. It is stored outside this project so it cannot be published accidentally.

Run the checks in a second terminal while the server is running:

```bash
npm run test:syntax
CRM_TEST_PASSWORD='the-local-secret-from-.dev.vars' npm run test:security
CRM_TEST_PASSWORD='the-local-secret-from-.dev.vars' npm run test:dom
CRM_TEST_PASSWORD='the-local-secret-from-.dev.vars' npm run test:segments
CRM_TEST_PASSWORD='the-local-secret-from-.dev.vars' npm run test:projects
CRM_TEST_PASSWORD='the-local-secret-from-.dev.vars' npm run test:phase0
npm run test:phase1
npm run test:copywriting
npm run test:gmail
CRM_TEST_PASSWORD='the-local-secret-from-.dev.vars' npm run test:copywriting-api
CRM_TEST_PASSWORD='the-local-secret-from-.dev.vars' npm run test:sequence-health
npm run test:migration11
npm run test:migration12
npm run test:reply-detection
npm run test:reply-api
npm run test:dashboard
npm run test:llm
```

These tests use only the local Wrangler database. Do not point test scripts at the production URL.

## Deploy safely to Cloudflare Pages + D1

Do not deploy to a live account until you confirm the D1 `database_id` in `wrangler.jsonc` is yours and take a fresh backup. The supplied ID is carried forward from the attached config; this project has not been connected to or verified against your Cloudflare account.

1. Authenticate with Wrangler locally: `npx wrangler login`.
2. If you do not already have the intended D1 database, create one: `npx wrangler d1 create origami-crm`. Put its `database_id` in `wrangler.jsonc`.
3. Add the app password as a **secret**, not a variable:

   ```bash
   npx wrangler pages secret put APP_KEY --project-name=origami-crm
   ```

   Use a unique random secret and keep it in a password manager. Do not paste it into chat or commit it.
4. If this is a brand-new database, initialize it with `schema.sql`. For an existing CRM, first take and verify a backup, then review and apply the migrations needed by that database. `migrate6.sql` adds outreach projects; `migrate7.sql` adds research notes, classified replies, and sender settings; `migrate8.sql` adds enrichment jobs, provider usage counters, email-discovery state, and ICP fields; `migrate9.sql` adds the AI copywriting queue, persistent drafts, and message-to-draft links; `migrate10.sql` adds encrypted Gmail connection storage, send queue/audit tables, per-prospect timezone and the default 25-send cap; `migrate11.sql` adds business-day sequence linkage, stop reasons, bounce events and recipient-domain suppression; `migrate12.sql` adds Gmail reply thread metadata, saved suggestions, handled state, and permanent email-level suppression; `migrate13.sql` adds one-way hashed suppression storage and compliance/deliverability settings; `migrate14.sql` adds timezone-detection jobs for automatic pre-send refresh and AI timezone detection, and `migrate15.sql` adds the live-product, founders, and technical-lead company fields used by the Excel import. Apply the migrations in order only when they are not already present, before deploying this build to an existing database. `migrate5.sql` is needed only if the AI usage meter is not already present. Never blindly run all migrations or ignore errors.
5. Deploy the application folder:

   ```bash
   npx wrangler pages deploy . --project-name=origami-crm
   ```
6. Confirm the login works, protected API requests fail when signed out, and backups can be downloaded. Upload the private CRM backup through the authenticated restore screen only after confirming the destination database.

The app requires a configured `APP_KEY`; the API stays locked if it is missing. The tracking links are the only intentionally public endpoints. A tracking click requires HTTPS. Unsubscribe URLs show a confirmation page on GET and change CRM state only after a POST.

## Optional AI drafting and provider keys

AI drafting runs only when a signed-in user explicitly clicks **Draft with AI**. The server-side fallback order is Groq, Gemini, then OpenRouter. HTTP 429 responses receive bounded exponential retries before the request falls through to the next configured provider. Provider secrets are read only from environment bindings; they are never stored in the CRM database or returned to the browser. OpenRouter is enabled only when `OPENROUTER_MODEL` ends in `:free`, to avoid accidentally selecting a paid model. Check each provider's current model availability, quotas, and account limits before use; free-tier limits can change.

The optional environment variable names are listed in `.dev.vars.example`. For local development, copy the example to the gitignored `.dev.vars` and replace only the values you actually have. `PUBLIC_APP_URL` is a non-secret origin used for valid unsubscribe links; local API actions use the current origin, while the Cron Worker needs its production Pages origin set before it can enqueue drafts. For a later Cloudflare release, add secrets through Wrangler or the dashboard (for example, `npx wrangler pages secret put GROQ_API_KEY --project-name=origami-crm`). Do not commit or share real keys. Apollo, Hunter, Firecrawl, Tavily, and optional Serper are used by the Phase 1 server-side enrichment pipeline; the LLM providers also power the existing user-clicked draft feature. Keys stay in environment secrets; configure conservative quota caps in Settings. Gmail OAuth credentials and the token-encryption key are separate server secrets. Existing databases need `migrate5.sql` if the 10-draft-per-UTC-day usage meter is absent.

## Phase 1 — prospect enrichment

CSV imports now accept the simple headers `name,email,company,title,linkedin_url` as well as the existing richer spreadsheet template. Prospects are deduplicated by email and queued; the Prospects page also supports manual entry. The company detail manual-contact form queues new people too. The hourly batch ceiling is 10 and is enforced using persisted D1 counters, including when a user manually runs a batch.

Enrichment runs Apollo person match then Hunter email finder when an email is missing. A missing/quota-blocked email is flagged `needs_manual_email` and creates a follow-up task; paid-quota calls are never retried. Firecrawl scrapes only a validated public company homepage, `/about`, and `/blog` (at most three pages); Tavily performs two basic searches and falls back to Serper when quota capacity is low. After the scrape and search, the pipeline extracts company details from the gathered evidence and fills any **empty** company field — what the product does, recent news, city, country, live product, founders, and technical lead — without ever overwriting data that came from the uploaded spreadsheet. Empty cells and cells that say "unknown" import as empty and are filled here; populated cells always win. Provider requests are server-side, counter-reserved, bounded, and never exposed to the browser. No LinkedIn profile or post URL is fetched. A user may manually paste a post URL or text on the prospect detail page; URL-only input can use public search snippets, otherwise the UI asks for pasted text.

Synthesis uses the Groq → Gemini → OpenRouter fallback and saves a three-sentence summary, pain points, talking points, ICP score, and reason in `research_notes`. ICP authority, company size (default 10–500), and services-fit settings are editable. Per-prospect queue status/progress, retries, usage counters, quota caps, and a manual batch action appear in the UI. Jobs that fail or lack provider configuration do not automatically retry; users can explicitly queue them again. Provider quotas are conservative defaults and must be adjusted to the account's actual free-plan limits.

A Cron Worker is defined in `workers-enrichment.js` / `wrangler.enrichment.toml` and runs every 10 minutes for Gmail reply detection and scheduled sends (enrichment and copywriting retain their own per-hour caps). It is not deployed by Pages deployment and has not been deployed here. Before using it, verify the D1 ID, apply reviewed migrations, and configure provider secrets on both the Pages project (for manual actions) and Cron Worker (for scheduled processing). Worker secrets can be set with `npx wrangler secret put APOLLO_API_KEY --config wrangler.enrichment.toml` (repeat only for providers you actually use: `HUNTER_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, optional `SERPER_API_KEY`, and `GROQ_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` plus the free model selection). Use `npx wrangler deploy --config wrangler.enrichment.toml` only after confirming the target account and database. Local tests do not deploy or touch remote D1.

## Phase 2 — AI copywriting

The **AI copywriting** page queues and reports generation jobs. A prospect needs at least one saved research note; saving research can enqueue four drafts, or you can queue them from the contact page. Generation is server-side and happens before anything appears in Jarvis. It uses sender details and ICP settings, the prospect/company record, and the newest saved research summary, pain points, and talking points. The offer is included as positioning context, not as a fact about the prospect.

Email 1 is constrained to under 120 words, short lowercase subject, a research-based opening, plain language, at most one question, one clear CTA, and the exact unsubscribe token link. Follow-ups are 20–60 words and refer to the prior note while using saved insights; Email 4 is exactly two sentences as the breakup email. A separate scoring call assesses length, research-based personalization, CTA, subject, and spam safety. Any draft below 70 or failing a hard copy rule gets one revision and rescore; drafts still below threshold require editing and another score before they can be scheduled.

The contact page has an editable form for each email. Saving runs a fresh score and persists the edit. Scheduling requires Gmail to be connected and places the four reviewed drafts into the automatic-send queue; eligible messages may be sent by the 10-minute worker during the configured local window. Reply, suppression, unsubscribe, and reconnect-pause controls take precedence. AI output is not described as literally human-written: it is plain-language AI-generated copy that requires human review. It is not guaranteed to meet legal or deliverability requirements.

### Automatic pre-send refresh with the latest research

Drafts are generated once per sequence, and every scheduled email is **automatically rewritten 6 to 12 hours before its send time** (or right before it is due) whenever newer research exists. After a send, new posts, news, or pages pasted into the prospect detail page become the newest research note; the pre-send refresh phase in the cron worker regenerates that email from the fresh context while keeping the shared Gmail thread subject, the scheduled send time, and the already-sent emails as reference. Regenerated drafts re-run the scoring pass and a single revision if below 70, and the worker sends the rewritten body at the scheduled time. Sent drafts stay locked; a reply, bounce, or unsubscribe still stops the sequence. No manual step is required — the refresh runs automatically on every 10-minute worker tick.

### AI timezone detection

When a prospect has no timezone, the system detects it automatically, in this order: (1) the uploaded data (company city/country/hq resolves through the built-in city and country map); (2) AI inference from the company name and any saved description or news; (3) deep web research — Firecrawl scrapes the company website (homepage, about, contact pages) and Tavily or Serper searches for the headquarters location, then the AI extracts the city and IANA timezone from the gathered evidence. Detection runs from the cron worker (queued automatically when prospects are imported without a timezone), from `POST /api/timezone/run`, or immediately with `POST /api/contacts/:id/timezone` `{ "run_now": true }`. The detected timezone is stored on the contact (and company when empty), a `timezone_detection` research note records the source and confidence, outreach sending windows are computed per prospect local time, and the email AI is given the prospect's location context so copy reads like someone familiar with their market. To use the web-research fallback, set `FIRECRAWL_API_KEY` and either `TAVILY_API_KEY` or `SERPER_API_KEY` as worker secrets. LinkedIn is never used for outreach; only pasted manual input is accepted there.

Copywriting has a separate configurable hourly job cap in Settings (default 10). LLM provider quotas are counted per model request using the existing settings ledger. Set `PUBLIC_APP_URL` to the Pages origin in `wrangler.enrichment.toml`; without a valid public origin the system will not generate drafts missing a working unsubscribe link. The worker and Pages app must use the same verified D1 database and the worker must have the same LLM provider secrets. No remote migration or deployment was run for this phase.

## Phase 3 — Gmail OAuth, reply detection and scheduled delivery

The Gmail connection is user-authorized through **Settings → Connect Gmail** using an OAuth web-server flow with offline access and PKCE. It requests `gmail.send`, `gmail.readonly`, and `gmail.metadata`; the refresh token is encrypted with AES-GCM before it is stored in D1; the encryption key and OAuth client secret must be configured as server secrets on both Pages and the Cron Worker. OAuth `state` is one-use and expires after ten minutes. A reconnect or refresh-token failure pauses queued emails and shows a dashboard banner; reconnecting does not silently resume them. A user must choose **Resume paused sends** after checking the connection and settings.

The worker is configured for a 10-minute cron. It sends no more than one scheduled message per run, and the database lock enforces at least three minutes between successful sends. **There is no random 2–5 minute jitter to make automation appear human.** The actual window is 9:00–11:00 prospect-local time Monday through Thursday, using an optional contact IANA timezone with company timezone fallback. Sequence Health shows active, paused and completed sequences and why sends stopped. Step 1 is day 0; steps 2–4 default to 3, 4 and 5 business days (Monday–Friday, no weekend days). Follow-up dates land at 9:00 local; if that falls on Friday or a weekend, sending rolls to the next Monday window. Settings supports a default cadence and per-sequence overrides. The automated daily limit is enforced at week 1 ≤5/day, week 2 ≤10/day, week 3 ≤15/day, and week 4 onward the lowest of `daily_send_cap` (default 25), the existing global cap, and 500 sends per UTC day. If no warmup date is set, the first send initializes week 1; only set an earlier date if the domain was already gradually warmed. A missing timezone, contact address, physical mailing address, Gmail permission, or unsubscribe URL blocks the send and records a visible status.

Every outbound MIME message contains the sender’s non-empty physical mailing address, that prospect’s unique unsubscribe link in the body, and one-click `List-Unsubscribe` headers. Visiting the link by GET immediately records the opt-out, marks the contact unsubscribed, stops the sequence, and adds a permanent one-way hashed suppression digest; POST one-click requests do the same. The first message stores Gmail message ID, thread ID, and RFC Message-ID; follow-ups keep one shared subject and provide `In-Reply-To` and `References` headers in the same Gmail thread. Gmail 429 / rate-limit responses receive up to three total attempts with exponential backoff and `Retry-After` respected; every attempt and state transition is stored in `email_send_attempts` and `emails`. A worker interruption is marked failed rather than blindly retried, avoiding accidental duplicate sends. The 10-minute worker reads Gmail history and fetches the stored sent thread through Gmail’s thread/message APIs, deduplicating by Gmail message ID. Each new prospect reply is classified in one Groq-first LLM fallback-chain operation; positive and neutral replies also receive an editable first-person suggested response in that same operation. Suggestions are stored in Inbox and are never sent automatically. Inbox shows the conversation, classification, editable suggestion and handled state. Any human reply stops further sends. An out-of-office reply pauses the sequence; if a clear return date is available, the next step is rescheduled for the next safe sending window after that date and resumes automatically. Replies containing `unsubscribe` or `opt out` are detected before any LLM call and immediately mark the contact unsubscribed with a permanent one-way hashed suppression; not-interested replies also create permanent suppression and mark the contact do-not-contact. New suppressions are stored as SHA-256 digests; legacy clear-text entries are migrated on lookup and are removed during erasure. Both manual prospect creation and CSV imports reject or skip permanently suppressed addresses. Gmail delivery-failure messages still mark prospects bounced and stop the sequence. Two or more bounces for the same recipient email domain add that domain to the suppression list. Bounces and domain suppressions are visible in Sequence Health.

## Compliance and deliverability hardening

Settings includes a first-run SPF/DKIM/DMARC DNS wizard with record guidance and public TXT pass/fail checks for a sending domain you control. For Gmail Workspace, SPF must include Google; publish only one SPF record and merge includes into the existing record. Generate the DKIM public key in Google Workspace Admin rather than copying a placeholder. DMARC starts with a monitoring policy (`p=none`) and a monitored reporting address. These checks do not guarantee inbox placement. Use a separate outreach domain and mailbox; never use the main company domain for cold outreach. Free Gmail accounts are warned when the configured daily cap exceeds 10/day.

A master sending pause blocks the send worker and pauses queued messages. A user can log explicit consent events where applicable; consent withdrawal permanently suppresses that address, and a later consent grant never overrides a recorded opt-out. Settings documents a B2B-only data purpose and a legitimate-interest note. The per-prospect **Delete all data** action removes contact-linked research, messages, drafts, replies, jobs, tracking tokens, tasks, project memberships, and logs; it leaves an anonymous erasure event. If the person had opted out, only a pseudonymous SHA-256 suppression digest remains so future imports can still be blocked. It is not plaintext but remains suppression data and must still be protected. Removing a person from an outreach project remains separate from deleting that person globally.

**Google Cloud setup is required before live sending:** enable the Gmail API, create an OAuth Web application client, add the exact redirect URI `https://YOUR_PAGES_ORIGIN/api/gmail/oauth/callback`, configure the consent screen/test users, and set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and a unique `GMAIL_TOKEN_ENCRYPTION_KEY` (32+ random characters) as secrets. Local OAuth needs its own localhost redirect URI. `gmail.readonly` is a restricted Gmail scope; Google may require OAuth verification and a security assessment before public production use. Apps left in OAuth Testing can have refresh tokens that expire after seven days. Review Google’s current requirements before connecting a real mailbox. Gmail account-specific send limits and anti-abuse policies still apply; the CRM’s 500/day is only a hard software ceiling, not a Gmail quota guarantee. No Google OAuth app has been configured and no live send or deployment has been performed here.

## Phase 0 foundation and pages

This workspace already has a secure Cloudflare Pages + D1 CRM with signed-in sessions, People/Prospects, Companies, sequences, templates, Analytics, Settings, Excel/CSV import and shareable filters. To preserve those features and stay with the lowest-cost existing deployment, this phase extends that architecture instead of replacing it with a second Next.js/PostgreSQL app. The data model maps as follows: prospects are the existing `contacts` + `companies`; sequences use `sequences`, `sequence_steps` and `enrollments`; emails use `messages`; research history is in `research_notes`; and classified incoming messages are in `replies`. Settings remain in the existing key/value table.

The app navigation includes **Prospects**, **Research**, **AI copywriting**, **Sequence Builder**, **Sequence Health**, **Inbox / Replies**, **Analytics**, and **Settings**, alongside existing Companies and Outreach projects. Research notes and replies can be stored and manually edited/classified. Sender settings include a physical mailing address, Gmail daily cap and sequence cadence. A non-empty mailing address is required at the final send interlock; an address omission pauses delivery even if a draft was already scheduled.

Research combines public company pages/search with manually pasted LinkedIn material under Phase 1 restrictions; it never fetches LinkedIn URLs. Inbox replies can be manually logged/classified or detected from Gmail history when authorized.

## Prospect segments and outreach projects

The **Prospects** view can filter by stored location/market, job-title family, CRM signals (funding, hiring, recent news, reply, tracked click, untouched, overdue), pipeline stage, tags, and the prospect’s local send-window status. The selected filters live in the URL, so segments can be bookmarked or shared. **Outreach projects** let you create separate prospect lists with your own names, context notes, and title/location matching rules. Choose whether both rules must match or either rule is sufficient. Existing prospects are matched when a project is created or its rules are saved; future spreadsheet imports are matched automatically. You retain control: add any contact manually, remove someone from only that project, edit the project/rules, and delete a project without deleting its CRM contacts. Removing an automatic match records your exclusion so a refresh will not silently re-add them; manually adding them restores membership. Use the spreadsheet column mapping to map job title and HQ/city/country fields. The “send window” segment is a timing cue, not itself a trigger to enroll or send; only reviewed drafts explicitly scheduled on a contact enter Gmail delivery. Signal filters use information already stored in the CRM; they do not independently verify current funding, hiring, or news.

## Dashboard, prospect workbench, and operations settings

The dashboard now combines contact counts by status, automated sends versus the configured daily cap, active/paused enrollment counts, daily Groq/Tavily/Hunter/Apollo counters, a 30-day Gmail-thread reply rate, and a daily digest for enrichment, drafting, sending, replies, and recorded errors. Provider names are derived from sanitized job errors. Gmail readonly metadata can correlate sent threads and replies, but Gmail does not expose recipient-open events; open rate is therefore explicitly unavailable rather than estimated or mislabeled.

Prospects supports status, ICP score-range, and timezone filters; sortable ICP scores; an inline saved ICP reason; an expandable research summary; a user-triggered single-prospect **Enrich now** action; and one-click enrollment in a selected active sequence. Enrichment remains subject to the hourly/provider quota guards and no paid-provider calls are automatically retried.

Settings includes sender identity and mailing address, daily send cap, sending-window preferences, cadence, ICP criteria, Gmail status, quota caps, and server-key configuration status with explicit test buttons. Keys are never entered in the page or returned from APIs. Provider tests are single-shot health/usage checks; Serper’s test executes one search and consumes one query. Automatic Gmail delivery continues to use the existing fixed prospect-local safety window (Monday–Thursday, 9–11 a.m.); the configurable window preference remains the manual planning window.

## Current product boundaries

- Includes companies, contacts, tasks, pipeline, sequences, tags, templates, research notes, inbox/replies, CSV/Excel import, backup/restore, follow-up timing, prospect segments, user-managed outreach projects, and deterministic lead scoring/coaching.
- AI drafting and copywriting use the configured server-side fallback chain. Gmail sends only after a user connects an account and explicitly schedules the reviewed sequence; reply detection pauses remaining emails. There is no hands-free LinkedIn activity or automatic enrollment of unscheduled prospects.
- Human review and explicit scheduling are required before Gmail delivery. Bounce/domain suppression, reply pauses, daily limits and attempt logs are implemented, but live OAuth, Google verification, consent policy and production deliverability still need independent review before deployment.

## Import template

`CRM-import-template.xlsx` is a blank spreadsheet with supported prospect/contact columns, including HQ location, city, country, and job title. The importer accepts CSV/TSV or `.xlsx` files up to 5 MB; legacy `.xls` files must be saved as `.xlsx` or CSV first. The XLSX parser applies archive expansion, row and column caps and does not execute spreadsheet formulas.

## Project layout

```text
index.html
static/app.js
static/style.css
static/vendor/exceljs.min.js
CRM-import-template.xlsx
functions/api/[[path]].js
functions/lib/engine.js
functions/lib/coach.js
functions/lib/tzdata.js
schema.sql
migrate*.sql
wrangler.jsonc
```
