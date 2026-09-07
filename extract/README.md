# Extraction pipeline

Reads trade statistics out of whatever a source happens to publish, and refuses
to invent the parts it cannot read.

Open source libraries only. No paid services and no language model anywhere in
the path: every field is produced by a stated rule, and every rule can be
pointed at when a figure is questioned.

```
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

.venv\Scripts\python.exe -m tereflow_extract.cli probe --url URL --fmt csv
.venv\Scripts\python.exe -m tereflow_extract.cli run   --url URL --slug ghana --out out
.venv\Scripts\python.exe -m tereflow_extract.cli sources --db-json registry.json --out out
```

## Where this sits

The TypeScript pipeline in `local/` already works and is untouched. It handles
the two structured APIs the app depends on, UN Comtrade and the World Bank, and
it is the path that fills the database today.

This is a second, separate producer for the other 478 sources in the registry,
the ones no API adapter can read: national statistics portals, PDF bulletins,
spreadsheets and landing pages. It writes JSON in the exact shape the existing
`/api/admin/ingest/facts` endpoint already accepts, so nothing in the Worker,
the schema or the existing pipeline had to change to accommodate it.

```
  local/pipeline.ts ──▶ comtrade, worldbank ──┐
                                              ├──▶ POST /api/admin/ingest/facts ──▶ D1
  extract/  (this)  ──▶ facts.*.json      ────┘
```

## The finding that shaped the design

The registry records a `fmt` for every source. It is not what the URL returns.

Five sources registered as `csv` were checked by hand. Four returned an HTML
landing page and one returned a directory listing. None returned a CSV.

That is not a labelling nuisance, it is the central design problem. Handing a
page of markup to `pandas.read_csv` does not fail: it returns a frame of angle
brackets and navigation labels, and every one of those rows looks like data to
everything downstream. So the format is established from the bytes, and the
registry's own label is recorded for comparison but never gets a vote.

```
declared=csv -> html_static  OVERRIDE  cepii.fr/.../bdd_modele_item.asp?id=37
declared=csv -> html_static  OVERRIDE  www150.statcan.gc.ca/t1/tbl1/en/tv.action
declared=csv -> html_static  OVERRIDE  atlas.hks.harvard.edu/data-downloads/
declared=api -> json         AGREES    api.worldbank.org/v2/country/GHA/...
```

The recovery matters as much as the detection. Landing on HTML where data was
expected triggers a search of the page for the file it points at, and one hop
to follow it. That single step is what makes most of the registry readable:

```
statcan tv.action (HTML)
  -> found 12100121-eng.zip  (href ends .zip; link text says download)
  -> archive holds 2 files, read the largest, 12100121.csv
  -> 519,948 rows
```

## What comes out

Three files, and the split between them is the whole guarantee.

| file | what is in it |
|---|---|
| `facts.<slug>.NNN.json` | rows ready to POST to `/api/admin/ingest/facts` unchanged |
| `quarantine.json` | rows that were read but did not qualify, each with the reason |
| `manifest.json` | what ran, what was detected, what came of it |

Nothing is discarded silently. A source yielding four hundred rows in cedis
produces an empty facts file and four hundred quarantine entries saying so,
which is a very different message from a source that yielded nothing.

Quarantine reasons are specific because they need different work:

| reason | what it means |
|---|---|
| `non_usd` | a real value in a stated currency that is not dollars |
| `unknown_currency` | a real value, and nothing in the source says what money it is |
| `no_year` | no year could be established for the row |
| `ambiguous_country` | a name that sits between two real countries |
| `unparseable_value` | the cell could not be read without guessing |
| `implausible` | a magnitude that can only be a separator or scale error |
| `low_confidence` | complete, but not well enough evidenced to store |

## What it will not do

**It does not convert currency.** Turning cedis into dollars needs a rate, and
a rate needs a date: the cedi moved about forty percent against the dollar
during 2022. One hardcoded rate would produce figures wrong by that much and
keep producing them long after anyone remembered where it came from. So the
currency the source printed is preserved, and `trade_facts.value_usd` is only
filled where the source itself said dollars.

**It does not resolve ambiguous country names.** Fuzzy matching is the obvious
tool and it is also the trap. Niger and Nigeria are one letter apart and both
are major exporters. Guinea, Guinea-Bissau, Equatorial Guinea and Papua New
Guinea are four countries. Congo and DR Congo are two. A similarity score maps
Niger onto Nigeria happily and the row then looks completely normal, attributed
to a country with twenty times the trade. Those names are exact-match only, and
anything sitting between two of them returns nothing.

```
Niger        -> NER   Korea    -> refused, which one
Nigeria      -> NGA   Nigera   -> refused, too close to two real names
DR Congo     -> COD   World    -> refused, an aggregate is not a country
```

**It does not read an ambiguous number.** `1,234` is one thousand two hundred
in English and 1.234 in German, and reading it wrong is a factor of a thousand
that nothing downstream will ever question. Where the digits alone cannot
settle it, the surrounding text is consulted for evidence, and where there is
none the cell is refused.

