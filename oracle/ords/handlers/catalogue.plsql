DECLARE
  l_tokens VARCHAR2(1000) := REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(NVL(:tokens, '')), '[^a-z0-9,]', ''), ',+', ','), '^,|,$', '');
  l_codes  VARCHAR2(1000) := REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(NVL(:codes, ''), '[^0-9,]', ''), ',+', ','), '^,|,$', '');
  l_limit  PLS_INTEGER    := LEAST(GREATEST(NVL(TO_NUMBER(REGEXP_SUBSTR(NVL(:lim, ''), '^[0-9]+$')), 400), 1), 1500);
  l_re     VARCHAR2(1200);
  l_out    CLOB;
  l_pos    PLS_INTEGER := 1;
  l_len    PLS_INTEGER;
BEGIN
  l_re := '(^|[^a-z0-9])(' || REPLACE(l_tokens, ',', '|') || ')';
  SELECT JSON_ARRAYAGG(JSON_OBJECT('hs_code' VALUE code6, 'product_name' VALUE nm, 'total_value' VALUE tv) ORDER BY tv DESC RETURNING CLOB)
    INTO l_out
    FROM (SELECT code6, nm, tv FROM (
            SELECT SUBSTR(p.cmd_code, 1, 6) code6,
                   MAX(CASE WHEN LENGTH(p.cmd_code) = 6 THEN p.product_name END) KEEP (DENSE_RANK LAST ORDER BY CASE WHEN LENGTH(p.cmd_code) = 6 THEN p.value_usd END NULLS FIRST) nm,
                   SUM(p.value_usd) tv
              FROM tf_product_index p
              JOIN (SELECT reporter_iso3, MAX(latest_year) ly FROM tf_product_index GROUP BY reporter_iso3) l
                ON l.reporter_iso3 = p.reporter_iso3 AND p.latest_year = l.ly
             WHERE (l_tokens IS NULL AND l_codes IS NULL)
                OR (l_tokens IS NOT NULL AND REGEXP_LIKE(p.name_lc, l_re))
                OR (l_codes IS NOT NULL AND INSTR(',' || l_codes || ',', ',' || SUBSTR(p.cmd_code, 1, 6) || ',') > 0)
             GROUP BY SUBSTR(p.cmd_code, 1, 6))
           ORDER BY tv DESC FETCH FIRST l_limit ROWS ONLY);
  owa_util.mime_header('application/json', TRUE, 'utf-8');
  IF l_out IS NULL THEN
    htp.prn('[]');
    RETURN;
  END IF;
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;
