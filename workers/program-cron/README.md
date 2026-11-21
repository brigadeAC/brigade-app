# program-cron

A tiny Cloudflare Worker that runs every 15 minutes and POSTs to
`https://brigade-app.pages.dev/api/cron/program-tick`, which sends any program
messages that are due. The app itself also ticks lazily whenever a client opens
it, so this Worker just makes sure messages go out on time even when nobody is
in the app.

## One-time setup

Pick a long random secret (for example `openssl rand -hex 32`) and use the
**same value** in both places.

From this folder (`workers/program-cron`). Pass `--config wrangler.toml` every time; without it
wrangler picks up the Pages app's `wrangler.jsonc` one folder up and refuses:

```sh
npx wrangler deploy --config wrangler.toml
npx wrangler secret put CRON_SECRET --config wrangler.toml
```

Then give the Pages app the same secret (from anywhere in the repo):

```sh
npx wrangler pages secret put CRON_SECRET --project-name brigade-app
```

The Pages secret takes effect on the next Pages deploy
(`npm run build && npx wrangler pages deploy`).

## Checking it

```sh
npx wrangler tail brigade-program-cron --config wrangler.toml
```

Each run logs `program-tick ok: {"success":true,"enrollments":N,"sent":N,...}`.
A `401` means the two secrets don't match (or the Pages one isn't deployed yet).
