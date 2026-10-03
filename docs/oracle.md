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
- Cloudflare cannot reach a service on this PC. Production needs the API on a public host, such as the OCI VM behind HTTPS or a Cloudflare Tunnel.

## Opportunities and Blue Ocean

`opportunity.py` is a port of `worker/analytics/metrics.ts` and `opportunities.ts`: same constants, formulas and wording. `scripts/gen-oracle-parity.mjs` regenerates `oracle/tests/fixtures/ts_parity.json` from the TypeScript, and `tests/test_parity.py` requires the Python to match it exactly (scores, breakdowns, explanations, evidence, limitations).

Deliberate differences, all marked `DIFF` in code: HS8 tariff-line levels count as product-level in the confidence rating (D1 called them chapter level); ties between equal partners break by ISO3 so reruns are stable; the config (weights, exclusions) is JSON per country.

`tf_opportunity` keeps `metrics_json` for every score, so a result traces to the facts. Blue Ocean is read from structured metrics (`opportunity.blue_oceans`); the D1 version parsed numbers out of the evidence text with regular expressions.

- `GET /api/opportunities/{iso3}?flow=M&include_excluded=false&limit=50`
- `GET /api/blue-oceans/{iso3}`: the Worker still applies the visibility and tier gate, then calls this.
- `python -m tereflow_oracle analytics --country GHA` rebuilds metrics and opportunities (about 70 s for Ghana).

## Scheduling

Weekly is enough: unchanged years cost two availability calls. Windows: `schedule-oracle.ps1`. OCI VM: `0 3 * * 1 cd /opt/tereflow/oracle && PYTHONPATH=. python -m tereflow_oracle ingest`.

## Secrets

`.env`, `Wallet_tereflow/` and `test_oracle_connect.py` are gitignored. Variables are in `local/.env.example`. In production keep the wallet on the VM (or OCI Vault), never in GitHub or Cloudflare.

## Known gaps

- Active countries: `sync-countries` needs a Cloudflare token with D1 read on account 959613069119a4056537a3f89f8d91ac. The current token is rejected (403 / 7403), so pass `--country` or insert into `tf_country` until that is fixed.
- Only the trade sandbox is served from Oracle so far (see API below). Everything else still reads D1.
- The D1 analytics stay in place for countries not yet on Oracle. Oracle scoring needs an entry in `data/country_config.json` (only GHA so far).
- Oracle has 2020 Ghana recorded as NO_DATA (Comtrade reports none), so five-year views start in 2021.
- HS6 requests use one AG6 call per flow/year. A reporter above 250,000 rows per flow fails loudly; chunking is needed for those.
- No OCI VM exists yet (needs a human to create it).
