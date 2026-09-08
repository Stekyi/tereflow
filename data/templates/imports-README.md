# Imports upload template

Goods and services bought from abroad, by partner and product. These rows join the same table the trade analysis already reads, so they appear in the existing charts without any further step.

Refresh: Annual. Most agencies publish three to nine months after the year ends.

Fill the CSV that came with this file. The first line is the header and must stay exactly as written. The two rows under it are examples: replace them with your own figures, or delete them and paste yours below the header.

Do not add comment lines to the CSV. A spreadsheet reads every line as data, so a note in the file would be checked as if it were a figure and rejected. Anything you want to record about a row goes in that row, in a notes column where the dataset has one.

## Columns

### country_iso3

- Required: required
- Meaning: The reporting country, as a three-letter ISO 3166 code. Must match the country you are uploading against.
- Accepted values: any
- Example: `GHA`

### year

- Required: required
- Meaning: Calendar year the figure covers. Use the period column for anything shorter.
- Accepted values: any
- Example: `2024`

### period

- Required: optional
- Meaning: Only when the row is not a full year. Use 2024-Q1 or 2024-03. Quarters and months are never summed into a year automatically, because that is only correct when all of them are present.
- Accepted values: any
- Example: left blank

### flow

- Required: required
- Meaning: Must be import in this template. The other direction has its own file so a mistake cannot put exports into imports.
- Accepted values: one of import
- Example: `import`

### stream

- Required: required
- Meaning: goods or services. Services carry a sector instead of an HS code.
- Accepted values: one of goods, services
- Example: `goods`

### partner_iso3

- Required: optional
- Meaning: The country on the other side. Leave blank for a total across all partners, which is a real and useful row.
- Accepted values: any
- Example: `NLD`

### partner_name

- Required: optional
- Meaning: Partner as printed in your source. Used to check the code, and kept when a partner is a grouping like the EU that has no country code.
- Accepted values: any
- Example: `Netherlands`

### hs_code

- Required: optional
- Meaning: Harmonised System code, 2, 4 or 6 digits. Leave blank for a country total. Do not mix levels in one file: a chapter and its subheadings describe the same trade twice.
- Accepted values: any
- Example: `180100`

### product_name

- Required: optional
- Meaning: Product as printed in your source.
- Accepted values: any
- Example: `Cocoa beans, whole or broken`

### sector_code

- Required: optional
- Meaning: For services, where there is no HS code. See the sector list in the admin page.
- Accepted values: any
- Example: left blank

### sector_name

- Required: optional
- Meaning: Sector as printed in your source.
- Accepted values: any
- Example: left blank

### value

- Required: optional
- Meaning: The figure as your source states it, in the currency named below. Fill this or value_usd, or both.
- Accepted values: not negative
- Example: left blank

### currency

- Required: optional
- Meaning: ISO 4217 code for the value column, such as USD, EUR, GHS. Required whenever value is filled and value_usd is not. Never assumed: a bare figure could be any currency.
- Accepted values: any
- Example: left blank

### value_usd

- Required: optional
- Meaning: The figure in US dollars. Fill this where your source publishes dollars, or where you have converted it yourself. Rows without it are stored but are not counted in trade totals, which are dollar based.
- Accepted values: not negative
- Example: `412300000`

### exchange_rate

- Required: optional
- Meaning: Local currency units per US dollar, if you converted the value yourself. Recording the rate you used is what makes the conversion checkable rather than a number that appeared from nowhere.
- Accepted values: not negative
- Example: left blank

### quantity

- Required: optional
- Meaning: How much was traded, in the unit below. Optional, but it is what makes a price per tonne possible.
- Accepted values: not negative
- Example: `365048000`

### quantity_unit

- Required: optional
- Meaning: Unit for the quantity.
- Accepted values: usually one of kg, tonnes, litres, units, items, m3, barrels, carats, pairs, dozens; another value loads with a warning
- Example: `kg`

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

## What makes one row different from another

Two rows that share year, period, flow, stream, partner_iso3, hs_code, sector_code are treated as the same observation stated twice. Importing both would count the figure twice, so a repeat is refused. Change one of those columns if the rows really are different things.

## Notes

- One row per partner and product. A row with both left blank is the country total.
- Do not put a chapter total and its products in the same file. They describe the same trade at two levels and anything summing the file would count it twice.
- A row without value_usd is kept, but trade totals are computed in dollars and will not include it.

## Source columns

Every row asks who published the figure. A number with no source cannot be checked by anybody later, which is the difference between a figure and a guess. The source URL is optional but strongly recommended: it is what still lets somebody verify the number a year from now.
