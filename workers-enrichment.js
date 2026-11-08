// Cloudflare Worker Cron entrypoint. It runs research, draft generation, Gmail
// reply detection, and at most one scheduled Gmail send per 10-minute tick.
import { runEnrichmentBatch } from './functions/lib/enrichment.js';
import { runCopywritingBatch } from './functions/lib/copywriting.js';
import { runGmailSendBatch } from './functions/lib/gmail.js';

export default {
  async fetch() {
    return new Response('OrigamiOutreach automation scheduler. Cron only.', { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([
      ['enrichment', () => runEnrichmentBatch(env, 10)],
      ['copywriting', () => runCopywritingBatch(env, 10)],
      ['Gmail delivery', () => runGmailSendBatch(env)],
    ].map(async ([name, task]) => {
      try { return await task(); }
      catch (error) { console.error(`[cron] ${name} failed`, error?.message || error); return null; }
    })));
  },
};
