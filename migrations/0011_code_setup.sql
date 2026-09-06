-- Admin-editable configuration.
--
-- Anything that was a number or a label sitting in the source and that somebody
-- might reasonably want to change lives here instead: score band cut-offs, the
-- noise floors, the growth threshold past which a rate is called newly
-- established, the coverage target the fetch aims at, and the wording attached
-- to each of those.
--
-- Shape is deliberately the standard three columns. `code` is the key the code
-- looks up, `name` is what it is called in the portal, `description` says what
-- changing it will do. `value` carries the setting itself, because a lookup
-- table with no value is only half a lookup table.
--
-- Every row is seeded with the value that was previously hardcoded, so applying
-- this migration changes no behaviour. The defaults are kept alongside so the
-- portal can show what a setting started as and offer to put it back.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS code_setup (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  value         TEXT NOT NULL,
  default_value TEXT NOT NULL,
  -- 'number' | 'text' | 'percent' | 'usd'. Drives the portal's input and the
  -- parse on read, so a number setting cannot be saved as prose.
  kind          TEXT NOT NULL DEFAULT 'number' CHECK (kind IN ('number','text','percent','usd')),
  -- Groups rows in the portal. Purely presentational.
  category      TEXT NOT NULL DEFAULT 'general',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_code_setup_category ON code_setup(category, code);

INSERT OR IGNORE INTO code_setup (code, name, description, value, default_value, kind, category) VALUES
  ('SCORE_BAND_STRONG', 'Strong case cut-off',
   'A product scoring at or above this is labelled a strong case. Raising it makes the label rarer.',
   '65', '65', 'number', 'scoring'),
  ('SCORE_BAND_MODERATE', 'Worth a look cut-off',
   'A product scoring at or above this, but below the strong cut-off, is labelled worth a look. Below it, early days.',
   '45', '45', 'number', 'scoring'),

  ('SCORE_WEIGHT_GROWTH', 'Score weight: growth',
   'How much of the 100 points come from how fast the trade is growing. The four weights should add up to 100.',
   '34', '34', 'number', 'scoring'),
  ('SCORE_WEIGHT_MOMENTUM', 'Score weight: momentum',
   'How much of the 100 points come from share gained and how steady the growth has been.',
   '26', '26', 'number', 'scoring'),
  ('SCORE_WEIGHT_CONFIDENCE', 'Score weight: confidence',
   'How much of the 100 points come from how well evidenced the pattern is.',
   '22', '22', 'number', 'scoring'),
  ('SCORE_WEIGHT_SIZE', 'Score weight: size',
   'How much of the 100 points come from how big the trade already is.',
   '18', '18', 'number', 'scoring'),

  ('NEW_TRADE_CAGR_PCT', 'Newly established threshold',
   'Growth above this per year means the earlier year was negligible rather than that the trade compounds at that rate. Those are shown as newly established instead of as a percentage.',
   '300', '300', 'percent', 'scoring'),

  ('NOISE_FLOOR_HS6_USD', 'Minimum product value',
   'A specific product line worth less than this is not shown as an opening. Lowering it surfaces smaller trades and more noise.',
   '2000000', '2000000', 'usd', 'thresholds'),
  ('NOISE_FLOOR_HS6_SHARE', 'Minimum product share',
   'A specific product line below this fraction of a country trade is not shown as an opening. 0.0002 is 0.02 percent.',
   '0.0002', '0.0002', 'number', 'thresholds'),
  ('NOISE_FLOOR_HS2_USD', 'Minimum chapter value',
   'As above, for whole product chapters, which are much larger than single lines.',
   '5000000', '5000000', 'usd', 'thresholds'),
  ('NOISE_FLOOR_HS2_SHARE', 'Minimum chapter share',
   'As above, for whole product chapters. 0.002 is 0.2 percent.',
   '0.002', '0.002', 'number', 'thresholds'),
  ('MIN_GROWTH_PCT', 'Minimum growth to be an opening',
   'A product growing slower than this per year is not surfaced as an opening at all.',
   '8', '8', 'percent', 'thresholds'),
  ('GROWTH_BASE_DIVISOR', 'Growth base divisor',
   'The earlier year must be worth at least the minimum product value divided by this before any growth rate is calculated. Guards against a rate computed from a rounding artifact.',
   '20', '20', 'number', 'thresholds'),

  ('SIGNALS_PER_COUNTRY', 'Openings kept per country',
   'How many openings are stored for each country after both trade directions are merged.',
   '40', '40', 'number', 'limits'),
  ('SIGNALS_PER_FLOW', 'Openings kept per direction',
   'How many openings are kept for exports and for imports separately, before merging.',
   '25', '25', 'number', 'limits'),
  ('MARKET_TOP_N', 'Countries per product list',
   'How many countries appear on each side of a product, buying and selling.',
   '10', '10', 'number', 'limits'),
  ('TOP_OPPORTUNITIES', 'Openings on the product page',
   'How many openings the headline list shows before you filter or search.',
   '5', '5', 'number', 'limits'),

  ('CHAPTER_COVERAGE_TARGET', 'Fetch coverage target',
   'The pipeline fetches specific products for the largest chapters until this share of a country goods trade is covered. Higher is more complete and slower.',
   '0.92', '0.92', 'number', 'pipeline'),
  ('MAX_DETAIL_CHAPTERS', 'Maximum chapters fetched',
   'A hard ceiling on chapters fetched per country, so a diversified economy cannot turn into hundreds of source requests.',
   '22', '22', 'number', 'pipeline'),
  ('DOMINANT_SHARE_THRESHOLD', 'Dominant commodity share',
   'A chapter carrying at least this share of a country exports counts as its own headline commodity and is treated as traditional.',
   '0.25', '0.25', 'number', 'pipeline'),

  ('PRICE_PREMIUM_HIGH', 'Price premium: high',
   'A country earning at least this multiple of the world median price for a product is selling at a high premium. 1.15 is fifteen percent above.',
   '1.15', '1.15', 'number', 'pricing'),
  ('PRICE_PREMIUM_LOW', 'Price premium: low',
   'A country earning at or below this multiple of the world median price is selling at a discount.',
   '0.85', '0.85', 'number', 'pricing'),
  ('PRICING_MIN_VALUE_USD', 'Minimum value to be priced',
   'A trade smaller than this gets no price comparison and is left out of the world median. A country shipping a hundred thousand dollars of gold can report a weight that implies any price at all, and one such row would drag the median for everybody.',
   '1000000', '1000000', 'usd', 'pricing'),
  ('PRICING_MAX_DEVIATION', 'Implausible price multiple',
   'A price this many times above or below the world median for the same product line is a reporting error in the weight, not a discount or a premium. Twelve tonnes of gold cannot sell for twenty thousand dollars. Those weights are dropped rather than shown.',
   '10', '10', 'number', 'pricing');
