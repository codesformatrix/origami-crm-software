# Deploy Origami CRM to Cloudflare (24/7)

This guide deploys the Origami CRM to Cloudflare Pages + D1 so it runs 24/7 with automatic
email sending, reply detection, and AI copywriting. Run all commands on a computer with internet.

## Before you start

- Node.js 22+ (`node --version`)
- The repo cloned: `git clone https://github.com/codesformatrix/origami-crm-software.git`
- Your `.dev.vars` file (from Google Drive) — it has your Groq / Gemini / OpenRouter keys
- A Cloudflare account (free tier works)

## Step 1 — Install dependencies

```bash
cd origami-crm-software
npm ci
```

## Step 2 — Put your secrets in place

Copy `.dev.vars` into the project folder (it is gitignored, so it never gets committed):

```bash
# On Linux/Mac:
cp /path/to/.dev.vars .dev.vars
# On Windows PowerShell:
Copy-Item C:\path\to\.dev.vars .dev.vars
```

(Your keys are already in the Drive copy of `.dev.vars`.)

## Step 3 — Log in to Cloudflare

```bash
npx wrangler login
```

Follow the browser prompt and authorize. You only do this once per machine.

## Step 4 — Create the D1 database

```bash
npx wrangler d1 create origami-crm
```

Wrangler prints something like:

```
Database created successfully!
Database ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Copy that ID and put it into `wrangler.jsonc` under `d1_databases[0].database_id`
(replace the existing placeholder ID).

## Step 5 — Create the Pages project

```bash
npx wrangler pages project create origami-crm
```

If it says the project already exists (from an older setup), skip this step.

## Step 6 — Initialize the remote database

```bash
npx wrangler d1 execute origami-crm --file=schema.sql --remote --yes
```

This creates all 34 tables in the cloud database. (Migrations are NOT needed for a fresh database. If you already deployed an older database, apply the incremental migration with `npx wrangler d1 execute origami-crm --file=migrate14.sql --remote --yes` — it adds the `timezone_jobs` table used by automatic pre-send refresh and AI timezone detection. If you uploaded spreadsheets with live-product, founders, or technical-lead columns, also apply `npx wrangler d1 execute origami-crm --file=migrate15.sql --remote --yes`.)

## Step 7 — Set the required secrets

```bash
# The app login password (use the same APP_KEY from your .dev.vars)
npx wrangler pages secret put APP_KEY --project-name=origami-crm

# AI provider keys (from your .dev.vars)
npx wrangler pages secret put GROQ_API_KEY --project-name=origami-crm
npx wrangler pages secret put GEMINI_API_KEY --project-name=origami-crm
npx wrangler pages secret put OPENROUTER_API_KEY --project-name=origami-crm
npx wrangler pages secret put OPENROUTER_MODEL --project-name=origami-crm

# Public app URL (replace with your pages.dev URL after deployment)
npx wrangler pages secret put PUBLIC_APP_URL --project-name=origami-crm

# Optional: web research for AI timezone detection (deep research fallback)
npx wrangler pages secret put FIRECRAWL_API_KEY --project-name=origami-crm
npx wrangler pages secret put TAVILY_API_KEY --project-name=origami-crm   # or SERPER_API_KEY
npx wrangler secret put FIRECRAWL_API_KEY --config wrangler.enrichment.toml
npx wrangler secret put TAVILY_API_KEY --config wrangler.enrichment.toml   # or SERPER_API_KEY
```

Each command prompts for the value — paste the value and press Enter.

## Step 8 — Deploy the app

```bash
npx wrangler pages deploy . --project-name=origami-crm
```

You will get a `*.pages.dev` URL. Open it, sign in with your APP_KEY password.

## Step 9 — Deploy the scheduled worker (automatic sending)

The cron worker runs every 10 minutes: it sends scheduled emails and detects replies.

```bash
npx wrangler deploy --config wrangler.enrichment.toml
```

Then give the worker the same secrets (use the same values as the Pages app):

```bash
npx wrangler secret put APP_KEY --config wrangler.enrichment.toml
npx wrangler secret put GROQ_API_KEY --config wrangler.enrichment.toml
npx wrangler secret put GEMINI_API_KEY --config wrangler.enrichment.toml
npx wrangler secret put OPENROUTER_API_KEY --config wrangler.enrichment.toml
npx wrangler secret put OPENROUTER_MODEL --config wrangler.enrichment.toml
```

Also set `PUBLIC_APP_URL` to your pages.dev URL in `wrangler.enrichment.toml`.

## Step 10 — Set up Gmail (required before sending)

1. Google Cloud Console → create a project → enable the **Gmail API**
2. OAuth client (Web application type) with redirect URI:
   `https://YOUR-PAGES-ORIGIN/api/gmail/oauth/callback`
3. Set these secrets on BOTH the Pages project and the cron worker:

```bash
npx wrangler pages secret put GOOGLE_OAUTH_CLIENT_ID --project-name=origami-crm
npx wrangler pages secret put GOOGLE_OAUTH_CLIENT_SECRET --project-name=origami-crm
npx wrangler pages secret put GMAIL_TOKEN_ENCRYPTION_KEY --project-name=origami-crm
```

(use the same three values with `--config wrangler.enrichment.toml` for the worker)

4. In the app: Settings → Connect Gmail → authorize your mailbox
5. Settings → sender identity + physical mailing address (required before first send)

## Step 11 — Load your data

In the app: Prospects → Import → upload your Excel/CSV. Then add prospects to a sequence,
review AI drafts, and Schedule.

## Verification after deploy

- The pages.dev URL opens and sign-in works
- Settings shows provider keys as configured (Settings → test buttons)
- Sequence Health shows your sequences after enrollment

## Troubleshooting

- `wrangler` commands fail with auth errors → run `npx wrangler login` again
- Login page shows "authentication is not configured" → APP_KEY secret missing
- Emails not sending → check Gmail connection, mailing address, and the cron worker deploy
