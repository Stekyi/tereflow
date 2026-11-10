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

Rankings on `/finance/<ISO3>` use each institution's latest period per metric. Whether higher or lower ranks first is the
`better` field of each metric in `templates/finance_config.json` (re-run `seed-defs` after editing it).

## Other config files (no code change needed)

- `shared/config/sectors.json`: sector choices.
- `shared/config/country-groups.json`: EU member list used for tariffs.
- `oracle/tereflow_oracle/data/worldbank_map.json`: World Bank indicators.
- Tables: `media_categories` (image kinds) and `fin_metric_defs` (finance metrics).
