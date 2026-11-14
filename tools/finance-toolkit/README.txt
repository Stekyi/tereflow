TEREFLOW FINANCE TOOLKIT
========================
Checks a bank-figures workbook against exactly what Tereflow accepts, and runs the same analysis the website
shows (scorecard, multi-year trends, deposit and investment rates). It works offline, needs no login and holds no secrets.

You need: Windows, Python 3.9 or newer (python.org, tick "Add to PATH"). The first run sets itself up.

1. Get a blank template:      finance.cmd template
   Fill the Data sheet (one row per institution, country, period, metric). The Metrics sheet lists every allowed
   metric and unit. The Institutions sheet is optional but gives names and tells banks from the central bank
   (kind: bank, central_bank, sector).
2. Check it:                  finance.cmd check MYFILE.xlsx
   Every problem is listed by row. Nothing is accepted until the whole file is valid.
3. Analyse it:                finance.cmd analyse MYFILE.xlsx
   Or drag MYFILE.xlsx onto finance.cmd. Results go to an "analysis" folder: scorecard.csv, trends.csv, rates.csv,
   banks.csv and report.md. Open the csv files in Excel.

Rules the checker enforces: metric_code must be in the Metrics sheet; unit must be allowed for that metric; rate
rows need rate_type (fixed, variable, indicative, policy); period is YYYY, YYYY-MM or YYYY-Qn; every row needs a
source_note saying where the figure was published; no duplicate rows. Money is in whole currency units (GHS 31,529,847,000,
not thousands). Nothing is estimated: a measure only appears when the file holds the figures to calculate it.

To put the data on the website, an admin uploads the same file in Admin > Finance. This toolkit is for preparing
and checking it anywhere first. The file finance_config.json is the rule set; replace it with a newer copy from the
admin download when the metric list changes.