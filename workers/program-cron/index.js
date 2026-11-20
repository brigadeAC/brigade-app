// Brigade program-cron: every 15 minutes, asks the Pages app to send any
// program messages that are due. All the logic lives in the app
// (functions/api/[[path]].js -> runProgramTick); this Worker is only a clock.
//
// Secrets/vars:
//   CRON_SECRET  (secret) must equal the Pages project's CRON_SECRET
//   TICK_URL     (var, optional) defaults to the production endpoint

const DEFAULT_URL = 'https://brigade-app.pages.dev/api/cron/program-tick';

async function tick(env) {
  if (!env.CRON_SECRET) throw new Error('CRON_SECRET is not set on the program-cron worker.');
  const res = await fetch(env.TICK_URL || DEFAULT_URL, {
    method: 'POST',
    headers: { 'x-cron-secret': env.CRON_SECRET, 'content-type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`program-tick failed: ${res.status} ${text.slice(0, 300)}`);
  console.log(`program-tick ok: ${text.slice(0, 300)}`);
  return text;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
