# Operator guide: bank data and indicator mapping

For people who run Tereflow's data jobs. Nothing here needs a developer.

## Bank data (Finance module, Phase 1 skeleton)

1. Make a blank template: `python scripts/finance/bank_template.py make`
   This writes `templates/bank_template.xlsx` with three sheets: **Data** (fill this in), **Metrics** (the allowed
   metric codes, units and rate types) and **Example** (two filled rows).
2. Fill the Data sheet, one row per institution, country, period and metric. Columns, in order:
   `institution_code, country_iso3, period, metric_code, value, unit, currency, source_note, rate_type`.
   - `period`: 2025, 2025-06 or 2025-Q2.
   - `unit`: must be one of the units listed for that metric on the Metrics sheet.
   - `currency`: required when the unit is `currency`.
   - `rate_type`: required for rate metrics (lending, deposit, trade finance fee), empty for the others.
   - `source_note`: always required. Say where the figure came from.
3. Check the file: `python scripts/finance/bank_template.py check my_file.xlsx --report problems.csv`
   It prints each problem with its row number and exits 0 only when every row is valid. It never touches the database.
4. Loading valid files into the database comes with the Finance module (Phase 4).

Allowed metrics, units and rate types live in `templates/finance_config.json`. To add one, edit that file.

## World Bank indicators

`python -m tereflow_oracle worldbank [--country ISO3 ...] [--from-year 2005] [--dry-run] [--map FILE]`
The list of indicators loaded is `oracle/tereflow_oracle/data/worldbank_map.json` (Tereflow code to World Bank code).
Edit that file to add or drop an indicator. Only codes that exist in the indicator definitions table are written.

## Trade collection on any PC

Admin, Pipeline tab, "Download collector (.zip)". See the README inside the zip.

**Getting collected data into the app.** The collector never touches the database. After it has run, go to Admin, Pipeline tab,
"Send collected data to the app" and upload the CSV files from the collector's `data` folder (names like ETH_2024_X.csv; select several at once).
They are queued in storage. The server then validates each file (six digit codes, numbers, no duplicates), replaces that country, year and flow
in the database in one transaction, recalculates the country's analysis and refreshes its pages. This happens in the daily refresh (02:00),
or sooner by running `python -m tereflow_oracle ingest-inbox` in the oracle folder. A file with any problem is refused whole and kept with the reason
under collector-inbox/rejected/. Operators never receive database credentials.

**Pipeline kit (the app does not depend on one PC).** Admin, Pipeline tab, "Pipeline kit" downloads the same Oracle pipeline the owner runs (load collector files, recalculate analysis, finance and national loaders, World Bank). With your own Oracle wallet and .env it runs on any Windows PC: `pipeline.cmd load-folder tereflow-data\data`. It holds no secrets and calls no AI. Rebuilt from the repository on every deploy.
 `.partial.csv` files are incomplete and cannot be uploaded.
## Images (Admin, Images tab)

Real photographs only. Open the admin, choose **Images**, pick a category, add a subject (optional) and a short
description for screen readers (required), choose a JPEG, PNG or WebP file up to 5 MB, and press Upload.

| Category | Subject to enter |
| --- | --- |
| Hero images | leave empty |
| Country images | the country's ISO3 code, for example GHA |
| Product category images | the 2-digit HS chapter, for example 18 |
| How-it-works images | the step name |

Hide keeps an image but stops showing it; Delete removes it for good. Categories are rows in the
`media_categories` table, so adding a new kind of image needs no code change. SVG files are refused on purpose.

## Finance module (institutions and figures)

Everything is deterministic: no scraping, no AI. A person prepares the figures, a script or the admin checks them,
and only a file with zero problems is loaded.

**One-off setup** (already done on the live database): `python scripts/finance/bank_load.py create-tables` then `seed-defs`.

**Every time:**
1. Register each institution once: Admin, Finance tab, "Register an institution" (or
   `python scripts/finance/bank_load.py institution CODE "Name" GHA`). Rows for unregistered institutions are rejected.
2. Fill the template (see "Bank data" above).
3. Load it, either way:
   - **Admin, Finance tab, Upload figures (CSV).** In Excel open the Data sheet, Save As CSV. "Check only" lists every
     problem by row without saving. "Check and load" saves. Tick Replace to overwrite earlier figures for the same
     institution, period and metric.
   - **Script, straight from the Excel file:** `python scripts/finance/bank_load.py load FILE.xlsx [--dry-run] [--replace]`
