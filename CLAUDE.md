# Crossword Builder — project notes

Jonathan Shambroom's web app for building crossword puzzles with automatic grid
layout, manual editing, and print/PDF export.

## Workflow: PRODUCTION-ONLY (decided 2026-10-22)

**Jonathan does all real work in production: https://crosswordbuilderjsham.com.**
He does NOT run the app locally for real use. Do not suggest running it locally,
and if he asks to, remind him of this decision and why local is a separate world:

- Local Clerk uses a **dev** instance (`pk_test`) → a **different user identity**
  than production (`pk_live`). His real puzzles are keyed to the prod identity, so
  they won't appear locally, and anything saved locally lands under the dev id
  (invisible in prod).
- Since RLS is on (see below), the Supabase **anon key is blocked**, so local
  cloud save/load fails outright (clean error, no silent loss, no data risk).
- `start.sh` prints a reminder + confirmation prompt before starting locally
  (bypass with `SKIP_LOCAL_WARNING=1`, which is how automated tests run it).

Claude may still run the app locally to **verify changes before deploying** —
that's part of the dev loop, not "using the app." Use `SKIP_LOCAL_WARNING=1
./start.sh` or `npm run dev` directly.

## Architecture

- **Frontend** (`frontend/`): Next.js 16 (App Router). Almost the entire UI is one
  big client component, `frontend/src/app/page.tsx`. Deployed on **Vercel**, custom
  domain `crosswordbuilderjsham.com`.
- **Backend** (`backend/`): FastAPI, **stateless** layout engine only
  (`/api/generate`, `/api/upload`, `/api/health`) — stores nothing. Deployed on
  **Railway** (`NEXT_PUBLIC_API_URL`).
- **Auth**: Clerk (production instance, `pk_live`, `clerk.crosswordbuilderjsham.com`).
  Auth runs through `frontend/src/proxy.ts` (Next 16's renamed middleware
  convention; Clerk's `clerkMiddleware()`). `auth()` in the API routes depends on
  this file — if auth breaks (silent empty puzzle lists), check `proxy.ts`.
- **Storage**: Supabase Postgres, table `puzzles`, one project
  (`ywerdxebjnxqqvtxohoz`). Per-user via Clerk `user_id`. All DB access goes
  through server-only Next.js routes under `frontend/src/app/api/puzzles/`.
  Signed-out users fall back to browser `localStorage`.

### Supabase security (hardened 2026-10-22)

- **RLS is ON** for `puzzles` (no policies). The server uses the **`service_role`**
  key (`SUPABASE_SERVICE_ROLE_KEY`, server-only env var) which bypasses RLS;
  `frontend/src/lib/supabase.ts` has `import "server-only"` so it can never be
  bundled into client code and leak a key. It still falls back to the anon key if
  `service_role` isn't set (harmless now that RLS blocks anon).
- Net effect: even if the public anon key leaks, it has **zero** table access.

## Deploying

`git push origin main` → Vercel auto-deploys the frontend AND Railway auto-deploys
the backend. **Railway auto-deploy is unreliable** — a backend change may not ship
for a while; force it via Railway → Deployments → Redeploy. (Most work is
frontend-only and doesn't touch the backend.)

- Bump the `<meta name="app-build">` marker in `frontend/src/app/layout.tsx` on
  client-facing changes to bust asset caches.
- If a pushed fix looks stale in the browser, **redeploy in Vercel first** (or check
  in an incognito window) — don't chase browser cache.

## Verifying UI/PDF changes

`curl` only sees SSR of the landing page. To verify real UI, drive headless Chrome:
`puppeteer-core` + `executablePath` = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
against `npm run dev` on :3030. Render PDFs to PNG (`sips -s format png x.pdf --out y.png`)
to eyeball layout. Inject a `crossword-full-v1` JSON via the file input, or a
`localStorage["crossword_draft"]` draft + Restore, to reach states without auth.

## Deeper history

Extensive per-feature history and gotchas live in Claude's auto-memory
(`features-and-duplicates`, `architecture-auth-storage`, `redeploy-over-cache-fix`).
This file is the practical working summary.

## Recent changes (most recent first)

- **Production-only workflow** + `start.sh` reminder guard (2026-10-22).
- **`middleware.ts` → `proxy.ts`** rename for Next 16 (commit `cd2589e`).
- **Supabase hardening**: service_role key + `server-only` guard + RLS enabled
  (commit `c63702b` + dashboard steps).
- **Grid-only PDF pages maximized**: tight equal 0.25in margins, grid bottom-aligned
  + centered, hidden-message note moved right-aligned above the grid (`2a0eeb4`).
- **Lavender alert** on clue boxes whose text duplicates another entry (`3ae1db6`).
- **Repeated-answer clues** now resolve live from the clue panel in the under-grid
  list (pair k-th placement ↔ k-th clue row), not a stale snapshot (`a764a01`).
- **Save confirmation timestamp** added under the above-grid Save button (`ce79e28`).
- **Grid centered/maximized on its own page** + **toggleable manual subhead date**
  (auto "today" vs a fixed typed date) with a print-accurate preview (`3467354`).
- **Cloud auto-save**: signed-in edits debounce-save to the account (`08bec99`).
</content>
