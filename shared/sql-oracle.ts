/**
 * Translates the SQLite dialect the app was written in (Cloudflare D1) into Oracle SQL for the ORDS gateway.
 *
 * This is deliberately a small, explicit set of rewrites for the shapes the app really uses, not a general SQL converter.
 * Anything it does not understand is left alone or, where leaving it would silently change meaning, rejected with an error
 * so the query is rewritten by hand rather than run wrongly.
 *
 *   ?  and  ?N                     -> :bN (positional binds, N-th value)
 *   datetime('now')                -> UTC timestamp text, 'YYYY-MM-DD HH24:MI:SS'
 *   julianday(x)                   -> an Oracle DATE, so differences are in days
 *   IFNULL / json_extract          -> NVL / JSON_VALUE
 *   LIMIT n [OFFSET m]             -> [OFFSET m ROWS] FETCH FIRST n ROWS ONLY
 *   INSERT OR IGNORE               -> INSERT, with the gateway told to ignore a duplicate key
 *   INSERT ... ON CONFLICT         -> MERGE
 *   FROM t AS a                    -> FROM t a   (Oracle does not allow AS before a table alias)
 *   table names                    -> app_<table>
 *   columns that are Oracle words  -> renamed (trigger, raw, mode, share get a trailing underscore)
 */
export interface Translated {
  sql: string;
  binds: unknown[];
  ignoreDup: boolean;
}

/** Columns whose names are reserved words in Oracle. Renamed in the Oracle schema; mapped back on the way out. */
export const RENAMED_COLUMNS: Readonly<Record<string, string>> = {
  trigger: 'trigger_',
  raw: 'raw_',
  mode: 'mode_',
  share: 'share_',
  comment: 'comment_',
};
export const RENAMED_BACK: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RENAMED_COLUMNS).map(([k, v]) => [v, k]),
);

const NOW = "TO_CHAR(SYSTIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";
const NOW_DATE = "CAST(SYSTIMESTAMP AT TIME ZONE 'UTC' AS DATE)";

/** Applies `fn` only to the parts of the SQL that are not inside single-quoted string literals. */
function outsideStrings(sql: string, fn: (code: string) => string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      const lit = sql.slice(i, j + 1);
      out += lit === "''" ? 'CHR(1)' : lit;
      i = j + 1;
    } else {
      let j = i;
      while (j < sql.length && sql[j] !== "'") j += 1;
      out += fn(sql.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** Splits on commas that are not inside parentheses or quotes. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "'") q = !q;
    if (!q) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function dateFunctions(sql: string): string {
  return sql
    .replace(/datetime\(\s*'now'\s*\)/gi, NOW)
    .replace(/julianday\(\s*'now'\s*\)/gi, NOW_DATE)
    .replace(/julianday\(\s*([^()]+?)\s*\)/gi, "TO_DATE(SUBSTR($1, 1, 19), 'YYYY-MM-DD HH24:MI:SS')");
}

function upsertToMerge(sql: string, tables: ReadonlySet<string>): string {
  const m = /^INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*ON\s+CONFLICT\s*\(([^)]*)\)\s*DO\s+(NOTHING|UPDATE\s+SET\s+([\s\S]*))$/i.exec(sql);
  if (!m) return sql;
  const [, table, colList, valList, keyList, action, setList] = m;
  const cols = colList.split(',').map((c) => c.trim());
  const vals = splitTop(valList);
  if (cols.length !== vals.length) throw new Error('upsert: column and value counts differ');
  const keys = keyList.split(',').map((c) => c.trim());
  const on = keys.map((k) => `t.${k} = s.${k}`).join(' AND ');
  const src = cols.map((c, i) => `${vals[i]} AS ${c}`).join(', ');
  const insert = `INSERT (${cols.join(', ')}) VALUES (${cols.map((c) => `s.${c}`).join(', ')})`;
  let update = '';
  if (action.toUpperCase() !== 'NOTHING') {
    const sets = splitTop(setList).map((a) => {
      const eq = a.indexOf('=');
      const lhs = a.slice(0, eq).trim();
      const rhs = a.slice(eq + 1).trim().replace(/\bexcluded\.(\w+)/gi, 's.$1');
      // A bare column on the right (for example `bid_count + 1`) would be ambiguous in a MERGE, so it must be written by hand.
      const bare = rhs.replace(/'[^']*'/g, '').replace(/\bs\.\w+/g, '').replace(/:b\d+|\?\d*/g, '').match(/\b[a-z_][a-z0-9_]*\b(?!\s*\()/gi) ?? [];
      const allowed = new Set(['null', 'now', 'and', 'or', 'not', 'case', 'when', 'then', 'else', 'end']);
      const stray = bare.filter((w) => !allowed.has(w.toLowerCase()) && !/^(to_char|systimestamp|at|time|zone|utc|yyyy|mm|dd|hh24|mi|ss|cast|as|date)$/i.test(w));
      if (stray.length) throw new Error(`upsert: unsupported expression on the right of ${lhs}: ${rhs}`);
      return `t.${lhs} = ${rhs}`;
    });
    update = ` WHEN MATCHED THEN UPDATE SET ${sets.join(', ')}`;
  }
  void tables;
  return `MERGE INTO ${table} t USING (SELECT ${src} FROM dual) s ON (${on})${update} WHEN NOT MATCHED THEN ${insert}`;
}

