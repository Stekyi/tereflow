DECLARE
  l_tokens VARCHAR2(1000) := REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(NVL(:tokens, '')), '[^a-z0-9,]', ''), ',+', ','), '^,|,$', '');
  l_codes  VARCHAR2(1000) := REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(NVL(:codes, ''), '[^0-9,]', ''), ',+', ','), '^,|,$', '');
  l_prefix VARCHAR2(12)   := REGEXP_REPLACE(NVL(:prefix, ''), '[^0-9]', '');
  l_flow   VARCHAR2(1)    := UPPER(SUBSTR(NVL(:flow, ''), 1, 1));
  l_iso    VARCHAR2(1000) := ',' || REGEXP_REPLACE(UPPER(NVL(:iso3s, '')), '[^A-Z,]', '') || ',';
  l_limit  PLS_INTEGER    := LEAST(GREATEST(NVL(TO_NUMBER(REGEXP_SUBSTR(NVL(:lim, ''), '^[0-9]+$')), 500), 1), 800);
  l_re     VARCHAR2(1200);
  l_out    CLOB;
  l_pos    PLS_INTEGER := 1;
  l_len    PLS_INTEGER;
BEGIN
  IF l_flow NOT IN ('X', 'M') THEN l_flow := NULL; END IF;
  l_re := '(^|[^a-z0-9])(' || REPLACE(l_tokens, ',', '|') || ')';
  SELECT JSON_OBJECT(
    'total' VALUE (SELECT COUNT(*) FROM tf_product_index p
                    WHERE (l_iso = ',,' OR INSTR(l_iso, ',' || p.reporter_iso3 || ',') > 0)
                      AND (l_flow IS NULL OR p.flow = l_flow)
                      AND ((l_tokens IS NULL AND l_codes IS NULL AND l_prefix IS NULL)
                           OR (l_tokens IS NOT NULL AND REGEXP_LIKE(p.name_lc, l_re))
                           OR (l_codes IS NOT NULL AND INSTR(',' || l_codes || ',', ',' || p.cmd_code || ',') > 0)
                           OR (l_prefix IS NOT NULL AND p.cmd_code LIKE l_prefix || '%'))),
    'products' VALUE (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                        'reporter' VALUE reporter_iso3, 'flow' VALUE flow, 'code' VALUE cmd_code, 'level' VALUE classification_level,
                        'name' VALUE product_name, 'year' VALUE latest_year, 'value_usd' VALUE value_usd, 'cagr_3y' VALUE cagr_3y,
                        'yoy_pct' VALUE yoy_pct, 'score' VALUE score, 'confidence' VALUE confidence, 'signal' VALUE signal,
                        'top_partner' VALUE top_partner, 'top_share_pct' VALUE top_share_pct, 'partner_count' VALUE partner_count,
                        'unit_value_usd_t' VALUE unit_value_usd_t, 'years_available' VALUE years_available, 'trend' VALUE trend)
                      ORDER BY score DESC, value_usd DESC RETURNING CLOB)
                      FROM (SELECT p.* FROM tf_product_index p
                             WHERE (l_iso = ',,' OR INSTR(l_iso, ',' || p.reporter_iso3 || ',') > 0)
                               AND (l_flow IS NULL OR p.flow = l_flow)
                               AND ((l_tokens IS NULL AND l_codes IS NULL AND l_prefix IS NULL)
                                    OR (l_tokens IS NOT NULL AND REGEXP_LIKE(p.name_lc, l_re))
                                    OR (l_codes IS NOT NULL AND INSTR(',' || l_codes || ',', ',' || p.cmd_code || ',') > 0)
                                    OR (l_prefix IS NOT NULL AND p.cmd_code LIKE l_prefix || '%'))
                             ORDER BY p.score DESC, p.value_usd DESC
                             FETCH FIRST l_limit ROWS ONLY))
    RETURNING CLOB) INTO l_out FROM dual;
  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;
