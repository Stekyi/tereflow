# Manual data workflow

How country data gets into Tereflow. This is the active route. Automated
collection is not running this phase; see the notes at the top of
`docs/national-source-parsers.md` and `extract/README.md`.

A person finds the figures at the source, puts them in a CSV, and uploads them.
Nothing reaches the database until that person has seen a report of what is in
the file and pressed confirm.

## The six datasets

| Dataset | Goes to | What it holds |
| --- | --- | --- |
| `imports` | `trade_facts` | Goods and services bought from abroad, by partner and product |
| `exports` | `trade_facts` | The same with the direction reversed |
| `demographics` | `indicator_observations` | Population, age structure, labour force, education |
| `income` | `indicator_observations` | GDP per head, wages, household spending, poverty |
| `sectors` | `sector_observations` | Output, share of GDP, growth and employment by sector |
| `investment` | `indicator_observations` | FDI, ease of doing business, infrastructure, risk |

Imports and exports are separate files on purpose. One `flow` column that
accepts both directions is one typo away from putting exports into imports, and
nothing downstream would notice.

Trade rows land in `trade_facts`, the table the existing analysis already reads.
There is no parallel trade table. Rows written by an upload carry
`source_ref = 'upload:<id>'`, which is what makes a revert a single delete.

## Doing it

```
npm run data:templates
```

Writes a CSV template and a README for each dataset to `data/templates/`. The
README lists every column: whether it is required, what it means, what values it
accepts, and an example. Start from the template rather than a blank sheet.

Then either use the Manual Data section of the country admin form, or:

```
npm run data:validate -- --country ghana --type exports --file ./data/incoming/x.csv
npm run data:import   -- --country ghana --type exports --file ./data/incoming/x.csv
npm run data:analyse  -- --country ghana
npm run report:country -- --country ghana
```

Files move themselves: `data/incoming/` to `data/processed/` on a clean import,
to `data/rejected/` otherwise. Validation reports land in `data/validation/`.

## Filling the file

**Type plain numbers.** `412300000`, not `412,300,000`. A single separator is
refused rather than guessed, because `1,234` is 1234 in English and 1.234 in
German and picking one silently is a thousandfold error that reads as an
ordinary figure at the far end.

**Trade needs a dollar figure.** `trade_facts.value_usd` cannot be null, so a
row with only a local-currency value is not imported. Convert it yourself and
put the result in `value_usd`, then record the rate you used in
`exchange_rate`. The validator recomputes `value / exchange_rate` and warns if
it disagrees with your `value_usd` by more than two percent, so a slip gets
caught.

Nothing converts for you, on purpose. A rate can be written either way round,
local units per dollar or dollars per local unit, and people reverse it
constantly. If the system divided by a reversed rate it would store a figure
wrong by the square of the rate, which for cedis is roughly a hundredfold, and
still small enough that no plausibility check would catch it. When you do the
division you see the answer and it looks wrong to you.

The validation report tells you how many rows will be held back for want of a
dollar figure before you confirm, so the number you are promised is the number
that lands.

**Leave a cell blank when you do not know.** Blank means unknown. Zero means
zero. They are different and the difference reaches the analysis.

**Every row names its source.** `source_name` is required. A figure nobody can
trace is a figure nobody can check a year from now, including you.

**Quarters and months are never summed into a year.** Use `period` for anything
shorter than a year. Adding four quarters is only right when all four are
present, and the file cannot promise that.

## Import modes

`append_period` adds rows and removes nothing.

`replace_period` deletes the existing rows for this country and dataset **for
the years in the file only**, then inserts. Use it when re-stating a year that
was already loaded.

Neither is the default. The tool asks, every time. A mode that gets assumed is a
mode that eventually deletes a year somebody wanted.

## When something is wrong

Errors block the import and name the row and column, numbered the way your
spreadsheet numbers them, header included. Fix and upload again.

Warnings never block. They are things worth a look that might be perfectly
correct: a figure that jumped tenfold, a percentage below 1 in a column that
means percent, two units for one indicator. Refusing an upload over an unusual
but real figure would teach people to edit their data until the tool stopped
complaining, which is the opposite of the point.

## Undoing an import

Revert removes exactly the rows that upload wrote and nothing else. The upload
stays in the history marked reverted, and the file can then be uploaded again
after correction.

Re-uploading a file already imported is refused by file hash, naming the earlier
upload. This catches the common accident of importing the same file twice and
doubling a year.

## What the analysis will and will not say

`npm run data:analyse` produces metrics from whatever is loaded. Every metric
carries what it was computed from and what was missing, and a confidence.

A metric computed from three of ten indicators says so. A metric with nothing
behind it returns as unavailable rather than as zero. Nothing here is investment
advice and nothing presents itself as certain: the evidence, the assumptions and
the gaps are shown alongside the conclusion so a reader can disagree with it.
