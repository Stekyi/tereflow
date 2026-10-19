DECLARE
  l_tokens VARCHAR2(1000) := REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(NVL(:tokens, '')), '[^a-z0-9,]', ''), ',+', ','), '^,|,$', '');
  l_codes  VARCHAR2(1000) := REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(NVL(:codes, ''), '[^0-9,]', ''), ',+', ','), '^,|,$', '');
  l_prefix VARCHAR2(12)   := REGEXP_REPLACE(NVL(:prefix, ''), '[^0-9]', '');
  l_flow   VARCHAR2(1)    := UPPER(SUBSTR(NVL(:flow, ''), 1, 1));
  l_iso    VARCHAR2(1000) := ',' || REGEXP_REPLACE(UPPER(NVL(:iso3s, '')), '[^A-Z,]', '') || ',';
  l_limit  PLS_INTEGER    := LEAST(GREATEST(NVL(TO_NUMBER(REGEXP_SUBSTR(NVL(:lim, ''), '^[0-9]+$')), 500), 1), 800);
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
  IF l_flow NOT IN ('X', 'M') THEN l_flow := NULL; END IF;

  WITH m AS (
    SELECT p.* FROM tf_product_index p
     WHERE (l_iso = ',,' OR INSTR(l_iso, ',' || p.reporter_iso3 || ',') > 0)
       AND (l_flow IS NULL OR p.flow = l_flow)
       AND ((l_tokens IS NULL AND l_codes IS NULL AND l_prefix IS NULL)
            OR (l_tokens IS NOT NULL AND ((l_t1 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t1) > 0)
                    OR (l_t2 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t2) > 0)
                    OR (l_t3 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t3) > 0)
                    OR (l_t4 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t4) > 0)
                    OR (l_t5 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t5) > 0)
                    OR (l_t6 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t6) > 0)
                    OR (l_t7 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t7) > 0)
                    OR (l_t8 IS NOT NULL AND INSTR(p.name_norm, ' ' || l_t8) > 0)))
            OR (l_codes IS NOT NULL AND INSTR(',' || l_codes || ',', ',' || p.cmd_code || ',') > 0)
            OR (l_prefix IS NOT NULL AND p.cmd_code LIKE l_prefix || '%'))
  )
  SELECT JSON_OBJECT(
    'total'   VALUE (SELECT COUNT(*) FROM m),
    'exports' VALUE (SELECT COUNT(*) FROM m WHERE flow = 'X'),
    'imports' VALUE (SELECT COUNT(*) FROM m WHERE flow = 'M'),
    'markets' VALUE (SELECT COUNT(DISTINCT reporter_iso3) FROM m),
    'products' VALUE (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                        'reporter' VALUE reporter_iso3, 'flow' VALUE flow, 'code' VALUE cmd_code, 'level' VALUE classification_level,
                        'name' VALUE product_name, 'year' VALUE latest_year, 'value_usd' VALUE value_usd, 'cagr_3y' VALUE cagr_3y,
                        'yoy_pct' VALUE yoy_pct, 'score' VALUE score, 'confidence' VALUE confidence, 'signal' VALUE signal,
                        'top_partner' VALUE top_partner, 'top_share_pct' VALUE top_share_pct, 'partner_count' VALUE partner_count,
                        'unit_value_usd_t' VALUE unit_value_usd_t, 'years_available' VALUE years_available, 'trend' VALUE trend)
                      ORDER BY score DESC, value_usd DESC RETURNING CLOB)
                      FROM (SELECT * FROM m ORDER BY score DESC, value_usd DESC FETCH FIRST l_limit ROWS ONLY))
    RETURNING CLOB) INTO l_out FROM dual;  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;