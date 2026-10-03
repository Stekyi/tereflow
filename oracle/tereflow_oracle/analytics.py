"""Deterministic product metrics, rebuilt from tf_trade_facts after ingestion."""
from __future__ import annotations

REFRESH_SQL = """
INSERT INTO tf_product_metrics (reporter_iso3, flow, cmd_code, classification_level, cmd_desc, latest_year,
  years_available, latest_value_usd, prior_value_usd, yoy_pct, cagr_3y_pct, partner_count,
  top_partner_iso3, top_partner_share_pct, supplier_hhi)
WITH tot AS (
  SELECT reporter_iso3, flow, hs_code AS cmd_code, classification_level, year, all_partner_value_usd AS v
  FROM v_sandbox_product_totals WHERE reporter_iso3 = :rep AND all_partner_value_usd IS NOT NULL
),
yrs AS (
  SELECT t.*, MAX(year) OVER (PARTITION BY reporter_iso3, flow, cmd_code, classification_level) AS ly,
         COUNT(*) OVER (PARTITION BY reporter_iso3, flow, cmd_code, classification_level) AS n
  FROM tot t
),
agg AS (
  SELECT reporter_iso3, flow, cmd_code, classification_level, ly AS latest_year, n AS years_available,
    MAX(CASE WHEN year = ly     THEN v END) AS latest_v,
    MAX(CASE WHEN year = ly - 1 THEN v END) AS prior_v,
    MAX(CASE WHEN year = ly - 3 THEN v END) AS v3
  FROM yrs GROUP BY reporter_iso3, flow, cmd_code, classification_level, ly, n
),
part AS (
  SELECT f.reporter_iso3, f.flow, f.cmd_code, f.year,
         COUNT(CASE WHEN f.value_usd > 0 THEN 1 END) AS partner_count,
         SUM(f.value_usd) AS total,
         MAX(f.value_usd) AS top_v,
         SUM(f.value_usd * f.value_usd) AS sq,
         MAX(f.partner_iso3) KEEP (DENSE_RANK LAST ORDER BY f.value_usd) AS top_partner
  FROM tf_trade_facts f WHERE f.reporter_iso3 = :rep AND f.partner_iso3 <> 'WLD' GROUP BY f.reporter_iso3, f.flow, f.cmd_code, f.year
)
SELECT a.reporter_iso3, a.flow, a.cmd_code, a.classification_level,
  (SELECT MAX(cmd_desc) FROM tf_trade_facts d WHERE d.reporter_iso3 = a.reporter_iso3 AND d.cmd_code = a.cmd_code
     AND d.year = a.latest_year AND d.flow = a.flow AND d.partner_iso3 <> 'WLD'),
  a.latest_year, a.years_available, a.latest_v, a.prior_v,
  CASE WHEN a.prior_v > 0 AND a.latest_v IS NOT NULL THEN ROUND(100 * (a.latest_v / a.prior_v - 1), 4) END,
  CASE WHEN a.v3 > 0 AND a.latest_v IS NOT NULL THEN ROUND(100 * (POWER(a.latest_v / a.v3, 1/3) - 1), 4) END,
  p.partner_count, p.top_partner,
  CASE WHEN p.total > 0 THEN ROUND(100 * p.top_v / p.total, 4) END,
  CASE WHEN p.total > 0 THEN ROUND(p.sq / (p.total * p.total), 6) END
FROM agg a LEFT JOIN part p ON p.reporter_iso3 = a.reporter_iso3 AND p.flow = a.flow
  AND p.cmd_code = a.cmd_code AND p.year = a.latest_year
"""


def refresh_metrics(conn, reporter: str) -> int:
    """Replace one reporter's metrics in a single transaction."""
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM tf_product_metrics WHERE reporter_iso3 = :1", [reporter])
        cur.execute(REFRESH_SQL, {"rep": reporter})
        n = cur.rowcount
        conn.commit()
        return n
    except Exception:
        conn.rollback()
        raise
