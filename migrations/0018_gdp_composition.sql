-- GDP composition, so "economic sector" has somewhere honest to live.
--
-- The World Bank publishes value added as a share of GDP for agriculture,
-- industry and services. Two of those are aggregates: "industry" covers mining,
-- manufacturing, construction and utilities, and "services" covers everything
-- from retail to finance. Neither maps onto a single row in
-- sector_definitions, so writing them there would claim a precision the source
-- does not have. Manufacturing is published separately and does map, so it
-- goes to sector_observations where it belongs.
--
-- These three are recorded as what they are: the top-level split of an economy,
-- which is what an investor is asking for when they ask what a country does.
INSERT OR IGNORE INTO indicator_definitions (code, name, category, unit, min_value, max_value, description, is_active)
VALUES
  ('GDP_AGRI_SHARE', 'Agriculture, value added', 'macro', 'percent', 0, 100,
   'Agriculture, forestry and fishing as a share of GDP.', 1),
  ('GDP_INDUSTRY_SHARE', 'Industry, value added', 'macro', 'percent', 0, 100,
   'Industry including mining, manufacturing, construction and utilities, as a share of GDP. An aggregate, not a single sector.', 1),
  ('GDP_SERVICES_SHARE', 'Services, value added', 'macro', 'percent', 0, 100,
   'Services as a share of GDP. An aggregate covering retail through to finance.', 1),
  ('GNI_PER_CAPITA', 'GNI per capita', 'macro', 'usd', 0, NULL,
   'Gross national income per head, Atlas method. Income of the economy per person, which is not the same as what a household earns.', 1);

-- A figure with no source is a figure nobody can check. The upload path set
-- these from the CSV; an automated fetch sets them from the endpoint it called.
CREATE INDEX IF NOT EXISTS idx_ind_source ON indicator_observations (entity_id, source_ref, year);
