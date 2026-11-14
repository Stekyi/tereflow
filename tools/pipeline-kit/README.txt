Tereflow pipeline kit
=====================

This is the data pipeline behind the app: load trade, finance and national data into Oracle and recalculate
the analysis the app shows. It runs on any Windows PC with Python 3.9+. It does not depend on the machine
that built it, and it contains no AI: every step is a fixed rule, so the same data always gives the same result.

It holds no secrets. You bring your own Oracle wallet and login.

Set up (once)
1. Unzip anywhere. Put your Oracle wallet folder (the unzipped Wallet_tereflow) inside this folder.
2. Copy env.example to .env and fill in the Oracle lines. Keep .env and the wallet private.
3. Run:  pipeline.cmd check      (first run installs what it needs, then tests the connection)

Everyday use
  pipeline.cmd load-folder tereflow-data\data      load the collector's CSVs, then recalculate those countries
  pipeline.cmd load-folder tereflow-data\data --dry-run     check the files only, load nothing
  pipeline.cmd analytics --country ETH             recalculate one country again
  pipeline.cmd comtrade --country ETH --years 2023 2024     fetch straight from UN Comtrade into Oracle
  pipeline.cmd finance-check BANKS.xlsx   then   pipeline.cmd finance load BANKS.xlsx
  pipeline.cmd national check FILE.xlsx / national load FILE.xlsx
  pipeline.cmd worldbank
  pipeline.cmd status

What a load does
  The collector's files are checked (six digit product codes, numbers, no duplicate lines). A country, year and
  flow already in the database is replaced by the file in one transaction, so a failure leaves the old data
  untouched. Then the product metrics, opportunity scores and the country page data are recalculated.

After a load the live pages can show the new numbers straight away from Oracle. The cached copies of the
heaviest anonymous pages (the "snapshots") are rebuilt with "npm run snapshots" in the full repository,
which needs Node and the Cloudflare login; until then those cached pages are at most a day old.

The same finance and national upload also exists in the website admin (CSV), which loads through the app
and needs no Oracle login at all.

Folder map
  oracle\tereflow_oracle   the pipeline code            oracle\schema   table definitions
  oracle\ords              database API handlers        templates       the rules and example files
  scripts                  finance and national loaders
