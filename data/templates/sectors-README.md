# Economic sectors upload template

Sector and subsector output, share of GDP, growth, employment and trade. Several measures for the same sector year sit on one row, because they describe one thing.

Refresh: Annual, with the national accounts.

Fill the CSV that came with this file. The first line is the header and must stay exactly as written. The two rows under it are examples: replace them with your own figures, or delete them and paste yours below the header.

Do not add comment lines to the CSV. A spreadsheet reads every line as data, so a note in the file would be checked as if it were a figure and rejected. Anything you want to record about a row goes in that row, in a notes column where the dataset has one.

## Columns

### country_iso3

- Required: required
- Meaning: Three-letter ISO 3166 code.
- Accepted values: any
- Example: `GHA`

### year

- Required: required
- Meaning: Year the figures cover.
- Accepted values: any
- Example: `2024`

### sector_code

- Required: required
- Meaning: From the sector list in the admin page, such as agriculture or manufacturing.
- Accepted values: any
- Example: `agriculture`

### sector_name

- Required: optional
- Meaning: Readable name.
- Accepted values: any
- Example: `Agriculture`

### subsector_code

- Required: optional
- Meaning: Optional finer breakdown.
- Accepted values: any
- Example: left blank

### subsector_name

- Required: optional
- Meaning: Readable name.
- Accepted values: any
- Example: left blank

### value

- Required: optional
- Meaning: Sector output or value added, in the currency below.
- Accepted values: not negative
- Example: `89400000000`

### unit

- Required: optional
- Meaning: What value counts.
- Accepted values: usually one of currency, index, persons, percent; another value loads with a warning
- Example: `currency`

### currency

- Required: optional
- Meaning: ISO 4217 code, required when unit is currency.
- Accepted values: any
- Example: `GHS`

### share_of_gdp

- Required: optional
- Meaning: Percent of GDP, 0 to 100. Shares across all sectors in a year are checked to see whether they add up, and flagged when they do not.
- Accepted values: at least 0, at most 100
- Example: `21.4`

### growth_rate

- Required: optional
- Meaning: Percent change on the previous year. Negative is allowed.
- Accepted values: at least -100, at most 1000
- Example: `3.2`

### employment

- Required: optional
- Meaning: People employed in the sector.
- Accepted values: not negative
- Example: `3900000`

### employment_share

- Required: optional
- Meaning: Percent of total employment, 0 to 100.
- Accepted values: at least 0, at most 100
- Example: `32.1`

### exports_value

- Required: optional
- Meaning: Sector exports, same currency as value.
- Accepted values: not negative
- Example: left blank

### imports_value

- Required: optional
- Meaning: Sector imports, same currency as value.
- Accepted values: not negative
- Example: left blank

### source_name

- Required: required
- Meaning: Who published this. A figure with no source cannot be checked by anybody later.
- Accepted values: any
- Example: `Ghana Statistical Service`

### source_url

- Required: optional
- Meaning: Page or file the figures came from. Strongly recommended: it is what makes a number verifiable a year from now.
- Accepted values: any
- Example: `https://statsghana.gov.gh/trade-2024`

### notes

- Required: optional
- Meaning: Definitions, revisions, anything a reader needs.
- Accepted values: any
- Example: left blank

## What makes one row different from another

Two rows that share year, sector_code, subsector_code are treated as the same observation stated twice. Importing both would count the figure twice, so a repeat is refused. Change one of those columns if the rows really are different things.

## Notes

- One row per sector year. Put several measures on the same row rather than repeating the sector.
- Leave a measure blank where you do not have it. A blank is read as not reported, which is different from zero.

## Source columns

Every row asks who published the figure. A number with no source cannot be checked by anybody later, which is the difference between a figure and a guess. The source URL is optional but strongly recommended: it is what still lets somebody verify the number a year from now.