```
1,234.56          -> 1234.56    both separators present, rightmost is decimal
1.234,56          -> 1234.56
1,204 million     -> 1.204e9    an English magnitude word means dot-decimal
1,204 Millionen   -> 1.204e6    a German one means comma-decimal
1,234             -> refused    nothing says which convention
1,234 under a header reading "Value (US$ million)" -> 1234.0, then scaled
```

**It does not guess at OCR.** Scanned digits confuse 1 with l, 0 with O, 5 with
S, and a lost decimal point turns 1.5 into 15. Ambiguous characters are flagged
rather than corrected, and flagged rows are capped below the acceptance
threshold whatever else is right about them.

## Confidence

A weighted score over six components, each a stated rule about evidence rather
than a probability. Weights are in `confidence.py` and sum to one.

| component | weight | why |
|---|---|---|
| value | 0.30 | a figure whose magnitude cannot be trusted is useless |
| year | 0.22 | a right value in the wrong year produces growth out of nothing |
| country | 0.18 | a row not attributable to anybody is not a fact |
| flow | 0.14 | export and import are not interchangeable |
| commodity | 0.10 | may legitimately be absent, a country total is still a fact |
| structure | 0.06 | a cell in a machine-readable table is better evidence than a scan |

Some flags cap the score outright rather than being outweighed:
`ocr:ambiguous-digit` caps at 0.40, `source:prose` at 0.70. Default acceptance
threshold is 0.62.

There is deliberately no component rewarding a value for looking plausible. A
fabricated number in the right range is more dangerous than an obviously wrong
one, and scoring it higher would be backwards.

## Layout

```
tereflow_extract/
  contracts.py     Extraction (wide, what the source said) and Fact (narrow, what D1 takes)
  detect.py        empirical type sniffing from bytes, mime and extension
  fetch.py         polite client, disk cache, retry, browser identity
  pipeline.py      the router, including the one-hop link recovery
  confidence.py    scoring and the accept or quarantine verdict
  emit.py          the three output files, and the narrowing that gates them
  cli.py
  normalize/
    numbers.py     separators, magnitudes, refusals
    currency.py    identification only, never conversion
    countries.py   ISO3 with guarded exact matches for the dangerous pairs
    commodities.py HS codes, levels, total-row detection
    fields.py      column headers in six languages
  parsers/
    tabular.py     csv, tsv, xlsx, xls, ods, wide-to-long reshaping
    api_json.py    nested and column-oriented API responses
    sdmx.py        SDMX-ML and SDMX-JSON, with an lxml fallback
    html_static.py tables and readable text
    html_dynamic.py  Playwright, optional
    discovery.py   finding the data file an HTML page points at
    pdf_tables.py  ruled and whitespace-aligned tables
    pdf_text.py    figures stated in prose
    pdf_ocr.py     scans, when Tesseract is present
```

## Tests

```
.venv\Scripts\python.exe -m pytest tests\ -q      # 40
.venv\Scripts\python.exe tests\test_e2e.py        # 27
```

The end-to-end suite asserts refusals as much as extractions. A pipeline that
finds facts is easy; one that declines to invent them under pressure is the
point.

## Bugs this found in itself

Recorded because each was silent, and silence is the failure mode that matters.

**A UTF-8 BOM lost 519,948 years.** Excel and most government portals write a
BOM on every CSV they export. It sits invisibly on the first header cell, which
then reads as `REF_DATE` on screen while comparing unequal to `REF_DATE`. The
column simply failed to map, every row lost its year, and nothing raised.

**Header scale was ignored, worth a factor of a thousand.** A column headed
`Value (US$ thousand)` holding `412300` means 412.3 million. Two parsers read
the cell alone. Caught by an assertion, not by inspection.

**Scale can also live in a column.** StatCan prints `millions` in a
`SCALAR_FACTOR` column beside a `VALUE` of `12417.8`, meaning 12.4 billion.
Both scale sources are now applied, and never both to the same figure.

**Keeping `e` for scientific notation let currency codes through.** The
character filter preserved `eE`, so `1,204 EUR` became `1,204 E` and failed to
parse at all.

**Discovered archives were refused.** `ZIP` was missing from the set of types
worth following, so the one link worth taking on the StatCan page was thrown
away at the moment discovery had done its job.

**Test stubs shadowed the real modules.** Two suites registered stand-in
`normalize` modules in `sys.modules` while the real ones were being written in
parallel. Once the real modules existed the stubs kept overriding them, so the
tests exercised a simplified number reader instead of the shipping one, and the
header-scale bug above stayed green throughout. Both are now no-ops with the
reason recorded.

## Not done

- **OCR is untested here.** The Tesseract binary and poppler are not installed
  on this machine. The code path is written and reports its own unavailability
  clearly rather than returning empty text that would read as an empty
  document. Install with `choco install tesseract poppler`.
- **JavaScript rendering is untested here.** Playwright is not installed. Same
  discipline: `rendering_available()` says so and `render()` returns a reason
  rather than a blank page. `atlas.hks.harvard.edu` and
  `comexstat.mdic.gov.br` both need it, and the latter returns 403 to any
  non-browser request.
- **No FX table.** Until one exists with dated rates, non-USD rows stay
  quarantined with their real values intact.
