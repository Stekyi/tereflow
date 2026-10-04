# Oracle backend (Autonomous AI Database 26ai)

Oracle is the persistent source of truth for the Comtrade dataset. Cloudflare D1 keeps users, sessions and the network feature.

## Architecture

```
UN Comtrade --> oracle/tereflow_oracle (cron, Python) --> Oracle ADB 26ai --> API (next) --> Cloudflare UI
                 availability -> classify.resolve -> fetch -> stage -> atomic swap -> metrics
```

- **Ingestion and analytics** run in Python (`python-oracledb`, wallet) on any machine with the wallet: this PC today, an OCI Always Free VM later. Cloudflare Workers are the wrong place for heavy Comtrade work (subrequest limits).
- **Classification** is decided in one place, `classify.py`. It trusts only Comtrade's availability endpoints: tariff-line depth (>6 digits) when genuinely reported with records, otherwise HS6. A deeper dataset that returns zero rows demotes to HS6 and the level is recorded on every row. Nothing is inferred.
- **Missing is not zero.** `value_usd` is NULL when Comtrade gave no value; a reported 0 stays 0.
- **Resumable and idempotent.** `tf_ingest_state` holds one row per reporter/year/flow. SUCCESS with the same availability checksum and release and the same level is skipped. A year is staged then swapped in one transaction, so a failure never leaves a partial year and a rerun never duplicates. A response that hits the 250,000-record cap is FAILED, never stored.
- **Failure handling.** One failing country is logged to `tf_ingest_error` and the run continues; the run ends PARTIAL. A Comtrade 429 after retries stops the run (RATE_LIMIT); state is saved and the next run resumes. Retry limit 5 per unit unless `--force`.
- **Availability** is cached in `tf_comtrade_availability` for 7 days, never checked per user request.

## Tables and views

