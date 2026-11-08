# Competitive research & upgrade plan

What the leading tools do, what ours was missing, and what we're building. Researched
August–September 2026; sources cited inline.

---

## 1. What the leaders actually ship

### lemlist — multichannel sequences + personalisation
- Multi-channel sequences: email, LinkedIn (visits, invites, messages, voice), calls, SMS, WhatsApp in one workflow, with **conditions** that adapt the journey per prospect [1](https://www.turnk.co/en/outils/lemlist)
- **A/B testing up to 5 simultaneous variants per step**; waterfall enrichment; 650M+ contact database [2](https://prospectingmanual.com/cold-email/lemlist/)
- **lemwarm** (deliverability/warm-up, inbox rotation) included on all plans; deliverability hub; unified multichannel inbox [2](https://prospectingmanual.com/cold-email/lemlist/)
- Manual action steps (e.g. "comment on their LinkedIn post"), 37,000+ community templates, multi-threading to several contacts at one account [3](https://pipeline.zoominfo.com/sales/lemlist-features)
- **Known gaps:** no deal management or pipeline view; analytics are sequence-centric not contact-centric; no conversation intelligence [4](https://www.amplemarket.com/blog/what-does-lemlist-really-do)

### Apollo.io — data + engagement + scoring
- Multi-step, multi-channel sequences with **timing, throttling and deliverability controls** [5](https://www.g2.com/products/apollo-io/reviews)
- AI lead scoring and intent signals; **A/B testing**; workflow automation engine; task management; pipeline & engagement analytics [6](https://saleshive.com/vendors/apollo-io)
- Chrome extension, dialer, meeting scheduling, CRM sync [7](https://www.apollo.io/insights/apollo-vs-outreach)
- Repeated user complaint: **accidental bulk actions and a steep interface learning curve** [8](https://vantaige.io/ai-tool/apollo-io)

### Zoho CRM — structure and process
- Multiple pipelines with **Kanban-style views**, forecasting, **custom fields/layouts/views**, scoring rules, omnichannel timeline, Blueprint process automation, cadences [9](https://saleshive.com/vendors/zoho-crm)
- Five automation layers (workflow rules, Blueprint, Cadences, Kiosk, CommandCenter); strong reporting [10](https://pipeline.zoominfo.com/sales/zoho-crm-features)

### Deliverability reality (2026)
- Safe ceiling is **20–50 cold emails per mailbox per day**; new domains start at 5–10/day and ramp over 4–6 weeks. Spikes matter more than totals [11](https://www.emailawesome.com/blog/how-many-cold-emails-per-day), [12](https://growthengineer.ai/blog/cold-email-deliverability-2026)
- Under ~200 sends/day a single warmed inbox is fine [12](https://growthengineer.ai/blog/cold-email-deliverability-2026)
- B2B benchmark: reply rate 5–8% good, 8–15% top decile; subject lines 21–40 chars; bounce under 2% [13](https://www.coffee.ai/articles/cold-email-best-practices-2026)

### The tracking trap
- **Opens are broken.** Mail Privacy Protection pre-fetches pixels, so ~49% of tracked opens are Apple servers; dashboards show 35–55% when true human open rates are 15–25% [1](https://www.gblock.app/articles/apple-mail-privacy-protection-fake-email-opens-2026)
- Signal reliability ranking: **replies (reliable) > clicks (noisy but useful) > opens (unreliable)** [14](https://prospeo.io/s/real-time-email-tracking)

---

## 2. Gap analysis: ours vs theirs

| Capability | lemlist | Apollo | Zoho | Ours (before) | Decision |
|---|---|---|---|---|---|
| Multi-step sequences with conditions | ✅ | ✅ | Cadences | ❌ flat 4-day cadence | **Build — biggest gap** |
| Pipeline / Kanban | ❌ | Basic | ✅ | ❌ | **Build** (their gap is our edge) |
| Manual tasks | Steps | ✅ | ✅ | ❌ | **Build** |
| Unified activity timeline | ✅ | ✅ | ✅ | Per-contact only | **Build** (company-level) |
| A/B variants per step | ✅ 5 | ✅ | ❌ | ❌ | **Build** (2 variants) |
| Tagging / segmentation | ✅ | Lists | ✅ | ❌ | **Build** |
| Bulk actions + multi-select | ✅ | ✅ | ✅ | ❌ | **Build** |
| Saved views / filters | ✅ | 65+ filters | ✅ | Search only | **Build** |
| Snippets (saved text) | ✅ | ✅ | ✅ | ❌ | **Build** |
| Lead scoring | ICP/AI | ✅ AI | Zia | ❌ | **Build** (transparent formula) |
| Send-volume guardrails | lemwarm | Throttling | ❌ | ❌ | **Build** (daily cap + ramp) |
| Email verification | Waterfall | ✅ | ❌ | ❌ | **Build** (MX check) |
| Click / open tracking | ✅ | ✅ | ✅ | ❌ | **Build, but de-prioritise opens** |
| Unsubscribe / opt-out | ✅ | ✅ | ✅ | ❌ | **Build** (compliance) |
| Command palette ⌘K | ❌ | ❌ | ❌ | ❌ | **Build** (their shared gap) |
| Contact database (600M) | ✅ | ✅ | ❌ | ❌ | **Skip** — needs a paid data vendor |
| Auto-sending / dialer / LinkedIn bots | ✅ | ✅ | ❌ | ❌ | **Skip** — no server-side sending on Pages free; LinkedIn automation breaches their ToS |
| AI message writing | ✅ | ✅ | Zia | ❌ | **Skip for now** — needs an API key + cost; templates + merge cover 80% |

**Deliberately skipped, and why:** we can't send mail from Cloudflare Pages (no SMTP, no
cron on the free tier), so anything that depends on *automatic sending* would be theatre.
Our model stays "Jarvis prepares, you send" — which also keeps you off LinkedIn's
automation radar and out of spam filters.

---

## 3. What we're building

**A. Structure**
1. **Sequences** — named multi-step journeys (email → LinkedIn → call task → breakup), each step with its own wait, channel, template and condition. Enrol people; the engine advances them and stops the moment they reply. Variant A/B per step.
2. **Pipeline** — Kanban board: New → Contacted → Replied → Meeting → Proposal → Won / Lost. Drag to move. The thing lemlist doesn't have.
3. **Tasks** — manual to-dos with due dates, alongside automatic follow-ups.
4. **Activity timeline** per company, not just per person.

**B. Operational speed**
5. **Tags** + **saved filters/views** + **bulk actions** (multi-select → snooze / tag / enrol / status).
6. **Snippets** — reusable text fragments inserted while composing.
7. **CSV import with column mapping** and duplicate detection by domain/email.
8. **⌘K command palette** + keyboard shortcuts (j/k, e, s, /).

**C. Intelligence**
9. **Lead scoring** — transparent: fit (funding, headcount, niche) + engagement (replies, opens, touches) + timing. Shown as a score on every row, explained on hover.
10. **Deliverability guardrails** — daily send cap (default 30, matching the 20–50 safe band), ramp warning for new domains, bounce-rate warning.
11. **Email verification** — MX/DNS check before you send; flags "no mail server" addresses.
12. **Tracking** — tracked links and pixels you paste into Gmail, logged per contact. Opens shown but explicitly flagged unreliable; **Jarvis never ranks on opens**.

**D. UI/UX (lemlist-clean)**
13. Light theme, violet accent, 8–12px radii, soft shadows, generous whitespace
14. **Left sidebar** navigation with icons (replaces the top nav)
15. Card-based stat tiles, segmented controls, avatars, friendly empty states
16. Denser, scannable tables with row hover actions
17. Responsive down to phone

---

## 4. Design decisions worth stating

- **Replies are the source of truth.** Every ranking decision weights replies and clicks; opens are cosmetic. This is the opposite of most tools, and it's correct post-MPP.
- **No auto-sending.** You stay in control of every send, which is also why this costs nothing to run.
- **No fake AI.** Merge fields + templates + real stored context gets most of the value of an AI writer without the API bill or the hallucinations.
- **Transparent scoring.** You can see exactly why a lead scored what it did — unlike Apollo's black box.

---

## 5. Shipped (this build)

Everything marked **Build** in section 2 above is now in the app, verified end to end:

| Feature | Where | Verified by |
|---|---|---|
| Multi-step sequences, per-step channel/wait/condition | **Sequences** | enrol → send → engine advances `step_index`; a reply sets the enrolment to `stopped` |
| Sequence-aware drafting | **Jarvis** | step 2's message is drafted after step 1 is logged |
| Pipeline / Kanban, 8 stages, drag to move | **Pipeline** | drag/drop → `PUT` stage |
| Tasks | **Tasks** | add → complete → delete round-trip |
| Company-level activity timeline | **Company** page | merges messages, tracked clicks, opt-outs and tasks |
| Tags + saved views (URL-encoded filters) | **People** | tag chips filter; `#/people?status=&tag=&sort=` is shareable |
| Bulk actions | **People** | snooze / stage / tag / enrol / delete on multi-select |
| Snippets | **Backup & settings** | create → copy → delete |
| CSV import with column mapping | **Backup & settings** | 3-row import skipped 1 duplicate, resolved HQ → timezone |
| ⌘K palette + `/`, `n`, `g` | everywhere | automated palette test in `tools/dom_test.mjs` |
| Transparent lead scoring | **Jarvis / People / Pipeline** | fit 40 + engagement 40 + timing 20, reasons printed |
| Daily-send-cap + domain ramp guardrail | **Jarvis / settings** | `GET /api/guardrails` |
| Email verification (MX over DoH) | **Contact** page | `deliverable` / `no_mx` / `disposable` / `invalid` / `unknown` |
| Tracked links + one-click unsubscribe | **Jarvis** / public endpoints | click 302s to target and logs; opt-out sets `passed` and stops sequences |

**Not built, on purpose:** a contact database, automatic sending, LinkedIn automation and
AI message writing. Reasons in section 2 — the short version is that two of them need
paid vendors, one breaks a ToS, and one can't run on Cloudflare Pages' free tier.

**Regression harness:** `node tools/dom_test.mjs http://127.0.0.1:8788` (needs `wrangler
pages dev` running and `jsdom` installed) walks all 12 routes plus five interaction
checks and reports any console error.
