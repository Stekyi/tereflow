# TradeAtlas

Global trade data, analysed weekly, aimed at someone deciding what business to
go into and who to do it with.

Working name only — change `APP_NAME` in `wrangler.toml` and the `<title>` in
`index.html` and you have renamed it.

---

## What is built

**Phase 1 is complete and running.**

| Piece | State |
|---|---|
| Registry of countries, international organisations and regional bodies | 142 records, 600 verified links |
| Admin form with three link slots per data category | done |
| Activation tick per record, plus bulk tick | done |
| Weekly analysis agent | done |
| Cron trigger, Friday 21:00 GMT | done |
| Country dashboard: trend, products, partners, recommendations | done |
| Early-signal engine behind a premium gate | done |
| Mobile-first React shell with bottom tab bar | done |

Phase 2 (accounts, business cards, DMs, ratings) and Phase 3 (billing,
playbooks, personal feed) have their database schema in `migrations/0002` but no
UI yet.

---

## The registry

One table holds all three kinds of publisher, because they all publish the same
thing:

- **90 countries** — the top 15 economies of each continent, plus Ghana and
  the rest of Africa's and Oceania's reporting economies.
- **26 international organisations** — UN Comtrade, UNCTAD, WTO, World Bank
  WITS, IMF DOTS, OECD, ITC Trade Map, FAOSTAT, OEC, Harvard Growth Lab, and so on.
- **26 regional bodies** — ECOWAS (ECOTIS), AfCFTA, Eurostat, ASEAN, SADC, EAC,
  COMESA, Mercosur, CARICOM, GCC-Stat, UNECLAC, APEC and others.

Each record carries up to **three links per category** across **export**,
**import** and **commerce flow** (services, wholesale and retail, GDP by
activity). Overflow links go in slots 2 and 3, exactly as specified.

Every URL was HTTP-checked when the seed was built, and the weekly cron
re-checks them so dead links show up in the admin table rather than rotting
quietly.

---

## How the analysis actually works

An honest note, because it shapes everything:

National statistical offices publish in roughly ninety different shapes. Ghana
posts quarterly PDFs, Brazil has a clean REST API, several African portals have
expired TLS certificates. You cannot reliably parse all of them, and pretending
otherwise produces a dashboard that is confidently wrong.

So the pipeline splits the job:

1. **Comparable numbers** come from harmonised sources — **UN Comtrade** for
   merchandise trade on a single HS classification and USD basis, and the
   **World Bank** for services, goods-and-services totals and GDP. That is what
   the charts are built from, which is what makes countries comparable at all.
2. **Official national publications** are stored, displayed and health-checked
   as citations under every dashboard, so a user can always go and read the
   source of record.

Two traps in the Comtrade API that are handled explicitly in
`worker/agent/adapters/comtrade.ts`:

- The keyless preview endpoint accepts **exactly one period per call**.
- Every value is repeated across customs procedures and modes of transport.
  Without pinning `customsCode=C00` and `motCode=0` you triple-count everything.

### What gets computed

`worker/agent/analyse.ts` produces, per country:

- Export, import, balance and total, with year-on-year change.
- A yearly trend built only from years where **both** flows reported, so the
  balance is never a real number minus a missing one.
- Top products by HS chapter, with 3-year CAGR, translated into plain English
  ("Cocoa & cocoa preparations", not "HS 18").
- Top export destinations and import origins with share and growth.
- **Export concentration (HHI)** — the single most useful risk number. Ghana
  sits at 0.43, which is why the dashboard warns about gold dependency.
- **Early signals** — products growing above 8% a year, above 0.2% of trade,
  outside the current top five, scored on a momentum blend of growth rate,
  share gained and consistency. This is the premium tier.
- **Recommendations** in plain language, each carrying its own evidence lines.

### Verified output

Ghana, 2025, straight from the pipeline:

```
exports $31.98bn | imports $20.17bn | balance $11.81bn
HHI 0.427 (concentrated) | 188 partners | 96 product groups

Top exports    1 Pearls, gems & precious metals   $20.18bn  63.1%  +46%/yr
               2 Cocoa & cocoa preparations        $4.47bn  14.0%  +27%/yr
               3 Mineral fuels & oils              $2.81bn   8.8%  -19%/yr
Destinations   UAE 26.4% · India 16.3% · Switzerland 14.4% · South Africa 10.5%
Early signal   Metal ores & ash — +108%/yr, rank 7, projected 1
```

---

## Running it

```bash
npm install
npx wrangler d1 migrations apply tradeatlas --local
npm run seed:build            # regenerates data/seed.sql from the research files
npx wrangler d1 execute tradeatlas --local --file=./data/seed.sql

npx wrangler dev              # worker + API + SPA on :8787
```

Create `.dev.vars` with:

```
ADMIN_TOKEN=local-dev-token
```

Open `http://127.0.0.1:8787`, go to **Admin**, paste the token.

### Deploying

```bash
npm run db:create             # paste the returned database_id into wrangler.toml
npx wrangler kv namespace create CACHE   # paste the id into wrangler.toml
npx wrangler d1 migrations apply tradeatlas --remote
npx wrangler d1 execute tradeatlas --remote --file=./data/seed.sql
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

### Rate limits, and why you want a Comtrade key

Without `COMTRADE_API_KEY` the preview endpoint allows one year per call, so a
country costs about 23 subrequests. Cloudflare's free plan caps an invocation at
50 subrequests, so the weekly run processes **2 countries per invocation**,
oldest first, and rotates.

Get a free key at <https://comtradedeveloper.un.org/> and set it:

```bash
npx wrangler secret put COMTRADE_API_KEY
```

That collapses a country to ~9 calls and raises the per-run budget to 90
countries, which covers the whole registry in one Friday run.

---

## The weekly job

`wrangler.toml` sets:

```toml
[triggers]
crons = ["0 21 * * 5"]
```

Friday 21:00 UTC, which is 21:00 GMT. On each fire the worker:

1. Picks activated countries, oldest ingest first.
2. Pulls Comtrade and World Bank, replaces that country's facts (replace, never
   append, so a re-run cannot double count).
3. Recomputes every analysis payload and the opportunity signals.
4. Health-checks a batch of registered official links.

Miniflare does not fire cron locally. Test with:

```bash
npx wrangler dev --test-scheduled
curl "http://127.0.0.1:8787/__scheduled?cron=0+21+*+*+5"
```

Or just hit **Run analysis** in the admin console.

---

## Layout

```
migrations/     0001 registry + facts + analysis, 0002 network + premium
worker/
  index.ts      Hono app, SPA fallback, scheduled() handler
  routes/       admin.ts (CRUD, activation, runs), public.ts (dashboards)
  agent/
    run.ts      orchestrator, budget and rotation
    analyse.ts  all the maths and the plain-English layer
    codes.ts    ISO3 <-> M49, HS chapter labels, sector grouping
    adapters/   comtrade.ts, worldbank.ts
    linkcheck.ts
src/
  pages/        Home, Explore, Country, Registry, Admin, AdminForm
  components/   ui.tsx
  styles/       app.css
shared/types.ts shared between worker and UI
scripts/        build-seed.mjs, gen-country-names.mjs, extract-research.mjs
```

---

## Next

**Phase 2 — the network.** Free registration, the business-card profile (intent:
buying, selling, supplying, distributing, partnering), search by product or
market, direct messages, peer ratings after a dealing. Schema is already in
`0002_network.sql`.

**Phase 3 — premium.** Billing, the expert playbook library, and fanning
subscribed products into a personal weekly feed.