`tf_trade_facts` (raw, PK reporter/year/flow/cmd/partner), `tf_trade_stage`, `tf_ingest_state`, `tf_ingest_error`, `tf_ingest_run`, `tf_comtrade_availability`, `tf_country`, `tf_product_metrics`.
Views: `v_sandbox_product_totals` (GROUP BY year, flow, product over partner rows, excludes the WLD row), `v_market_share` (partner vs all partners, share NULL when the total is missing), `v_world_reconciliation` (partner sum vs Comtrade's World row; Ghana 2024 differs by at most 0.04%).

## Commands (run from `oracle/` with `PYTHONPATH=.`)

```
python -m tereflow_oracle migrate
python -m tereflow_oracle create-app-user      # least-privilege login, password goes to .env
python -m tereflow_oracle ingest --country GHA --years 2024 --dry-run
python -m tereflow_oracle ingest --country GHA          # default: last 4 years
python -m tereflow_oracle ingest                         # all active countries in tf_country
python -m tereflow_oracle status
python -m pytest tests -q                                # 20 tests, real Oracle + fake Comtrade
```

`ingest` exits 0 only on full success, 2 otherwise, so a scheduler can alert.

## API (read only)

oracle/tereflow_oracle/api.py (FastAPI, bearer token ORACLE_API_TOKEN, app login, connection pool).

- POST /api/trade/sandbox: same contract as the Worker route, plus unreported_rows per partner. Years with no rows are null, a NULL value is counted as unreported rather than shown as 0, and product totals sum every partner (WLD row excluded).
- GET /api/health.
- Run: cd oracle; PYTHONPATH=. python -m uvicorn tereflow_oracle.api:app --port 8099.
- The Worker route proxies to it when ORACLE_API_URL and ORACLE_API_TOKEN are set (.dev.vars locally, wrangler secret put in production). If Oracle is down it answers 502 and does not fall back to stale D1 data. Unset the two variables to return to D1.
- Cloudflare cannot reach a service on this PC, so production does not use this FastAPI service. It stays for local development; production reads through ORDS (below).

## Opportunities and Blue Ocean

`opportunity.py` is a port of `worker/analytics/metrics.ts` and `opportunities.ts`: same constants, formulas and wording. `scripts/gen-oracle-parity.mjs` regenerates `oracle/tests/fixtures/ts_parity.json` from the TypeScript, and `tests/test_parity.py` requires the Python to match it exactly (scores, breakdowns, explanations, evidence, limitations).

Deliberate differences, all marked `DIFF` in code: HS8 tariff-line levels count as product-level in the confidence rating (D1 called them chapter level); ties between equal partners break by ISO3 so reruns are stable; the config (weights, exclusions) is JSON per country.

`tf_opportunity` keeps `metrics_json` for every score, so a result traces to the facts. Blue Ocean is read from structured metrics (`opportunity.blue_oceans`); the D1 version parsed numbers out of the evidence text with regular expressions.

- `GET /api/opportunities/{iso3}?flow=M&include_excluded=false&limit=50`
- `GET /api/blue-oceans/{iso3}`: the Worker still applies the visibility and tier gate, then calls this.
- `python -m tereflow_oracle analytics --country GHA` rebuilds metrics and opportunities (about 70 s for Ghana).

## Country dashboard

`dashboard.py` ports the trade-derived parts of `worker/agent/analyse.ts`: overview, ranked products, ranked partners, yearly trend. `scripts/gen-oracle-dashboard-parity.mjs` generates a fixture from the TypeScript and `tests/test_dashboard_parity.py` requires the Python to match.

- Totals: a product's total is Comtrade's World row for it (partner WLD), falling back to the sum of its partner rows. A country's total is the sum over products, which includes the unclassified 999999 line. This replaces the separate TOTAL query the D1 pipeline used.
- Deliberate differences: the partner count excludes the reporter trading with itself (the D1 count included it, though its ranking excluded it); the product count counts product lines only (D1 also counted every chapter row).
- Payloads are precomputed into `tf_dashboard_cache` after each ingest (`analytics` and `ingest` both do it), so a request reads one row (~0.1 s) instead of aggregating 400,000 facts (~11 s).
- `GET /api/dashboard/{iso3}` and `GET /api/lines/{iso3}?flow=M`. The Worker groups the lines into product families with the same `buildFamilies` code the D1 path uses.
- In the Worker, an Oracle outage returns 502, and a country with no Oracle data shows empty trade sections instead of stale D1 figures.

## ORDS (production API)

Oracle REST Data Services is built into the Autonomous Database, so the API needs no VM and costs nothing. The module `tf_api` is defined in the ADMIN schema at `https://<host>/ords/admin/tf/` by `python -m tereflow_oracle define-ords` (rebuilds the module from `oracle/ords/handlers/*.plsql`; safe to re-run).

- `GET /tf/dashboard/{iso3}`, `/tf/blue-oceans/{iso3}`, `/tf/lines/{iso3}?flow=X|M`: serve the precomputed rows in `tf_dashboard_cache` (refreshed after every ingest or `analytics` run).
- `GET /tf/sandbox?primary=ghana&partners=DEU,CHN`: computed live in one SQL statement; same response and the same validation messages as the Python API (`tests/test_ords_live.py` compares them).
- Security: every route needs an OAuth2 bearer token (`tf_read` privilege). The Worker holds the client credentials (`ORACLE_ORDS_URL`, `ORACLE_CLIENT_ID`, `ORACLE_CLIENT_SECRET`), gets a token from `/ords/admin/oauth/token`, and caches it in KV until shortly before it expires. A 401 triggers one refresh.
- Worker code: `worker/lib/oracle.ts` is the only place that talks to Oracle; it prefers ORDS and falls back to the FastAPI pair when only `ORACLE_API_URL`/`ORACLE_API_TOKEN` are set.
- The sandbox body can be tens of megabytes; the Worker streams it through instead of buffering it.

Cloudflare D1 still holds users, sessions, the network feature, the country registry, services and market context. No trade facts are in D1.

## Scheduling

Weekly is enough: unchanged years cost two availability calls. Windows: `schedule-oracle.ps1`. OCI VM: `0 3 * * 1 cd /opt/tereflow/oracle && PYTHONPATH=. python -m tereflow_oracle ingest`.

## Secrets

`.env`, `Wallet_tereflow/` and `test_oracle_connect.py` are gitignored. Variables are in `local/.env.example`. In production keep the wallet on the VM (or OCI Vault), never in GitHub or Cloudflare.

## Known gaps

- Active countries: `sync-countries` needs a Cloudflare token with D1 read on account 959613069119a4056537a3f89f8d91ac. The current token is rejected (403 / 7403), so pass `--country` or insert into `tf_country` until that is fixed.
- Served from Oracle: the trade sandbox, Blue Ocean, and the trade-derived part of the country dashboard. Recommendations are rewritten in the Worker from the Oracle figures with the same `recommend()` code (the services card is kept from D1). Still D1: services figures, market context, the momentum signals, rankings and the explore pages.
- The D1 analytics stay in place for countries not yet on Oracle. Oracle scoring needs an entry in `data/country_config.json` (only GHA so far).
- Oracle has 2020 Ghana recorded as NO_DATA (Comtrade reports none), so five-year views start in 2021.
- HS6 requests use one AG6 call per flow/year. A reporter above 250,000 rows per flow fails loudly; chunking is needed for those.
- No OCI VM exists yet (needs a human to create it).
