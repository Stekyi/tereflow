DECLARE
  l_iso  VARCHAR2(3) := UPPER(TRIM(:iso3));
  l_clob CLOB;
  l_pos  PLS_INTEGER := 1;
  l_len  PLS_INTEGER;
BEGIN
  SELECT payload INTO l_clob FROM tf_dashboard_cache WHERE reporter_iso3 = l_iso AND kind = 'products';
  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_clob);
  WHILE l_pos <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_clob, 8000, l_pos));
    l_pos := l_pos + 8000;
  END LOOP;
EXCEPTION WHEN NO_DATA_FOUND THEN
  :status_code := 404;
  owa_util.mime_header('application/json', TRUE, 'utf-8');
  htp.prn('{"error":"No stored data for ' || l_iso || '"}');
END;
