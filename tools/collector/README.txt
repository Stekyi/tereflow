Tereflow collector
==================
Collects UN Comtrade trade data for the countries you choose and writes simple analysis files.
It runs on any Windows PC with Python 3.9 or newer. It never touches the Tereflow database.

Quick start
1. Get a free key at https://comtradedeveloper.un.org (subscribe to the "comtrade - v1" product).
2. Unzip this folder anywhere.
3. Double-click collect.cmd. First run installs what it needs, then asks for your key, the countries
   (ISO3 codes, e.g. EST FIN SWE) and the years.

From a command prompt you can pass arguments instead:
  collect.cmd --country EST FIN --years 2023 2024
  collect.cmd --country NOR --years-back 3 --flow X --out D:\trade
  collect.cmd --country SWE --years 2024 --dry-run
  collect.cmd --list-countries

Arguments
  --country ISO3 ...   reporter countries (required)
  --years Y ...        explicit years; otherwise --years-back closed years (default 3)
  --flow X|M|both      exports, imports or both (default both)
  --out FOLDER         output folder (default tereflow-data next to the script)
  --api-key KEY        or set COMTRADE_API_KEY, or let collect.cmd save it in comtrade_key.txt
  --pace-ms N          pause between calls, never below 1200
  --force              refetch files that already exist (otherwise they are skipped, so re-runs resume)
  --no-analysis        collect only
  --analyse-only       analyse files already downloaded
  --dry-run            show what would be fetched and stop
  --list-countries     print the supported codes

Output
  data\<ISO3>_<year>_<X|M>.csv         HS6 trade by partner
  analysis\<ISO3>_<flow>_summary.csv   yearly total, growth, partner concentration (HHI), top partner and product
  analysis\<ISO3>_<flow>_top_<year>.csv  top 25 products and partners for the latest year

The free key has a daily call quota. If it runs out the script stops cleanly; run it again later and it
carries on from the files it already has.
