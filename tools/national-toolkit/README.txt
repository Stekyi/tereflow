TEREFLOW NATIONAL STATISTICS TOOLKIT
====================================
Checks a trade-series workbook (monthly, quarterly or annual figures from a country's own statistics office) against
exactly what Tereflow accepts, and analyses it: totals by period, change on the same period a year earlier, year to date,
and the biggest-moving products. Works offline, no login, no secrets.

You need: Windows, Python 3.9 or newer (python.org, tick "Add to PATH"). The first run sets itself up.

1. Blank template:           national.cmd template
2. Check:                    national.cmd check MYFILE.xlsx --frequency monthly
3. Analyse:                  national.cmd analyse MYFILE.xlsx --frequency monthly
   Results go to an "analysis" folder, one sub-folder per country and flow: totals.csv, products.csv, report.md.

Columns: country_iso3, flow (X exports, M imports), period (monthly 2026-03, quarterly 2026-Q1, annual 2025), hs_code
(TOTAL, or 2, 4 or 6 digits, keep leading zeros), value_usd (whole US dollars), source_note (where it was published).
A change is shown only if the same period a year earlier is in the file. To load the data on the website an admin
uploads the same file in Admin > National data, after registering the source and its frequency.