-- Backfill ISO 3166-1 alpha-2 codes.
--
-- Every country row carried an alpha-3 code and none carried alpha-2, while the
-- analysis pipeline keys its output on alpha-2 (Ghana is stored as "GH"). Any
-- feature joining an entity to its analysis therefore matched nothing, silently,
-- for all ninety countries. The blue ocean gate was the first to need it and so
-- the first to surface it.
--
-- Written out per country rather than derived, because alpha-3 to alpha-2 is not
-- a transformation: ZAF is ZA, CHE is CH, DEU is DE. Anything that looked like a
-- rule here would be a guess that happened to work for the easy cases.
--
-- Taiwan is listed as TW/TWN per ISO 3166-1, which is the standard the rest of
-- this table follows.
UPDATE entities SET iso2 = CASE iso3
  WHEN 'AGO' THEN 'AO' WHEN 'ARE' THEN 'AE' WHEN 'ARG' THEN 'AR' WHEN 'AUS' THEN 'AU'
  WHEN 'AUT' THEN 'AT' WHEN 'BEL' THEN 'BE' WHEN 'BGD' THEN 'BD' WHEN 'BHS' THEN 'BS'
  WHEN 'BOL' THEN 'BO' WHEN 'BRA' THEN 'BR' WHEN 'BRB' THEN 'BB' WHEN 'CAN' THEN 'CA'
  WHEN 'CHE' THEN 'CH' WHEN 'CHL' THEN 'CL' WHEN 'CHN' THEN 'CN' WHEN 'CIV' THEN 'CI'
  WHEN 'CMR' THEN 'CM' WHEN 'COD' THEN 'CD' WHEN 'COL' THEN 'CO' WHEN 'CRI' THEN 'CR'
  WHEN 'CUB' THEN 'CU' WHEN 'DEU' THEN 'DE' WHEN 'DNK' THEN 'DK' WHEN 'DOM' THEN 'DO'
  WHEN 'DZA' THEN 'DZ' WHEN 'ECU' THEN 'EC' WHEN 'EGY' THEN 'EG' WHEN 'ESP' THEN 'ES'
  WHEN 'ETH' THEN 'ET' WHEN 'FJI' THEN 'FJ' WHEN 'FRA' THEN 'FR' WHEN 'FSM' THEN 'FM'
  WHEN 'GBR' THEN 'GB' WHEN 'GHA' THEN 'GH' WHEN 'GTM' THEN 'GT' WHEN 'GUY' THEN 'GY'
  WHEN 'HND' THEN 'HN' WHEN 'HTI' THEN 'HT' WHEN 'IDN' THEN 'ID' WHEN 'IND' THEN 'IN'
  WHEN 'IRL' THEN 'IE' WHEN 'ISR' THEN 'IL' WHEN 'ITA' THEN 'IT' WHEN 'JAM' THEN 'JM'
  WHEN 'JPN' THEN 'JP' WHEN 'KEN' THEN 'KE' WHEN 'KIR' THEN 'KI' WHEN 'KOR' THEN 'KR'
  WHEN 'LBY' THEN 'LY' WHEN 'MAR' THEN 'MA' WHEN 'MEX' THEN 'MX' WHEN 'MHL' THEN 'MH'
  WHEN 'MYS' THEN 'MY' WHEN 'NCL' THEN 'NC' WHEN 'NGA' THEN 'NG' WHEN 'NIC' THEN 'NI'
  WHEN 'NLD' THEN 'NL' WHEN 'NOR' THEN 'NO' WHEN 'NZL' THEN 'NZ' WHEN 'PAN' THEN 'PA'
  WHEN 'PER' THEN 'PE' WHEN 'PHL' THEN 'PH' WHEN 'PLW' THEN 'PW' WHEN 'PNG' THEN 'PG'
  WHEN 'POL' THEN 'PL' WHEN 'PRY' THEN 'PY' WHEN 'PYF' THEN 'PF' WHEN 'SAU' THEN 'SA'
  WHEN 'SEN' THEN 'SN' WHEN 'SGP' THEN 'SG' WHEN 'SLB' THEN 'SB' WHEN 'SLV' THEN 'SV'
  WHEN 'SUR' THEN 'SR' WHEN 'SWE' THEN 'SE' WHEN 'THA' THEN 'TH' WHEN 'TON' THEN 'TO'
  WHEN 'TTO' THEN 'TT' WHEN 'TUN' THEN 'TN' WHEN 'TUR' THEN 'TR' WHEN 'TWN' THEN 'TW'
  WHEN 'TZA' THEN 'TZ' WHEN 'UGA' THEN 'UG' WHEN 'URY' THEN 'UY' WHEN 'USA' THEN 'US'
  WHEN 'VEN' THEN 'VE' WHEN 'VNM' THEN 'VN' WHEN 'VUT' THEN 'VU' WHEN 'WSM' THEN 'WS'
  WHEN 'ZAF' THEN 'ZA' WHEN 'ZMB' THEN 'ZM'
  -- No guess for anything unlisted. A wrong alpha-2 would join an entity to
  -- another country's analysis, which is worse than joining to nothing.
  ELSE iso2
END
WHERE kind = 'country' AND iso3 IS NOT NULL AND (iso2 IS NULL OR iso2 = '');
