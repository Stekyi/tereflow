# Household income and consumption upload template

Income, spending, poverty, inequality and prices. Carries a currency and a price basis, because a nominal figure and a real one are not comparable and the difference is invisible once stored.

Refresh: Annual for prices. Household surveys often run every three to five years.

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

### currency

- Required: optional
- Meaning: ISO 4217 code. Required whenever the unit is currency, or the figure means nothing.
- Accepted values: any
- Example: `GHS`

### price_basis

- Required: optional
- Meaning: nominal is money of the day. real is inflation adjusted, and needs a base year in notes. ppp is purchasing power adjusted. Comparing across these silently is a common and serious error.
- Accepted values: one of nominal, real, ppp
- Example: `nominal`

### income_group

- Required: optional
- Meaning: Such as bottom-20 or top-10, for income share rows.
- Accepted values: any
- Example: left blank

### region

- Required: optional
- Meaning: Blank means the whole country.
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

### notes

- Required: optional
- Meaning: The poverty line used, the survey, the base year for a real series.
- Accepted values: any
- Example: left blank

## What makes one row different from another

Two rows that share year, indicator_code, income_group, region, price_basis are treated as the same observation stated twice. Importing both would count the figure twice, so a repeat is refused. Change one of those columns if the rows really are different things.

## Notes

- Say which currency and which price basis. A median income of 4,500 means nothing without both.
- The Gini coefficient is accepted on either the 0 to 1 or the 0 to 100 scale. State which in the unit column.

## Source columns

Every row asks who published the figure. A number with no source cannot be checked by anybody later, which is the difference between a figure and a guess. The source URL is optional but strongly recommended: it is what still lets somebody verify the number a year from now.
