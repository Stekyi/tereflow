# Other investment indicators upload template

Infrastructure, business environment, stability, risk and investment flows. The general sheet for anything the other five do not cover.

Refresh: Varies by indicator. Most are annual.

Fill the CSV that came with this file. The first line is the header and must stay exactly as written. The two rows under it are examples: replace them with your own figures, or delete them and paste yours below the header.

Do not add comment lines to the CSV. A spreadsheet reads every line as data, so a note in the file would be checked as if it were a figure and rejected. Anything you want to record about a row goes in that row, in a notes column where the dataset has one.

## Columns

### country_iso3

- Required: required
- Meaning: Three-letter ISO 3166 code. Must match the country you are uploading against.
- Accepted values: any
- Example: `GHA`

### year

- Required: required
- Meaning: Year the observation refers to.
- Accepted values: any
- Example: `2024`

### indicator_code

- Required: required
- Meaning: Code from the indicator list in the admin page, such as POP_TOTAL. A code not on the list is accepted with a warning rather than refused, because a country may track something the list does not.
- Accepted values: any
- Example: `POP_TOTAL`

### indicator_name

- Required: optional
- Meaning: Readable name. Filled from the catalogue when you leave it blank.
- Accepted values: any
- Example: `Total population`

### value

- Required: required
- Meaning: The figure. Use a plain number: no thousands separators, no percent sign, no currency symbol.
- Accepted values: any
- Example: `34121985`

### unit

- Required: required
- Meaning: What the figure counts. Getting this wrong is the most common way an indicator ends up a hundred or a thousand times out.
- Accepted values: usually one of persons, percent, index, years, currency, ratio, count, per_1000, per_100, persons_per_km2, days, percent_of_gdp, currency_per_kwh, currency_per_worker, km_per_100km2, teu; another value loads with a warning
- Example: `persons`

### category

- Required: optional
- Meaning: Groups the indicator in the report. Filled from the catalogue when you leave it blank.
- Accepted values: one of macro, demographics, labour, infrastructure, digital, trade, finance, regulation, governance, risk, resources, climate, health, education, consumer, investment
- Example: `infrastructure`

### currency

- Required: optional
- Meaning: ISO 4217 code, required when the unit is currency.
- Accepted values: any
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

### confidence

- Required: optional
- Meaning: How much you trust this figure, 0 to 1. Blank means you did not say, which is not the same as certain. It is carried into the report so a recommendation can show what it rests on.
- Accepted values: at least 0, at most 1
- Example: `0.8`

### notes

- Required: optional
- Meaning: Method, caveats, why the figure is what it is.
- Accepted values: any
- Example: left blank

## What makes one row different from another

Two rows that share year, indicator_code, category are treated as the same observation stated twice. Importing both would count the figure twice, so a repeat is refused. Change one of those columns if the rows really are different things.

## Notes

- Use the indicator codes from the admin page where one fits. A code nobody recognises still loads, with a warning, so it will not appear in the standard charts.
- Fill confidence where you know it. It is the difference between a report that says how sure it is and one that implies certainty it does not have.

## Source columns

Every row asks who published the figure. A number with no source cannot be checked by anybody later, which is the difference between a figure and a guess. The source URL is optional but strongly recommended: it is what still lets somebody verify the number a year from now.
