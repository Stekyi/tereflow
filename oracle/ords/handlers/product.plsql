DECLARE
  l_iso  VARCHAR2(3)  := UPPER(TRIM(:iso3));
  l_flow VARCHAR2(1)  := CASE WHEN UPPER(:flow) IN ('X', 'EXPORT') THEN 'X' WHEN UPPER(:flow) IN ('M', 'IMPORT') THEN 'M' END;
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
  IF l_flow IS NULL THEN fail(400, 'flow must be X, M, export or import'); RETURN; END IF;
  IF l_code IS NULL OR LENGTH(l_code) < 2 THEN fail(400, 'code must be 2 to 10 digits'); RETURN; END IF;

  -- A code matches itself and every longer code beneath it, so a chapter or a 6-digit heading also
  -- answers for the HS8/HS10 lines of a country that reports at that depth.
  SELECT COUNT(*) INTO l_n FROM tf_trade_facts
   WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code LIKE l_code || '%' AND partner_iso3 <> 'WLD' AND value_usd IS NOT NULL;
  IF l_n = 0 THEN fail(404, 'No stored trade for ' || l_iso || ' ' || l_flow || ' ' || l_code); RETURN; END IF;

  SELECT JSON_OBJECT(
    'reporter' VALUE l_iso,
    'flow' VALUE l_flow,
    'code' VALUE l_code,
    'name' VALUE (SELECT MAX(cmd_desc) KEEP (DENSE_RANK LAST ORDER BY year, value_usd) FROM tf_trade_facts
                   WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code = l_code AND partner_iso3 <> 'WLD'),
    'level' VALUE (SELECT MAX(classification_level) KEEP (DENSE_RANK LAST ORDER BY year) FROM tf_trade_facts
                    WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code LIKE l_code || '%' AND partner_iso3 <> 'WLD'),
    'latest_year' VALUE (SELECT MAX(year) FROM tf_trade_facts
                          WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code LIKE l_code || '%' AND partner_iso3 <> 'WLD' AND value_usd IS NOT NULL),
    'series' VALUE (
      SELECT JSON_ARRAYAGG(JSON_OBJECT('year' VALUE year, 'value_usd' VALUE v, 'qty_kg' VALUE w) ORDER BY year)
      FROM (SELECT year, SUM(value_usd) v, SUM(CASE WHEN net_weight_kg > 0 THEN net_weight_kg END) w
              FROM tf_trade_facts
             WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code LIKE l_code || '%' AND partner_iso3 <> 'WLD' AND value_usd IS NOT NULL
             GROUP BY year)) FORMAT JSON,
    'partners' VALUE COALESCE((
      SELECT JSON_ARRAYAGG(JSON_OBJECT('iso3' VALUE partner_iso3, 'value_usd' VALUE v, 'qty_kg' VALUE w) ORDER BY v DESC RETURNING CLOB)
      FROM (SELECT partner_iso3, SUM(value_usd) v, SUM(CASE WHEN net_weight_kg > 0 THEN net_weight_kg END) w
              FROM tf_trade_facts
             WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code LIKE l_code || '%' AND partner_iso3 <> 'WLD' AND value_usd > 0
               AND year = (SELECT MAX(year) FROM tf_trade_facts
                            WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code LIKE l_code || '%' AND partner_iso3 <> 'WLD' AND value_usd IS NOT NULL)
             GROUP BY partner_iso3 ORDER BY v DESC FETCH FIRST 100 ROWS ONLY)), TO_CLOB('[]')) FORMAT JSON
    RETURNING CLOB)
  INTO l_out FROM dual;

  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;
