-- Premium prices as owner settings instead of values in the code. Dollars, not cents. An unreadable or zero price falls
-- back to the shipped one (12 and 110), so a mistake in the portal cannot make premium free.
INSERT OR IGNORE INTO code_setup (code, name, description, value, default_value, kind, category) VALUES
  ('PRICE_MONTHLY_USD', 'Premium monthly price (US dollars)', 'What the monthly plan costs, in whole or decimal US dollars, for example 12 or 14.99. It applies to new payments at once.', '12', '12', 'usd', 'payments'),
  ('PRICE_ANNUAL_USD', 'Premium annual price (US dollars)', 'What the annual plan costs, in whole or decimal US dollars, for example 110. It applies to new payments at once.', '110', '110', 'usd', 'payments');
