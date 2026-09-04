# Tereflow

Global trade data, analysed weekly, aimed at someone deciding what business to
go into and who to do it with.

Working name only — change `APP_NAME` in `wrangler.toml` and the `<title>` in
`index.html` and you have renamed it.

---

## What is built

**All three phases are complete and running.**

| Piece | State |
|---|---|
| Registry of countries, international organisations and regional bodies | 142 records, 600 verified links |
| Admin form with three link slots per data category | done |
| Activation tick per record, plus bulk tick | done |
| Weekly analysis agent | done |
| Cron trigger, Friday 21:00 GMT | done |
| Country dashboard: trend, products, partners, recommendations | done |
| Early-signal engine behind a premium gate | done |
| Free registration and sessions | done |
| Business cards with buying / selling / supplying intent | done |
| Discovery search by product, sector, intent and country | done |
| Direct messages with unread counts | done |
| Peer ratings, restricted to people you have dealt with | done |
| Follow a product, sector, HS chapter or market | done |
| Weekly feed fan-out with push-and-pull market reads | done |
| Playbook library, 11 pieces, every claim cited | done |
| Billing: entitlement, plans, Stripe checkout and signed webhook | done |
| Rate limiting on login, registration, messaging and checkout | done |
| Mobile-first React shell with five-tab bottom bar | done |

95 automated checks pass across the two end-to-end suites.

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

## The network

Registration is three fields — name, email, password. The business card is a
separate optional step, so nobody is blocked at the door.

A card carries what actually matters for finding a counterparty: **intent**
(buying, selling, supplying, distributing, partnering, agent, logistics,
finance), sectors, the products in the words a buyer would search for, and the
markets they want to reach. Discovery searches all of it through SQLite FTS5,
with a LIKE fallback so a search never hard-fails on odd punctuation.

Messaging is a straight thread per pair. Conversations are keyed on the sorted
user pair, so A messaging B and B messaging A can never produce two threads.
Unread counts drive the badge on the Messages tab and clear when the thread is
opened.

Ratings are one per rater per subject, and you can only rate someone you have
actually exchanged messages with. Re-rating updates the existing score rather
than stacking a second one. The average is recomputed on the card each time.

Passwords are PBKDF2-SHA256 at 100,000 iterations via WebCrypto, since Workers
have no native bcrypt. Sessions are opaque ids in D1 behind an HttpOnly,
SameSite=Lax cookie; the Secure flag is set only over https so local dev works.

Login failures return the same message whether or not the account exists, and
burn comparable time on a missing account, so the form cannot be used to
enumerate users.

### The premium gate

The tier is read from the signed-in session server-side. An earlier build
trusted an `x-ta-tier` request header, which meant anyone could unlock premium
with curl. There is a test for that specific regression.

Entitlement is tier **and** an unexpired period, not tier alone. Reading the
flag by itself would leave a cancelled subscriber premium forever.

---

## Premium

Three things sit behind the gate, and the free tier is deliberately not a blank
wall in any of them.

**Early signals.** Products growing fast enough to reshape a market inside four
years while still outside the top five. Free users see the headline and the
count; the forward read is paid.

**Playbooks.** Eleven pieces on how to actually start: export readiness, the
document set, Incoterms, getting paid, EU food safety, US FSMA, GLOBALG.A.P. and
buyer certifications, cocoa under the EU Deforestation Regulation, horticulture
into the EU, the AfCFTA rules of origin, and what your national export agency
does for you. Two are free. Premium playbooks show their opening section so a
reader can judge the rest before paying.

Every claim is attributed to a real institutional publication that was fetched
and verified: the International Trade Centre, the European Commission, EUR-Lex,
the US FDA, GLOBALG.A.P., Rainforest Alliance, Fairtrade, the ICCO, the AfCFTA
Secretariat, UNECA, and the national export bodies of Ghana, Nigeria, Kenya,
Côte d'Ivoire and South Africa. **Nothing is attributed to a named individual
and nothing is invented.**

**The watchlist feed.** Follow a product, sector, HS chapter or market. Each
Friday run fans the refreshed analysis into your feed, deduped by ISO week so a
manual re-run never spams anyone. Alongside the paid signals it carries a free
push-and-pull read: who sells this and who buys it. For cocoa that currently
comes out as *pushing it out: Germany, Côte d'Ivoire, Ghana; pulling it in:
United States, Germany, China* — which is exactly right, Germany being the
processor that both imports beans and exports product.

### Billing