4. A wrong load can be undone: Admin, Finance, Upload history, Revert removes every row from that upload.

The Finance template now carries 35 metrics, including deposit, savings and investment rates (record only rates a bank or the central bank has published; leave the rest out and the page shows "not held"). The Insight step shows a bank scorecard and 2023 onward trends. Each bank's figures need at least two years to draw a trend.

**Offline check and analysis scripts.** Admin, Finance and National tabs each offer an analysis script (.zip). Unzip, then drop the filled file on finance.cmd (or run national.cmd with --frequency). It validates the file with the same rules as the upload, then writes scorecard, trends and a short report next to it. It has no secrets and does not upload anything.

Rankings on `/finance/<ISO3>` use each institution's latest period per metric. Whether higher or lower ranks first is the
`better` field of each metric in `templates/finance_config.json` (re-run `seed-defs` after editing it).

## Sectoral credit intelligence (the Finance page)

The Finance page now reports where the banking system's credit is outstanding across sectors of the economy, how each sector's balance changes over time, and how that connects to trade. The earlier bank-by-bank view is still available at `/finance/GHA/banks` and in Admin, Banks.

**Sources.** Ghana: the Bank of Ghana DataWarehousePro guest API (`https://app.datawarehousepro.com/guest/getMnemonicData/bog/MON/{MNEMONIC}`): a total (`GHA_SAC_0`) and 12 sectors (`GHA_SAC_1` to `GHA_SAC_12`), monthly since January 1999. Other countries: the IMF Monetary and Financial Statistics, Other Depository Corporations (SDMX), which gives broad borrower sectors only (private sector, public non-financial corporations, other financial corporations), not industries. A country with neither is shown as unavailable. National and IMF series are never merged.

**What the numbers mean.** The series are balances (stocks) of outstanding credit. The change between two dates is the net change in outstanding credit, not gross lending or repayments, and a balance is not the money supply. The Bank of Ghana metadata does not say whether its series are stocks, so they are marked "inferred stock" (the sectors add up to the total and the balances carry forward). Confirm with the Bank of Ghana, then set the kind in Admin, Sector credit, which marks it confirmed. The IMF series are balance-sheet asset positions by the IMF's own definition.

**Run it.**
- Scheduled: the daily refresh (`run-refresh.cmd`) runs `python -m tereflow_oracle ingest-credit --trigger schedule`.
- By hand, anywhere with the Oracle wallet: `pipeline.cmd credit` (Pipeline kit). Options: `--country GHA SLE`, `--source bog|imf`, `--backfill`, `--series GHA_SAC_3`, `--analyse-only`.
- From the dashboard: Admin, Sector credit, "Request update" or "Request full backfill". The website cannot run the fetch itself (free plan CPU limit), so this records a request that the next pipeline run picks up and completes. Running again is always safe: nothing is duplicated, revised values are kept in `app_cr_revisions`, and a new raw copy is stored only when the data changed.
- First time on a new database: `python -m tereflow_oracle credit-init` creates the tables and registers the configured series.

**Add a Bank of Ghana mnemonic.** Admin, Sector credit, Series, "Add a Bank of Ghana mnemonic": country, mnemonic (for example `GHA_SAC_13`), a lowercase sector key and the sector name. Then request a full backfill. The unit and frequency are read from the response. Add the sector's trade link in the Sector to trade map (or leave it as none). IMF series are discovered automatically and are never typed in.

**Add a country from a spreadsheet** (when its central bank publishes sector credit but has no feed we can call). In Admin, Sector credit, "Add a country from a spreadsheet", download the workbook template (or run `pipeline.cmd credit-template`). It has three sheets to fill: Source (country, currency, where the table comes from, frequency), Series (one row per sector, same shape as the Bank of Ghana series: mnemonic, sector key, sector name, total or sector, unit, a multiplier to millions if the unit is not millions, and optionally whether it is a stock or a flow) and Data (period down the side, one column per mnemonic across). Use the same sector keys other countries use (agriculture, manufacturing, mining, construction and so on) so the trade link works. Then either upload it in the same panel, or run `pipeline.cmd credit --file kenya.xlsx` (`credit-check` or `--dry-run` only checks it). Every cell is checked by the same rules as a live feed (numbers only, no commas, no negative balances, no periods that have not ended, no duplicates; a blank cell is missing and never zero). If anything is wrong the whole file is refused with the sheet, row and reason, and nothing is loaded. Loading the same file again changes nothing, and a later file with new or corrected months updates only those months and records the old values as revisions. The country shows the figures as their own source ("loaded from a spreadsheet"), never merged with the IMF data. Uploaded files wait in storage for the pipeline (daily, or `pipeline.cmd credit`); refused files and the reasons are listed in the same panel.

