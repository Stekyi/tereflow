DECLARE
  l_iso  VARCHAR2(3)  := UPPER(TRIM(:iso3));
  l_code VARCHAR2(12) := REGEXP_REPLACE(:code, '[^0-9]', '');
  l_n    PLS_INTEGER;
  l_out  CLOB;
  l_pos  PLS_INTEGER := 1;
  l_len  PLS_INTEGER;

  PROCEDURE fail(p_status PLS_INTEGER, p_msg VARCHAR2) IS
  BEGIN
    :status_code := p_status;
    owa_util.mime_header('application/json', TRUE, 'utf-8');
    htp.prn('{"error":"' || REPLACE(p_msg, '"', '''') || '"}');
  END;
BEGIN
  IF l_code IS NULL OR LENGTH(l_code) < 4 THEN fail(400, 'code must be 4 to 10 digits'); RETURN; END IF;
  -- Tariffs are stored at HS6, so a longer code is read at its 6-digit heading.
  l_code := SUBSTR(l_code, 1, 6);

  -- Belgium, France and the Netherlands apply the EU tariff, which TRAINS reports as one reporter.
  IF l_iso IN ('BEL', 'FRA', 'NLD', 'DEU', 'ITA', 'ESP', 'IRL', 'AUT', 'SWE', 'DNK', 'FIN', 'POL', 'PRT', 'GRC', 'CZE', 'HUN', 'ROU', 'BGR', 'HRV', 'SVK', 'SVN', 'LTU', 'LVA', 'EST', 'LUX', 'MLT', 'CYP') THEN
    l_iso := 'EUN';
  END IF;

  SELECT COUNT(*) INTO l_n FROM tf_tariff WHERE reporter_iso3 = l_iso AND cmd_code = l_code;
  IF l_n = 0 THEN fail(404, 'No tariff held for ' || l_iso || ' ' || l_code); RETURN; END IF;

  SELECT JSON_OBJECT(
    'reporter' VALUE l_iso,
    'code' VALUE l_code,
    'rows' VALUE (
      SELECT JSON_ARRAYAGG(JSON_OBJECT(
               'year' VALUE year, 'tariff_type' VALUE tariff_type, 'hs_revision' VALUE hs_revision,
               'rate_pct' VALUE rate_pct, 'rate_measure' VALUE rate_measure, 'no_ad_valorem' VALUE no_ad_valorem,
               'total_lines' VALUE total_lines, 'pref_lines' VALUE pref_lines, 'mfn_lines' VALUE mfn_lines, 'na_lines' VALUE na_lines,
               'min_rate_pct' VALUE min_rate_pct, 'max_rate_pct' VALUE max_rate_pct,
               'partner_code' VALUE partner_code, 'source' VALUE source, 'source_url' VALUE source_url,
               'retrieved_at' VALUE TO_CHAR(retrieved_at, 'YYYY-MM-DD"T"HH24:MI:SS') RETURNING CLOB)
             ORDER BY year, tariff_type RETURNING CLOB)
        FROM tf_tariff WHERE reporter_iso3 = l_iso AND cmd_code = l_code) FORMAT JSON
    RETURNING CLOB)
  INTO l_out FROM dual;

  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;
