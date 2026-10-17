DECLARE
  -- The application's SQL gateway. The Worker sends parameterised statements for the app's own tables (every table whose
  -- name starts with APP_) and gets rows back as JSON. It is a data layer, not a general SQL console: it refuses anything
  -- else (other tables, DDL, comments, PL/SQL, system views).
  l_req     JSON_OBJECT_T;
  l_stmts   JSON_ARRAY_T;
  l_stmt    JSON_OBJECT_T;
  l_binds   JSON_ARRAY_T;
  l_el      JSON_ELEMENT_T;
  l_results JSON_ARRAY_T := JSON_ARRAY_T();
  l_res     JSON_OBJECT_T;
  l_rows    JSON_ARRAY_T;
  l_row     JSON_OBJECT_T;
  l_out     JSON_OBJECT_T := JSON_OBJECT_T();
  l_cur     INTEGER;
  l_ncols   INTEGER;
  l_desc    DBMS_SQL.DESC_TAB;
  l_sql     VARCHAR2(32767);
  l_lc      VARCHAR2(32767);
  l_ignore  BOOLEAN;
  l_n       INTEGER;
  l_num     NUMBER;
  l_str     VARCHAR2(32767);
  l_clob    CLOB;
  l_pos     PLS_INTEGER;
  l_tok     VARCHAR2(400);
  l_max_rows CONSTANT PLS_INTEGER := 5000;
  l_buf     CLOB;
  l_chunk   PLS_INTEGER := 1;
  l_len     PLS_INTEGER;

  PROCEDURE fail(p_status PLS_INTEGER, p_msg VARCHAR2) IS
  BEGIN
    :status_code := p_status;
    owa_util.mime_header('application/json', TRUE, 'utf-8');
    htp.prn(JSON_OBJECT('error' VALUE p_msg RETURNING VARCHAR2));
  END;

  -- Raises when the statement is not one the gateway will run.
  PROCEDURE check_sql(p_sql VARCHAR2) IS
    l_s VARCHAR2(32767) := LOWER(p_sql);
    l_i PLS_INTEGER := 1;
    l_t VARCHAR2(400);
  BEGIN
    IF INSTR(l_s, ';') > 0 OR INSTR(l_s, '--') > 0 OR INSTR(l_s, '/*') > 0 OR INSTR(l_s, '@') > 0 THEN
      RAISE_APPLICATION_ERROR(-20001, 'statement contains a forbidden character');
    END IF;
    IF NOT REGEXP_LIKE(l_s, '^\s*(select|insert|update|delete|merge|with)\s') THEN
      RAISE_APPLICATION_ERROR(-20002, 'only select, insert, update, delete and merge are allowed');
    END IF;
    IF REGEXP_LIKE(l_s, '(^|[^a-z0-9_])(dbms_[a-z_]*|utl_[a-z_]*|execute|immediate|drop|alter|create|grant|revoke|truncate|begin|declare|sys|v\$[a-z_]*|(dba|all|user)_(tables|tab_columns|objects|views|users|constraints|indexes|ind_columns|sequences|source|procedures|triggers|synonyms|catalog|tab_privs|role_privs|sys_privs|db_links|jobs|scheduler_jobs)|tf_[a-z0-9_]*)([^a-z0-9_]|$)') THEN
      RAISE_APPLICATION_ERROR(-20003, 'statement mentions something the gateway does not allow');
    END IF;
    -- Every table named after FROM, JOIN, INTO, UPDATE or USING must be an APP_ table (or DUAL).
    LOOP
      l_t := REGEXP_SUBSTR(l_s, '(^|[^a-z0-9_])(from|join|into|update|using)[[:space:]]+("?[a-z0-9_$.]+"?)', 1, l_i, 'i', 3);
      EXIT WHEN l_t IS NULL;
      l_t := REPLACE(l_t, '"', '');
      IF NOT (l_t = 'dual' OR l_t LIKE 'app\_%' ESCAPE '\') THEN
        RAISE_APPLICATION_ERROR(-20004, 'table not allowed: ' || l_t);
      END IF;
      l_i := l_i + 1;
    END LOOP;
  END;
BEGIN
  -- SQLite compares text case-insensitively in LIKE; match that so searches by name or email behave the same.
  EXECUTE IMMEDIATE 'ALTER SESSION SET NLS_COMP = LINGUISTIC';
  EXECUTE IMMEDIATE 'ALTER SESSION SET NLS_SORT = BINARY_CI';
  l_req   := JSON_OBJECT_T.parse(:body_text);
  l_stmts := l_req.get_array('stmts');
  IF l_stmts IS NULL OR l_stmts.get_size = 0 OR l_stmts.get_size > 200 THEN
    fail(400, 'stmts must hold 1 to 200 statements');
    RETURN;
  END IF;

  FOR s IN 0 .. l_stmts.get_size - 1 LOOP
    l_stmt   := TREAT(l_stmts.get(s) AS JSON_OBJECT_T);
    l_sql    := l_stmt.get_string('sql');
    l_binds  := l_stmt.get_array('binds');
    l_ignore := NVL(l_stmt.get_boolean('ignore_dup'), FALSE);
    check_sql(l_sql);

    l_cur := DBMS_SQL.OPEN_CURSOR;
    DBMS_SQL.PARSE(l_cur, l_sql, DBMS_SQL.NATIVE);
    IF l_binds IS NOT NULL THEN
      FOR b IN 0 .. l_binds.get_size - 1 LOOP
        l_el := l_binds.get(b);
        IF l_el.is_null THEN
          DBMS_SQL.BIND_VARIABLE(l_cur, ':b' || (b + 1), CAST(NULL AS VARCHAR2));
        ELSIF l_el.is_number THEN
          DBMS_SQL.BIND_VARIABLE(l_cur, ':b' || (b + 1), l_binds.get_number(b));
        ELSIF l_el.is_true THEN
          DBMS_SQL.BIND_VARIABLE(l_cur, ':b' || (b + 1), 1);
        ELSIF l_el.is_false THEN
          DBMS_SQL.BIND_VARIABLE(l_cur, ':b' || (b + 1), 0);
        ELSE
          l_str := l_binds.get_string(b);
          IF LENGTH(l_str) > 4000 THEN
            DBMS_SQL.BIND_VARIABLE(l_cur, ':b' || (b + 1), TO_CLOB(l_str));
          ELSE
            DBMS_SQL.BIND_VARIABLE(l_cur, ':b' || (b + 1), l_str);
          END IF;
        END IF;
      END LOOP;
    END IF;

    l_res := JSON_OBJECT_T();
    l_lc  := LOWER(l_sql);
    IF REGEXP_LIKE(l_lc, '^\s*(select|with)\s') THEN
      DBMS_SQL.DESCRIBE_COLUMNS(l_cur, l_ncols, l_desc);
      FOR i IN 1 .. l_ncols LOOP
        IF l_desc(i).col_type = 2 THEN
          DBMS_SQL.DEFINE_COLUMN(l_cur, i, l_num);
        ELSIF l_desc(i).col_type = 112 THEN
          DBMS_SQL.DEFINE_COLUMN(l_cur, i, l_clob);
        ELSE
          DBMS_SQL.DEFINE_COLUMN(l_cur, i, l_str, 32767);
        END IF;
      END LOOP;
      l_n := DBMS_SQL.EXECUTE(l_cur);
      l_rows := JSON_ARRAY_T();
      WHILE DBMS_SQL.FETCH_ROWS(l_cur) > 0 AND l_rows.get_size < l_max_rows LOOP
        l_row := JSON_OBJECT_T();
        FOR i IN 1 .. l_ncols LOOP
          IF l_desc(i).col_type = 2 THEN
            DBMS_SQL.COLUMN_VALUE(l_cur, i, l_num);
            IF l_num IS NULL THEN l_row.put_null(LOWER(l_desc(i).col_name)); ELSE l_row.put(LOWER(l_desc(i).col_name), l_num); END IF;
          ELSIF l_desc(i).col_type = 112 THEN
            DBMS_SQL.COLUMN_VALUE(l_cur, i, l_clob);
            IF l_clob IS NULL THEN l_row.put_null(LOWER(l_desc(i).col_name)); ELSE l_row.put(LOWER(l_desc(i).col_name), DBMS_LOB.SUBSTR(l_clob, 32000, 1)); END IF;
          ELSE
            DBMS_SQL.COLUMN_VALUE(l_cur, i, l_str);
            IF l_str IS NULL THEN l_row.put_null(LOWER(l_desc(i).col_name)); ELSE l_row.put(LOWER(l_desc(i).col_name), l_str); END IF;
          END IF;
        END LOOP;
        l_rows.append(l_row);
      END LOOP;
      l_res.put('rows', l_rows);
      l_res.put('changes', 0);
    ELSE
      BEGIN
        l_n := DBMS_SQL.EXECUTE(l_cur);
      EXCEPTION WHEN DUP_VAL_ON_INDEX THEN
        IF l_ignore THEN l_n := 0; ELSE RAISE; END IF;
      END;
      l_res.put('rows', JSON_ARRAY_T());
      l_res.put('changes', l_n);
    END IF;
    DBMS_SQL.CLOSE_CURSOR(l_cur);
    l_results.append(l_res);
  END LOOP;

  COMMIT;
  l_out.put('results', l_results);
  l_buf := l_out.to_clob;
  owa_util.mime_header('application/json', TRUE, 'utf-8');
  l_len := DBMS_LOB.GETLENGTH(l_buf);
  WHILE l_chunk <= l_len LOOP
    htp.prn(DBMS_LOB.SUBSTR(l_buf, 8000, l_chunk));
    l_chunk := l_chunk + 8000;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  ROLLBACK;
  IF DBMS_SQL.IS_OPEN(l_cur) THEN DBMS_SQL.CLOSE_CURSOR(l_cur); END IF;
  fail(400, SQLCODE || ': ' || SUBSTR(SQLERRM, 1, 400));
END;