Provider-agnostic. With `STRIPE_SECRET_KEY` set, checkout creates a real Stripe
Checkout Session and entitlement moves **only** when the signed webhook arrives,
never from the browser. Signature verification is HMAC-SHA256 over
`timestamp.payload` with a five-minute replay window.

Without a key, a stub provider grants premium directly so the whole path is
testable. That is a development affordance and the dev-only tier switch refuses
to run once a real provider is configured.

`billing_events` is append-only, so entitlement can be rebuilt from history
rather than trusting a mutable flag.

### Rate limiting

KV-backed, on login, registration, messaging and checkout.

The thresholds are deliberately not aggressive. Much of the intended audience
sits behind carrier-grade NAT or a shared office line, where hundreds of real
people present one IP. So the tight limit on login is keyed to the **account
being attacked**, not the source address, which is what actually stops
credential stuffing without locking out a neighbourhood. IP limits are a loose
backstop. There is a test asserting that one attacker cannot lock out a
bystander on the same connection.

---

## Running it

```bash
npm install
npx wrangler d1 migrations apply tereflow --local
npm run seed:build            # regenerates data/seed.sql from the research files
npx wrangler d1 execute tereflow --local --file=./data/seed.sql

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
npx wrangler d1 migrations apply tereflow --remote
npx wrangler d1 execute tereflow --remote --file=./data/seed.sql
npx wrangler d1 execute tereflow --remote --file=./data/playbooks.sql
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Optional secrets:

```bash
npx wrangler secret put COMTRADE_API_KEY      # lifts the weekly run to 90 countries
npx wrangler secret put STRIPE_SECRET_KEY     # switches billing from stub to real
npx wrangler secret put STRIPE_WEBHOOK_SECRET # required for entitlement to move
```

Point the Stripe webhook at `https://your-domain/api/premium/billing/webhook`
and subscribe it to `checkout.session.completed`, `invoice.payment_succeeded`,
`invoice.payment_failed` and `customer.subscription.deleted`.

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
migrations/     0001 registry + facts + analysis
                0002 network (users, cards, messages, ratings, feed, playbooks)
                0003 premium (playbook sourcing, billing events, feed dedupe)
worker/
  index.ts      Hono app, SPA fallback, scheduled() handler
  lib/
    db.ts       bindings, D1 helpers, chunked IN clauses
    auth.ts     admin shared-token gate
    session.ts  PBKDF2 hashing, sessions, cookies, entitlement
    ratelimit.ts KV fixed-window limiter
  routes/
    admin.ts    registry CRUD, activation, runs, link checks
    public.ts   dashboards, rankings, registry browser
    auth.ts     register, login, logout, me, dev tier switch
    network.ts  cards, discovery, conversations, messages, ratings
    premium.ts  subscriptions, feed, playbooks, billing, Stripe webhook
  agent/
    run.ts      orchestrator, budget and rotation
    analyse.ts  all the maths and the plain-English layer
    feed.ts     weekly fan-out, push-and-pull, ISO-week dedupe
    codes.ts    ISO3 <-> M49, HS chapter labels, sector grouping
    adapters/   comtrade.ts, worldbank.ts
    linkcheck.ts
src/
  pages/        Home, Explore, Country, Registry, Admin, AdminForm,
                Auth, Network, CardDetail, CardEditor, Messages, Thread, Me,
                Feed, Playbooks, PlaybookDetail, Upgrade
  components/   ui.tsx, Markdown.tsx
  lib/          api.ts, auth.tsx (session context)
  styles/       app.css
shared/types.ts shared between worker and UI
scripts/        build-seed.mjs, build-playbooks.mjs, gen-country-names.mjs,
                e2e-network.mjs, e2e-premium.mjs
```

---

## Tests

```bash
npx wrangler dev                 # terminal 1
node scripts/e2e-network.mjs     # 47 checks
node scripts/e2e-premium.mjs     # 48 checks
```

95 checks across registration, cards, discovery, messaging, ratings,
subscriptions, feed fan-out and dedupe, playbook gating, billing, entitlement
expiry, webhook signature handling, rate limiting, and every authorisation
boundary. Both exit non-zero on failure, so they drop straight into CI.

---

## Next

The product is feature-complete against the brief. What it still needs before
real users:

- Email verification and password reset
- Avatar and document upload for business cards
- Moderation and reporting on cards and messages
- A real Stripe account, then `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
- A Comtrade API key, which lifts the weekly run from 2 countries to all 90
- Terms, privacy policy and a data-retention position, since the app now holds
  personal data and payment records