**Add a country.** Admin, Sector credit, Countries: add the ISO3 code. The next run asks the IMF what exists for it and registers only the configured credit categories that really exist. Add or change categories in `templates/credit_config.json`.

**Sector to trade map.** Admin, Sector credit, Sector to trade map: which HS codes (2 to 6 digit prefixes) relate to each credit sector, and whether the link is direct or indicative. A sector with no defensible link shows credit alone.

**Data checks.** A missing value is never read as zero. A long non-zero history followed by zeros is flagged (Ghana's Cocoa marketing has reported zero since January 2025). Large jumps and gaps are flagged. Sector shares and the total are shown only where the sectors add up to the reported total.

## Product intelligence (/intel)

Every HS6 product with reported imports has a page at `/intel/<HS6>`: global demand, supply, market pressure, competitiveness (constant market share and Balassa RCA), and a methodology tab. Industry mapping, production network and market opportunities are shown as "not built yet", never as illustrations.

**Run it.** `pipeline.cmd intel` (about 5 minutes for all products; `--hs 090111 --dry-run` prints one product without writing). It is also part of the nightly `run-refresh.cmd`. First time only: `python -m tereflow_oracle product-intel --init`.

**What "global" means.** Only the countries Tereflow ingests. The comparison universe is the importers that reported in both the base and the latest year; the page lists them and the reporters left out. Base year is the latest year minus three (or the nearest year with enough importers).

**Pressure signals.** Positions in the cross-product distribution (top or bottom fifth of products over USD 100,000 imports), recomputed each full run. No fixed thresholds, no composite score. "Potential supply pressure" is a labelled heuristic.

**Checks.** The CMS effects add up to the change in sales (checked for every supplier in the live run, gap under USD 1). The papers named in the brief could not be downloaded here, so the CMS and gravity specifications are the standard ones and are still to be checked against them.

**Industry mapping and production network.** `pipeline.cmd intel-io --init --concordance --mrio` downloads the UN correspondence tables (HS to CPC 2.1 to ISIC Rev.4) and the Eurostat FIGARO input-output table (naio_10_fcp_ii4, 46 regions, 64 industries, year 2024), maps every HS6 to FIGARO industries, and stores direct and Leontief total upstream requirements for every country-industry. The UN tables carry no weights, so none are shown; a product reaching several industries shows each. Re-run when Eurostat publishes a new year; every year is stored separately. Eurostat reuse needs the source acknowledged and any modification stated; both are on the page. Africa is covered only by South Africa and a rest-of-world block. OECD ICIO refused downloads from this machine, so it is not integrated; to add it someone downloads the ICIO zip by hand and a loader is written for it.

**Gravity and opportunities.** `pipeline.cmd intel-gravity --geo dist_cepii.xls` once (CEPII distances, Etalab open licence), then `pipeline.cmd intel-gravity` fits a PPML gravity model per HS chapter and stores model-expected trade beside observed imports, each chapter validated on a 20 percent hold-out against a no-trade-cost baseline. Slow (tens of minutes); run after a new trade year. Market opportunities (in `product-intel`) are screening signals, not forecasts. Armington elasticities are not estimated: that needs a long price and quantity panel and an identification design.

## Other config files (no code change needed)

- `shared/config/sectors.json`: sector choices.
- `shared/config/country-groups.json`: EU member list used for tariffs.
- `oracle/tereflow_oracle/data/worldbank_map.json`: World Bank indicators.
- Tables: `media_categories` (image kinds) and `fin_metric_defs` (finance metrics).

## Business Model Canvas (premium)

A premium user builds a canvas at `/canvas` (no menu link yet): pick a country, a 6-digit HS code, supply or procurement,
(English only). The nine Osterwalder blocks are filled by rules from the Guide for that product and country:
lines tagged "from data" come from Tereflow's own trade data, lines tagged "typical" are standard trade practice from
the template and should be checked. The user can edit, add or remove any line, save, export as text, or print to PDF. Every canvas is stored against the user, country and HS code.

To change labels, helper text or typical lines, edit `shared/config/canvas.json` (no code change). The German text is a
first draft and should be reviewed by a native speaker.

## National statistics (monthly and quarterly series)

For countries whose own statistics office publishes faster than UN Comtrade. A person finds the figures, fills the template,
and the system validates and stores them. Nothing is scraped. Priority countries are listed in `templates/national_config.json`.

**One-off setup** (already done on the live database): `python scripts/national/national_load.py create-tables`.

**Every time:**
1. Register the country's source once: Admin, **National data**, "Register a national source" (name, web address, update
   frequency monthly, quarterly or annual). Or: `python scripts/national/national_load.py source GHA "Ghana Statistical Service" --frequency monthly --url URL`.
   The frequency decides which period format is accepted (`2026-03`, `2026-Q1` or `2026`).
