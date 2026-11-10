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