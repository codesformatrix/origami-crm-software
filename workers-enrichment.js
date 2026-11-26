// Cloudflare Worker Cron entrypoint. It runs research, draft generation,
// pre-send refresh (rewriting scheduled emails with the latest research),
// timezone detection, Gmail reply detection, and at most one scheduled
// Gmail send per 10-minute tick.
import { runEnrichmentBatch } from './functions/lib/enrichment.js';
import { runCopywritingBatch, refreshScheduledDrafts } from './functions/lib/copywriting.js';
import { runTimezoneBatch } from './functions/lib/timezone.js';
import { runGmailSendBatch } from './functions/lib/gmail.js';

export default {
  async fetch() {
    return new Response('OrigamiOutreach automation scheduler. Cron only.', { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(async () => {
      // Refresh scheduled emails with the latest research before the send
      // phase picks them up.
      try {
        const refreshed = await refreshScheduledDrafts(env);
        if (refreshed.refreshed) console.log(`[cron ${new Date().toISOString()}] pre-send refresh: ${refreshed.refreshed} email(s) rewritten`);
      } catch (error) {
        console.error('[cron] pre-send refresh failed', error?.message || error);
      }
      return Promise.all([
        ['enrichment', () => runEnrichmentBatch(env, 10)],
        ['copywriting', () => runCopywritingBatch(env, 10)],
        ['timezone', () => runTimezoneBatch(env, 10)],
        ['Gmail delivery', () => runGmailSendBatch(env)],
      ].map(async ([name, task]) => {
        try { return await task(); }
        catch (error) { console.error(`[cron] ${name} failed`, error?.message || error); return null; }
      }));
    });
  },
};
