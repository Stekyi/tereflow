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
  -- Monthly data is stored at HS6, so a longer code is read at its 6-digit heading.
  l_code := SUBSTR(l_code, 1, 6);

  SELECT COUNT(*) INTO l_n FROM tf_trade_monthly
   WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code LIKE l_code || '%';
  IF l_n = 0 THEN fail(404, 'No monthly data for ' || l_iso || ' ' || l_flow || ' ' || l_code); RETURN; END IF;

  SELECT JSON_OBJECT(
    'reporter' VALUE l_iso,
    'flow' VALUE l_flow,
    'code' VALUE l_code,
    'source' VALUE (SELECT MAX(source) FROM tf_trade_monthly WHERE reporter_iso3 = l_iso AND flow = l_flow),
    'rows' VALUE (
      SELECT JSON_ARRAYAGG(JSON_OBJECT('year' VALUE year, 'month' VALUE month, 'value_usd' VALUE v, 'qty_kg' VALUE w)
                           ORDER BY year, month RETURNING CLOB)
        FROM (SELECT year, month, SUM(value_usd) v, SUM(CASE WHEN net_weight_kg > 0 THEN net_weight_kg END) w
                FROM tf_trade_monthly
               WHERE reporter_iso3 = l_iso AND flow = l_flow AND cmd_code LIKE l_code || '%'
               GROUP BY year, month)) FORMAT JSON
    RETURNING CLOB)
  INTO l_out FROM dual;

  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;
