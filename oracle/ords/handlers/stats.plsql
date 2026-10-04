DECLARE
  l_out CLOB;
BEGIN
  SELECT JSON_OBJECT(
    'countries_with_data' VALUE (SELECT COUNT(DISTINCT reporter_iso3) FROM tf_ingest_state WHERE status = 'SUCCESS'),
    'facts' VALUE (SELECT NVL(SUM(records), 0) FROM tf_ingest_state WHERE status = 'SUCCESS'),
    'last_run' VALUE (SELECT TO_CHAR(MAX(finished_at), 'YYYY-MM-DD"T"HH24:MI:SS') FROM tf_ingest_run WHERE status IN ('SUCCESS', 'PARTIAL'))
    RETURNING CLOB)
  INTO l_out FROM dual;
  owa_util.mime_header('application/json', TRUE, 'utf-8');
  htp.prn(DBMS_LOB.SUBSTR(l_out, 4000, 1));
END;
