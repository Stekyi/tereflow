# National source parsers

National statistical services are the primary input. Comtrade and World Bank remain the validation/fallback sources.

Configure each country's source in Admin. The source URL may be a statistical-service landing page: the pipeline fetches the HTML, discovers the best PDF/XLSX/CSV/JSON/SDMX download link, downloads it in memory, parses it, and releases the bytes after the run. Direct file or API URLs are also supported. Select the physical format, endpoint type, parser, and provide a JSON field mapping when the column names are not standard.

Example CSV or REST JSON mapping:

```json
{
  "year": "year",
  "flow": "flow",
  "stream": "stream",
  "value_usd": "value_usd",
  "hs_code": "hs_code",
  "product_name": "product_name",
  "partner_iso3": "partner_iso3",
  "partner_name": "partner_name",
  "qty": "quantity",
  "qty_unit": "unit"
}
```

For a nested REST response, add `rows_path`, for example `data.records`. For a POST endpoint, add `method`, `headers`, and `request_body`:

```json
{
  "method": "POST",
  "request_body": { "query": "exports" },
  "year": "period",
  "flow": "trade_flow",
  "value_usd": "value_usd",
  "hs_code": "commodity_code",
  "product_name": "commodity_name"
}
```

Supported parser keys are `csv`, `json`, `json-stat`, `sdmx`, `xlsx`, `pdf`, and `html`. HTML pages are searched for links whose URL or label indicates a report, export, data file, or download. Supported endpoint types include `file`, `rest`, `json_stat`, `sdmx`, `pxweb`, `odata`, and `html_download`.

Rows are normalized into the existing `FactRow` contract. Currency values are expected to be USD; if a source is in another currency, configure an explicit `exchange_rate`. Each pipeline run records the source URL, parser, role, status, and row count in `source_attempts`, and the public country source panel displays those attempts.

The pipeline tries national sources in slot order. If no configured national source produces rows, Comtrade supplies goods data and World Bank supplies services and macroeconomic context. When national data succeeds, Comtrade and World Bank are still fetched as validators/context and are not mixed into the primary goods rows.