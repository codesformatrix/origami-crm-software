// Minimal cron worker: hits the deployed Pages /api/cron endpoint every 10 min.
// Deployed as a separate Cloudflare Worker with a Cron Trigger.
export default {
  async fetch(request) {
    const target = 'https://origami-crm-software.pages.dev/api/cron';
    try {
      const res = await fetch(target, { method: 'GET' });
      const body = await res.text();
      return new Response(
        JSON.stringify({
          status: res.status,
          ok: res.ok,
          body: body.slice(0, 500),
          at: new Date().toISOString(),
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ error: String(e), at: new Date().toISOString() }),
        { headers: { 'Content-Type': 'application/json' }, status: 500 },
      );
    }
  },
};