export function toOracle(sqlIn: string, bindsIn: readonly unknown[], tables: ReadonlySet<string>, prefix = 'app_'): Translated {
  let sql = sqlIn.trim().replace(/;\s*$/, '');
  let ignoreDup = false;
  if (/^INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) {
    ignoreDup = true;
    sql = sql.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
  }
  if (/^INSERT\s+OR\s+REPLACE\b/i.test(sql)) throw new Error('INSERT OR REPLACE is not supported; write it as an upsert');

  sql = dateFunctions(sql);
  sql = sql.replace(/\bIFNULL\s*\(/gi, 'NVL(').replace(/\bjson_extract\s*\(/gi, 'JSON_VALUE(');
  // SQLite type names inside CAST.
  sql = sql.replace(/\bAS\s+TEXT\s*\)/gi, 'AS VARCHAR2(4000))').replace(/\bAS\s+(INTEGER|INT)\s*\)/gi, 'AS NUMBER(19))').replace(/\bAS\s+REAL\s*\)/gi, 'AS NUMBER)');

  // Binds: `?` takes the next value, `?N` takes the N-th. All become :bN against the original value list.
  let next = 0;
  let maxN = 0;
  const bindsUsed: number[] = [];
  sql = outsideStrings(sql, (code) => code.replace(/\?(\d+)?/g, (_m, n: string | undefined) => {
    const idx = n ? Number(n) : (next += 1);
    maxN = Math.max(maxN, idx);
    bindsUsed.push(idx);
    return `:b${idx}`;
  }));
  if (bindsIn.length < maxN) throw new Error(`statement needs ${maxN} binds, got ${bindsIn.length}`);

  sql = upsertToMerge(sql, tables);

  const names = [...tables].sort((a, b) => b.length - a.length).join('|');
  const tableRef = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)(\\s+)(${names})\\b`, 'gi');
  const renamed = new RegExp(`\\b(${Object.keys(RENAMED_COLUMNS).join('|')})\\b`, 'gi');
  sql = outsideStrings(sql, (code) => {
    let c = code.replace(tableRef, (_m, kw: string, sp: string, t: string) => `${kw}${sp}${prefix}${t.toLowerCase()}`);
    c = c.replace(new RegExp(`\\b(FROM|JOIN)(\\s+${prefix}\\w+)\\s+AS\\s+(\\w+)`, 'gi'), '$1$2 $3');
    // Oracle does not allow AS before a derived-table alias either: `) AS x JOIN ...`. A CAST type is left alone.
    c = c.replace(/\)\s+AS\s+(?!(?:INTEGER|INT|TEXT|REAL|NUMERIC|NUMBER|CHAR|VARCHAR2?|DATE|FLOAT)\b)(\w+)(?=\s*(?:\)|,|$|\bJOIN\b|\bLEFT\b|\bINNER\b|\bON\b|\bWHERE\b|\bGROUP\b|\bORDER\b|\bFETCH\b|\bUNION\b))/gi, ') $1');
    c = c.replace(renamed, (w: string) => RENAMED_COLUMNS[w.toLowerCase()]);
    c = c.replace(/\bLIMIT\s+(:b\d+|\d+)(?:\s+OFFSET\s+(:b\d+|\d+))?(?=\s*(?:\)|$))/gi, (_m, n: string, off?: string) =>
      `${off ? ` OFFSET ${off} ROWS` : ''} FETCH FIRST ${n} ROWS ONLY`);
    return c;
  });
  // Only the binds the statement really uses are sent, renumbered from 1 (SQLite allows ? and ?4 in one statement,
  // which leaves value 3 unused; Oracle refuses a bind that is not in the statement).
  const used = [...new Set(bindsUsed)].sort((a, b) => a - b);
  const renumber = new Map(used.map((old, i) => [old, i + 1]));
  sql = outsideStrings(sql, (code) => code.replace(/:b(\d+)/g, (_m, n: string) => `:b${renumber.get(Number(n))}`));
  const binds = used.map((old) => (bindsIn[old - 1] === undefined ? null : bindsIn[old - 1]));
  return { sql, binds, ignoreDup };
}