2. Make the template: `python scripts/national/national_load.py make` (writes `templates/national_template.xlsx`; a filled
   example is in `templates/examples/`). Columns: `country_iso3, flow, period, hs_code, value_usd, source_note`.
   `flow` is X (exports) or M (imports). `hs_code` is TOTAL or a 2, 4 or 6 digit code. `value_usd` is US dollars in plain
   digits: convert local currency first and say how in `source_note`. `source_note` is required on every row.
3. Check, with no database: `python scripts/national/national_load.py check FILE --frequency monthly [--report problems.csv]`.
4. Load, either way:
   - **Admin, National data, Upload a series (CSV).** "Check only" lists problems by row. "Check and load" saves. Tick Replace to overwrite earlier figures for the same country, flow, period and product.
   - **Script:** `python scripts/national/national_load.py load FILE [--dry-run] [--replace]`.
5. A wrong load can be undone from Upload history, Revert.

**What users see:** the public **Data sources** page (`/data-sources`, linked from the openings list) shows, for every country and
flow, the latest Comtrade year, the national source and how often it updates, the latest national period held, and the change
so far this year against the same periods last year. Year to date appears only when both years cover exactly the same periods.
The nightly job refreshes the Comtrade side (`national_load.py freshness`).

## Running everything: quick reference

| Job | Command | Dry run | Log |
| --- | --- | --- | --- |
| Trade data collection | `python -m tereflow_oracle ingest --country EST` (or the downloadable collector zip) | `--dry-run` | prints countries, years, rows |
| Monthly totals | `python -m tereflow_oracle ingest-monthly [--country ..]` (default: active countries) | | prints per country |
| Analysis and dashboards | `python -m tereflow_oracle analytics` | | prints per country, retries dropped connections |
| World Bank indicators | `python -m tereflow_oracle worldbank --dry-run` | `--dry-run` | prints observations per country |
| Growth forecast | `python -m tereflow_oracle forecast-eval` then `forecast-run` | eval only reads | report in `reports/` |
| Bank figures | `python scripts/finance/bank_load.py load FILE` | `--dry-run` | prints rows read, problems, rows loaded |
| National series | `python scripts/national/national_load.py load FILE` | `--dry-run` | prints rows read, problems, rows loaded |
| Whole nightly refresh | `run-refresh.cmd` (scheduled) | | `logs\refresh-<date>.log` |

Every loader rejects a file with any bad row, naming the row and column, and never stores a partial file.

## Plan success criteria, checked 11 Nov 2026

| Criterion | Status |
| --- | --- |
| No hardcoded country, product, metric or image lists | Met for lists the operator needs to change (sectors, EU members, World Bank indicators, finance metrics, image categories, national frequencies, landing copy, nightly country list). Remaining by design: `worker/providers/discover.ts` (name aliases for the discovery parser), `worker/providers/countries/ghana.ts` (the Ghana-specific provider) and `shared/frameworks.ts` (the standard Incoterms list). |
| Operator can upload bank Excel and images without a developer | Met. Images in Admin; bank data by CSV in Admin or Excel through the script. The Admin cannot read .xlsx itself (a Cloudflare Worker CPU limit), so Excel goes through the script. |
| Scripts run from the command line with clear output | Met. |
| Welcome page states the purpose | Met. |
| Every major data view offers a next action | Met on the openings list, product detail, Finance, Canvas and Outlook. Not yet on every secondary page. |
| Business Model Canvas, nine blocks, English only, editable, exportable | Met. German text is a first draft and needs a native review. |
| Free and Premium enforced with visible upgrade paths | Met (Canvas, Outlook, saved runs are 402 for free users; upgrade links shown). |
| Africa-first defaults without blocking global data | Met. |
| Documentation for every new script and admin workflow | Met in this guide. |
