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
under collector-inbox/rejected/. Operators never receive database credentials. `.partial.csv` files are incomplete and cannot be uploaded.
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
