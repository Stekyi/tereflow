DECLARE
  l_out CLOB;
  l_pos PLS_INTEGER := 1;
  l_len PLS_INTEGER;
BEGIN
  SELECT NVL(JSON_ARRAYAGG(JSON_OBJECT('iso3' VALUE c.reporter_iso3, 'lines' VALUE c.lines, 'facts' VALUE NVL(s.facts, 0)) RETURNING CLOB), '[]')
    INTO l_out
    FROM (SELECT reporter_iso3, COUNT(*) lines FROM tf_product_index GROUP BY reporter_iso3) c
    LEFT JOIN (SELECT reporter_iso3, SUM(records) facts FROM tf_ingest_state WHERE status = 'SUCCESS' GROUP BY reporter_iso3) s
      ON s.reporter_iso3 = c.reporter_iso3;
  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_out);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_out, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
END;
