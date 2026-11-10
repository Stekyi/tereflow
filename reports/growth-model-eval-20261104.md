# Tereflow growth model: held-out-year test

Generated 2026-11-04 08:56. Target: a product's World trade value grows at least 10% year on year.
The model is trained on one year and scored on a later year it never saw. 'Momentum' is the rule the site uses now.

## Exports
Countries with complete data: BEL, CHN, CIV, DEU, EST, GBR, GHA, KEN, LBR, NGA, NLD, NOR, SWE, TGO, USA, ZAF.
Trained to predict 2023 (40,573 product-country rows); tested on 2024 (43,084 rows). Base rate of growers in the test year: 32.7%.

| Measure | Model | Momentum rule | Naive |
|---|---|---|---|
| AUC (ranking growers above non-growers, 0.5 = chance) | 0.5896 | 0.4632 | 0.5 |
| Precision in the top 10% ranked | 48.9% | 31.7% | 32.7% |
| Accuracy at 0.5 cut | 67.6% | | 67.3% (always guess majority) |
| Mean abs error of log growth | 0.3383 | 0.5152 | 0.3401 (predict no change) |

Typical 10-90% band around a forecast (log growth): -0.468 to 0.516.
What it leans on: log_value 0.414, yoy_prev 0.207, country_yoy 0.128, partners_log 0.127, world_yoy 0.104, share 0.021.

**Beats momentum on both AUC and top-decile precision: yes.  Beats the base rate: yes.**

## Imports
Countries with complete data: BEL, CHN, CIV, DEU, EST, GBR, GHA, KEN, LBR, NGA, NLD, SWE, TGO, USA, ZAF.
Trained to predict 2023 (50,069 product-country rows); tested on 2024 (52,550 rows). Base rate of growers in the test year: 33.1%.

| Measure | Model | Momentum rule | Naive |
|---|---|---|---|
| AUC (ranking growers above non-growers, 0.5 = chance) | 0.607 | 0.4253 | 0.5 |
| Precision in the top 10% ranked | 50.4% | 28.1% | 33.1% |
| Accuracy at 0.5 cut | 67.2% | | 66.9% (always guess majority) |
| Mean abs error of log growth | 0.36 | 0.557 | 0.3519 (predict no change) |

Typical 10-90% band around a forecast (log growth): -0.47 to 0.546.
What it leans on: yoy_prev 0.381, log_value 0.273, country_yoy 0.158, world_yoy 0.074, partners_log 0.061, share 0.053.

**Beats momentum on both AUC and top-decile precision: yes.  Beats the base rate: yes.**

## Limits

- Only four years of data exist for most countries, so this is one train year and one test year. One test year can flatter or punish a model; more years will firm it up as data accrues.
- Trade values move with prices and exchange rates, not only volumes. A product that 'grew' may simply have got dearer.
- Shocks (wars, sanctions, tariffs) are not in the features, so the model will miss them.
- The band is the spread of errors on the test year, not a guarantee.
