DECLARE
  l_p    VARCHAR2(6) := REGEXP_REPLACE(NVL(:prefix, ''), '[^0-9]', '');
  l_out  CLOB;
  l_pos  PLS_INTEGER := 1;
  l_len  PLS_INTEGER;
BEGIN
  IF l_p IS NULL OR LENGTH(l_p) < 2 THEN
    :status_code := 400;
    owa_util.mime_header('application/json', TRUE, 'utf-8');
    htp.prn('{"error":"prefix must be 2 to 6 digits"}');
    RETURN;
  END IF;
  SELECT JSON_OBJECT(
    'latest' VALUE (SELECT JSON_OBJECTAGG(reporter_iso3 VALUE m) FROM (SELECT reporter_iso3, MAX(latest_year) m FROM tf_product_index GROUP BY reporter_iso3)),
    'totals' VALUE (SELECT JSON_OBJECTAGG(reporter_iso3 VALUE JSON_OBJECT(
                      'export_usd' VALUE JSON_VALUE(payload, '$.overview.export_usd' RETURNING NUMBER),
                      'import_usd' VALUE JSON_VALUE(payload, '$.overview.import_usd' RETURNING NUMBER)))
                    FROM tf_dashboard_cache WHERE kind = 'dashboard'),
    'products' VALUE (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                        'reporter' VALUE reporter_iso3, 'flow' VALUE flow, 'code' VALUE cmd_code, 'level' VALUE classification_level,
                        'name' VALUE product_name, 'year' VALUE latest_year, 'value_usd' VALUE value_usd, 'cagr_3y' VALUE cagr_3y,
                        'yoy_pct' VALUE yoy_pct, 'score' VALUE score, 'confidence' VALUE confidence, 'signal' VALUE signal,
                        'top_partner' VALUE top_partner, 'top_share_pct' VALUE top_share_pct, 'partner_count' VALUE partner_count,
                        'unit_value_usd_t' VALUE unit_value_usd_t, 'years_available' VALUE years_available, 'trend' VALUE trend)
                      RETURNING CLOB)
                      FROM (SELECT p.* FROM tf_product_index p WHERE p.cmd_code LIKE l_p || '%'
                             ORDER BY p.score DESC FETCH FIRST 2500 ROWS ONLY))
    RETURNING CLOB) INTO l_out FROM dual;
  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;
