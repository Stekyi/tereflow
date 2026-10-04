DECLARE
  l_primary  VARCHAR2(80)  := TRIM(:primary);
  l_partners VARCHAR2(400) := UPPER(REPLACE(:partners, ' ', ''));
  l_p_iso    VARCHAR2(3);
  l_p_name   VARCHAR2(120);
  l_p_slug   VARCHAR2(80);
  l_n        PLS_INTEGER;
  l_bad      VARCHAR2(400);
  l_last     PLS_INTEGER := EXTRACT(YEAR FROM SYSDATE) - 1;
  l_y0       PLS_INTEGER := EXTRACT(YEAR FROM SYSDATE) - 5;
  l_out      CLOB;
  l_pos      PLS_INTEGER := 1;
  l_len      PLS_INTEGER;

  PROCEDURE fail(p_status PLS_INTEGER, p_msg VARCHAR2) IS
  BEGIN
    :status_code := p_status;
    owa_util.mime_header('application/json', TRUE, 'utf-8');
    htp.prn('{"error":"' || REPLACE(p_msg, '"', '''') || '"}');
  END;
BEGIN
  IF l_primary IS NULL THEN fail(400, 'primary country is required'); RETURN; END IF;

  SELECT COUNT(*) INTO l_n FROM (
    SELECT DISTINCT TRIM(REGEXP_SUBSTR(l_partners, '[^,]+', 1, LEVEL)) p
    FROM dual CONNECT BY LEVEL <= REGEXP_COUNT(l_partners, '[^,]+')) WHERE p IS NOT NULL;
  IF l_n = 0 THEN fail(400, 'select at least one partner country'); RETURN; END IF;

  SELECT LISTAGG(p, ', ') WITHIN GROUP (ORDER BY p) INTO l_bad FROM (
    SELECT DISTINCT TRIM(REGEXP_SUBSTR(l_partners, '[^,]+', 1, LEVEL)) p
    FROM dual CONNECT BY LEVEL <= REGEXP_COUNT(l_partners, '[^,]+'))
  WHERE p IS NOT NULL AND p NOT IN (SELECT iso3 FROM tf_iso3);
  IF l_bad IS NOT NULL THEN fail(400, 'Unknown partner ISO3: ' || l_bad); RETURN; END IF;

  BEGIN
    SELECT iso3, name, slug INTO l_p_iso, l_p_name, l_p_slug
    FROM tf_country WHERE is_active = 1 AND (LOWER(slug) = LOWER(l_primary) OR iso3 = UPPER(l_primary));
  EXCEPTION WHEN NO_DATA_FOUND THEN
    fail(400, 'Primary country is not an active country with an ISO3 code'); RETURN;
  END;

  SELECT COUNT(*) INTO l_n FROM (
    SELECT DISTINCT TRIM(REGEXP_SUBSTR(l_partners, '[^,]+', 1, LEVEL)) p
    FROM dual CONNECT BY LEVEL <= REGEXP_COUNT(l_partners, '[^,]+')) WHERE p = l_p_iso;
  IF l_n > 0 THEN fail(400, 'primary country cannot also be a partner'); RETURN; END IF;

  WITH plist AS (
    SELECT p, first_pos AS ord FROM (
      SELECT p, MIN(pos) AS first_pos FROM (
        SELECT TRIM(REGEXP_SUBSTR(l_partners, '[^,]+', 1, LEVEL)) p, LEVEL pos
        FROM dual CONNECT BY LEVEL <= REGEXP_COUNT(l_partners, '[^,]+'))
      WHERE p IS NOT NULL GROUP BY p ORDER BY first_pos)
    WHERE ROWNUM <= 12
  ),
  yrs AS (SELECT l_y0 + LEVEL - 1 AS yr FROM dual CONNECT BY LEVEL <= 5),
  pdata AS (
    SELECT pl.ord, pl.p, i.name,
      (SELECT 'HS' || MAX(TO_NUMBER(SUBSTR(f.classification_level, 3)))
         FROM tf_trade_facts f
        WHERE f.reporter_iso3 = l_p_iso AND f.partner_iso3 = pl.p AND f.year BETWEEN l_y0 AND l_last
          AND REGEXP_LIKE(f.classification_level, '^HS[0-9]+$')) AS cls,
      CASE WHEN EXISTS (SELECT 1 FROM tf_trade_facts f
                         WHERE f.reporter_iso3 = l_p_iso AND f.partner_iso3 = pl.p AND f.year BETWEEN l_y0 AND l_last)
           THEN 'primary' ELSE 'none' END AS basis,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                'year' VALUE y.yr,
                'export_usd' VALUE (SELECT SUM(f.value_usd) FROM tf_trade_facts f
                   WHERE f.reporter_iso3 = l_p_iso AND f.partner_iso3 = pl.p AND f.year = y.yr AND f.flow = 'X'),
                'import_usd' VALUE (SELECT SUM(f.value_usd) FROM tf_trade_facts f
                   WHERE f.reporter_iso3 = l_p_iso AND f.partner_iso3 = pl.p AND f.year = y.yr AND f.flow = 'M'))
              ORDER BY y.yr RETURNING CLOB)
         FROM yrs y) AS totals_json,
      COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT(
                'hs_code' VALUE f.cmd_code,
                'product_name' VALUE NVL(f.cmd_desc, f.cmd_code),
                'flow' VALUE DECODE(f.flow, 'X', 'export', 'import'),
                'year' VALUE f.year,
                'value_usd' VALUE f.value_usd,
                'qty_kg' VALUE f.net_weight_kg,
                'classification_level' VALUE f.classification_level,
                'reporter' VALUE l_p_iso,
                'partner_iso3' VALUE pl.p)
              ORDER BY f.year, f.flow, f.cmd_code RETURNING CLOB)
         FROM tf_trade_facts f
        WHERE f.reporter_iso3 = l_p_iso AND f.partner_iso3 = pl.p AND f.year BETWEEN l_y0 AND l_last
          AND f.value_usd IS NOT NULL), TO_CLOB('[]')) AS products_json,
      (SELECT COUNT(*) FROM tf_trade_facts f
        WHERE f.reporter_iso3 = l_p_iso AND f.partner_iso3 = pl.p AND f.year BETWEEN l_y0 AND l_last
          AND f.value_usd IS NULL) AS unreported
    FROM plist pl JOIN tf_iso3 i ON i.iso3 = pl.p
  )
  SELECT JSON_OBJECT(
    'primary' VALUE JSON_OBJECT('slug' VALUE NVL(l_p_slug, LOWER(l_p_iso)), 'name' VALUE NVL(l_p_name, l_p_iso), 'iso3' VALUE l_p_iso),
    'partners' VALUE COALESCE((
      SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'slug' VALUE LOWER(d.p),
        'name' VALUE d.name,
        'iso3' VALUE d.p,
        'classification_level' VALUE d.cls,
        'reporter_basis' VALUE d.basis,
        'years' VALUE (SELECT JSON_ARRAYAGG(yr ORDER BY yr) FROM yrs) FORMAT JSON,
        'totals' VALUE d.totals_json FORMAT JSON,
        'products' VALUE d.products_json FORMAT JSON,
        'unreported_rows' VALUE d.unreported
        RETURNING CLOB) ORDER BY d.ord RETURNING CLOB)
      FROM pdata d), TO_CLOB('[]')) FORMAT JSON,
    'years' VALUE (SELECT JSON_ARRAYAGG(yr ORDER BY yr) FROM yrs) FORMAT JSON,
    'primary_product_totals' VALUE COALESCE((
      SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'year' VALUE t.year,
        'flow' VALUE DECODE(t.flow, 'X', 'export', 'import'),
        'hs_code' VALUE t.hs_code,
        'value_usd' VALUE t.all_partner_value_usd) RETURNING CLOB)
      FROM v_sandbox_product_totals t
      WHERE t.reporter_iso3 = l_p_iso AND t.year BETWEEN l_y0 AND l_last AND t.all_partner_value_usd IS NOT NULL
        AND EXISTS (SELECT 1 FROM tf_trade_facts f JOIN plist pl ON pl.p = f.partner_iso3
                    WHERE f.reporter_iso3 = t.reporter_iso3 AND f.year = t.year AND f.flow = t.flow
                      AND f.cmd_code = t.hs_code)), TO_CLOB('[]')) FORMAT JSON,
    'note' VALUE 'All comparisons use the primary country''s stored partner-level trade facts from Oracle. Comparison countries do not need to be activated. No stored rows means no recorded transaction, and a value Comtrade did not report is not shown as zero. Each product total sums every partner for that product, year and flow. It is not the headline world row and not the sum of only the selected partners.'
    RETURNING CLOB)
  INTO l_out FROM dual;

  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;
