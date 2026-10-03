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

## Scheduling

Weekly is enough: unchanged years cost two availability calls. Windows: `schedule-oracle.ps1`. OCI VM: `0 3 * * 1 cd /opt/tereflow/oracle && PYTHONPATH=. python -m tereflow_oracle ingest`.

## Secrets

`.env`, `Wallet_tereflow/` and `test_oracle_connect.py` are gitignored. Variables are in `local/.env.example`. In production keep the wallet on the VM (or OCI Vault), never in GitHub or Cloudflare.

## Known gaps

- Active countries: `sync-countries` needs a Cloudflare token with D1 read on account 959613069119a4056537a3f89f8d91ac. The current token is rejected (403 / 7403), so pass `--country` or insert into `tf_country` until that is fixed.
- No API layer yet (ORDS or Worker proxy), so the Cloudflare UI still reads D1.
- Sandbox, Blue Ocean and opportunity scoring (`shared/opportunity.ts`, `worker/analytics`) still run on D1; the Oracle views and `tf_product_metrics` are the intended inputs.
- HS6 requests use one AG6 call per flow/year. A reporter above 250,000 rows per flow fails loudly; chunking is needed for those.
- No OCI VM exists yet (needs a human to create it).
