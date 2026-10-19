DECLARE
  l_tokens VARCHAR2(1000) := REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(NVL(:tokens, '')), '[^a-z0-9,]', ''), ',+', ','), '^,|,$', '');
  l_codes  VARCHAR2(1000) := REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(NVL(:codes, ''), '[^0-9,]', ''), ',+', ','), '^,|,$', '');
  l_limit  PLS_INTEGER    := LEAST(GREATEST(NVL(TO_NUMBER(REGEXP_SUBSTR(NVL(:lim, ''), '^[0-9]+$')), 400), 1), 1500);
  l_t1 VARCHAR2(60) := REGEXP_SUBSTR(l_tokens, '[^,]+', 1, 1);
  l_t2 VARCHAR2(60) := REGEXP_SUBSTR(l_tokens, '[^,]+', 1, 2);
  l_t3 VARCHAR2(60) := REGEXP_SUBSTR(l_tokens, '[^,]+', 1, 3);
  l_t4 VARCHAR2(60) := REGEXP_SUBSTR(l_tokens, '[^,]+', 1, 4);
  l_t5 VARCHAR2(60) := REGEXP_SUBSTR(l_tokens, '[^,]+', 1, 5);
  l_t6 VARCHAR2(60) := REGEXP_SUBSTR(l_tokens, '[^,]+', 1, 6);
  l_t7 VARCHAR2(60) := REGEXP_SUBSTR(l_tokens, '[^,]+', 1, 7);
  l_t8 VARCHAR2(60) := REGEXP_SUBSTR(l_tokens, '[^,]+', 1, 8);
  l_out    CLOB;
  l_pos    PLS_INTEGER := 1;
  l_len    PLS_INTEGER;
BEGIN

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
                OR (l_tokens IS NOT NULL AND ((l_t1 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t1) > 0)
                    OR (l_t2 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t2) > 0)
                    OR (l_t3 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t3) > 0)
                    OR (l_t4 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t4) > 0)
                    OR (l_t5 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t5) > 0)
                    OR (l_t6 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t6) > 0)
                    OR (l_t7 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t7) > 0)
                    OR (l_t8 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t8) > 0)))
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