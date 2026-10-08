"""Incremental, resumable, classification-aware Comtrade ingestion into Oracle."""
from __future__ import annotations
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import classify
from .classify import Availability, Selection
from .comtrade import Comtrade, RateLimited, ComtradeError, FetchResult
from . import national

ISO3_M49: dict[str, int] = json.loads((Path(__file__).parent / "data" / "iso3_m49.json").read_text())
M49_ISO3: dict[int, str] = {v: k for k, v in ISO3_M49.items()}
FLOWS = ("X", "M")
BATCH = 5000
AVAIL_TTL = timedelta(days=7)
MAX_RETRIES = 5


@dataclass
class Summary:
    run_id: str
    success: int = 0
    skipped: int = 0
    no_data: int = 0
    failed: int = 0
    rows: int = 0
    planned: list[str] = field(default_factory=list)
    stopped_on_rate_limit: bool = False

    @property
    def status(self) -> str:
        if self.stopped_on_rate_limit:
            return "RATE_LIMIT"
        if self.failed:
            return "PARTIAL" if self.success or self.skipped else "FAILED"
        return "SUCCESS"


class Ingestor:
    def __init__(self, conn, client: Comtrade | None, log=print, force=False, dry_run=False, providers=None):
        self.conn, self.api, self.log = conn, client, log
        self.force, self.dry = force, dry_run
        # Policy: a country's own statistics office is read first when it serves deeper codes.
        self.providers = national.registry() if providers is None else providers

    # ---- availability (cached, refreshed on a schedule) -------------------
    def availability(self, iso3: str, year: int) -> tuple[Availability | None, Availability | None]:
        cur = self.conn.cursor()
        cur.execute("""SELECT dataset, length_cmd_code, total_records, classification_code,
                              dataset_checksum, last_released, checked_at
                       FROM tf_comtrade_availability WHERE reporter_iso3=:1 AND year=:2""", [iso3, year])
        cached = {r[0]: r for r in cur}
        fresh = len(cached) == 2 and all(
            r[6] and datetime.now() - r[6] < AVAIL_TTL for r in cached.values())
        if fresh and not self.force:
            mk = lambda r: Availability(r[1], r[2], r[3], r[4], r[5]) if r[1] or r[2] else None
            return mk(cached["TARIFFLINE"]), mk(cached["FINAL"])
        m49 = ISO3_M49[iso3]
        tl = self.api.availability(m49, year, True)
        fn = self.api.availability(m49, year, False)
        if not self.dry:
            for ds, a in (("TARIFFLINE", tl), ("FINAL", fn)):
                cur.execute("""MERGE INTO tf_comtrade_availability t
                  USING (SELECT :r r, :y y, :d d FROM dual) s
                  ON (t.reporter_iso3=s.r AND t.year=s.y AND t.dataset=s.d)
                  WHEN MATCHED THEN UPDATE SET classification_code=:cc, length_cmd_code=:ln, total_records=:tr,
                       dataset_checksum=:ck, last_released=:lr, checked_at=SYSTIMESTAMP
                  WHEN NOT MATCHED THEN INSERT (reporter_iso3, year, dataset, classification_code,
                       length_cmd_code, total_records, dataset_checksum, last_released)
                       VALUES (:r, :y, :d, :cc, :ln, :tr, :ck, :lr)""",
                    dict(r=iso3, y=year, d=ds, cc=a and a.classification_code, ln=a and a.length_cmd_code,
                         tr=a and a.total_records, ck=a and a.dataset_checksum, lr=a and a.last_released))
            self.conn.commit()
        return tl, fn

    # ---- state ------------------------------------------------------------
    def _state(self, iso3, year, flow):
        cur = self.conn.cursor()
        cur.execute("""SELECT status, classification_level, dataset_checksum, last_released, retry_count
                       FROM tf_ingest_state WHERE reporter_iso3=:1 AND year=:2 AND flow=:3""", [iso3, year, flow])
        return cur.fetchone()

    def _set_state(self, run_id, iso3, year, flow, status, sel: Selection | None, records=0, error=None, retry=None):
        a = sel.availability if sel else None
        cur = self.conn.cursor()
        cur.execute("""MERGE INTO tf_ingest_state t
          USING (SELECT :r r, :y y, :f f FROM dual) s
          ON (t.reporter_iso3=s.r AND t.year=s.y AND t.flow=s.f)
          WHEN MATCHED THEN UPDATE SET status=:st, classification_level=:lv, classification_source=:src,
               records=:rec, dataset_checksum=:ck, last_released=:lr, run_id=:rid, error_message=:err,
               retry_count=NVL(:rt, retry_count), updated_at=SYSTIMESTAMP,
               started_at=CASE WHEN :st='RUNNING' THEN SYSTIMESTAMP ELSE started_at END,
               finished_at=CASE WHEN :st='RUNNING' THEN NULL ELSE SYSTIMESTAMP END
          WHEN NOT MATCHED THEN INSERT (reporter_iso3, year, flow, status, classification_level,
               classification_source, records, dataset_checksum, last_released, run_id, error_message,
               retry_count, started_at)
               VALUES (:r, :y, :f, :st, :lv, :src, :rec, :ck, :lr, :rid, :err, NVL(:rt, 0), SYSTIMESTAMP)""",
            dict(r=iso3, y=year, f=flow, st=status, lv=sel and sel.level, src=sel and sel.source, rec=records,
                 ck=a and a.dataset_checksum, lr=a and a.last_released, rid=run_id,
                 err=(error or "")[:2000] or None, rt=retry))
        self.conn.commit()

    def _log_error(self, run_id, iso3, year, flow, level, endpoint, err, retry):
        cur = self.conn.cursor()
        cur.execute("""INSERT INTO tf_ingest_error (run_id, reporter_iso3, year, flow, classification_level,
                       endpoint, error_message, retry_count) VALUES (:1,:2,:3,:4,:5,:6,:7,:8)""",
                    [run_id, iso3, year, flow, level, endpoint, str(err)[:2000], retry])
        self.conn.commit()

    # ---- atomic load ------------------------------------------------------
    def load(self, run_id, iso3, year, flow, sel: Selection, res: FetchResult) -> int:
        cur = self.conn.cursor()
        cur.execute("DELETE FROM tf_trade_stage WHERE run_id=:1", [run_id])
        sql = """INSERT INTO tf_trade_stage (reporter_iso3, partner_iso3, year, flow, cmd_code,
                 classification_level, cmd_desc, value_usd, net_weight_kg, qty, qty_unit, last_released, run_id)
                 VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13)"""
        rel = sel.availability.last_released
        rows = [(iso3, r.partner_iso3, year, flow, r.cmd_code, sel.level if len(r.cmd_code) == sel.length else f"HS{len(r.cmd_code)}",
                 (r.cmd_desc or "")[:500] or None, r.value_usd, r.net_weight_kg, r.qty, r.qty_unit, rel, run_id)
                for r in res.rows]
        for i in range(0, len(rows), BATCH):
            cur.executemany(sql, rows[i:i + BATCH])
        # One transaction swaps the year in; a failure before commit leaves the old data untouched.
        cur.execute("DELETE FROM tf_trade_facts WHERE reporter_iso3=:1 AND year=:2 AND flow=:3", [iso3, year, flow])
        cur.execute("""INSERT INTO tf_trade_facts (reporter_iso3, partner_iso3, year, flow, cmd_code,
                       classification_level, cmd_desc, value_usd, net_weight_kg, qty, qty_unit, last_released, run_id)
                       SELECT reporter_iso3, partner_iso3, year, flow, cmd_code, classification_level, cmd_desc,
                              value_usd, net_weight_kg, qty, qty_unit, last_released, run_id
                       FROM tf_trade_stage WHERE run_id=:1""", [run_id])
        cur.execute("DELETE FROM tf_trade_stage WHERE run_id=:1", [run_id])
        self.conn.commit()
        return len(rows)

    # ---- orchestration ----------------------------------------------------
    def run(self, countries: list[str], years: list[int]) -> Summary:
        run_id = str(uuid.uuid4())
        s = Summary(run_id)
        cur = self.conn.cursor()
        if not self.dry:
            cur.execute("INSERT INTO tf_ingest_run (run_id, kind, status, dry_run) VALUES (:1,'comtrade','RUNNING',0)", [run_id])
            self.conn.commit()
        try:
            for iso3 in countries:
                if iso3 not in ISO3_M49:
                    self.log(f"{iso3}: unknown ISO3, skipped")
                    continue
                for year in years:
                    try:
                        self._country_year(run_id, iso3, year, s)
                    except RateLimited:
                        raise
                    except Exception as e:  # one country must not kill the rest
                        s.failed += 1
                        self.log(f"{iso3} {year}: FAILED {e}")
                        if not self.dry:
                            for fl in FLOWS:
                                self._log_error(run_id, iso3, year, fl, None, "availability", e, 0)
        except RateLimited as e:
            s.stopped_on_rate_limit = True
            self.log(f"Comtrade rate limit (retry after {e.retry_after}s): stopping run, state is saved and resumable")
        if not self.dry:
            cur.execute("UPDATE tf_ingest_run SET status=:1, finished_at=SYSTIMESTAMP, detail=:2 WHERE run_id=:3",
                        [s.status, f"ok={s.success} skipped={s.skipped} no_data={s.no_data} failed={s.failed} rows={s.rows}", run_id])
            self.conn.commit()
        return s

    def _usd_rate(self, prov, iso3, year, flow):
        """USD per unit of the source's currency, kept in tf_fx_rate so a rerun converts identically.

        The first time, it is the rate implied by Comtrade's own USD total for the same reporter, year
        and flow (so both sources agree on the size of the trade). It needs Comtrade data to exist
        first; None means there is no basis yet and the caller uses Comtrade this run."""
        cur = self.conn.cursor()
        cur.execute("SELECT usd_per_unit FROM tf_fx_rate WHERE source=:1 AND year=:2 AND flow=:3", [prov.key, year, flow])
        row = cur.fetchone()
        if row:
            return float(row[0])
        cur.execute("""SELECT SUM(value_usd) FROM tf_trade_facts
                       WHERE reporter_iso3=:1 AND year=:2 AND flow=:3 AND partner_iso3='WLD' AND classification_level='HS6'""",
                    [iso3, year, flow])
        usd = cur.fetchone()[0]
        if not usd:
            return None
        local = prov.total_local(year, flow)
        if not local:
            return None
        rate = float(usd) / local
        lo, hi = prov.fx_bounds
        if not lo <= rate <= hi:
            raise ComtradeError(f"implied {prov.currency}/USD rate {rate:.4f} for {year} {flow} is outside {lo}-{hi}; refusing to convert")
        cur.execute("INSERT INTO tf_fx_rate (source, year, flow, currency, usd_per_unit, basis) VALUES (:1,:2,:3,:4,:5,:6)",
                    [prov.key, year, flow, prov.currency, rate, "implied by Comtrade WLD total for the same reporter, year and flow"])
        self.conn.commit()
        return rate

    def _national_unit(self, run_id, iso3, year, flow, prov, s: Summary) -> bool:
        """True when the national source handled this flow (loaded, unchanged, or kept after a failure).
        False sends the flow to Comtrade."""
        st = self._state(iso3, year, flow)
        held = bool(st and st[0] == "SUCCESS" and st[1] == "HS8")
        try:
            av = prov.availability(year, flow)
        except Exception as e:
            self.log(f"{iso3} {year} {flow}: {prov.key} unreachable ({e})")
            av = None
        if av is None:
            if held:
                self.log(f"{iso3} {year} {flow}: {prov.key} unavailable, keeping the stored HS8")
                s.skipped += 1
                return True
            return False
        sel = Selection(prov.key, f"HS{av.level_length}", av.level_length,
                        f"{prov.key} publishes {av.level_length}-digit codes",
                        Availability(av.level_length, av.records, "CN8", av.checksum, av.released))
        if held and st[2] == av.checksum and not self.force:
            s.skipped += 1
            self.log(f"{iso3} {year} {flow}: unchanged ({sel.level} via {prov.key}), skipped")
            return True
        if self.dry:
            s.planned.append(f"{iso3} {year} {flow}: would ingest {sel.level} via {prov.key} ({av.records:,} lines)")
            self.log(s.planned[-1])
            return True
        retry = st[4] if st else 0
        try:
            rate = self._usd_rate(prov, iso3, year, flow)
            if rate is None:
                self.log(f"{iso3} {year} {flow}: no USD basis yet, using Comtrade this run")
                return False
            if not held:
                self._set_state(run_id, iso3, year, flow, "RUNNING", sel)
            res = prov.fetch(year, flow, rate)
            n = self.load(run_id, iso3, year, flow, sel, res)
            self._set_state(run_id, iso3, year, flow, "SUCCESS", sel, records=n, retry=0)
            s.success += 1
            s.rows += n
            self.log(f"{iso3} {year} {flow}: {n:,} rows stored at {sel.level} via {prov.key}")
            return True
        except Exception as e:
            self.conn.rollback()
            self._log_error(run_id, iso3, year, flow, sel.level, prov.key, e, retry + 1)
            self.log(f"{iso3} {year} {flow}: {prov.key} FAILED {e}")
            if held:
                # The stored HS8 stays; a transient fault must never swap it for HS6.
                s.failed += 1
                return True
            self._set_state(run_id, iso3, year, flow, "FAILED", sel, error=str(e), retry=retry + 1)
            return False

    def _country_year(self, run_id, iso3, year, s: Summary):
        prov = self.providers.get(iso3)
        todo = []
        for flow in FLOWS:
            if prov and self._national_unit(run_id, iso3, year, flow, prov, s):
                continue
            todo.append(flow)
        if not todo:
            return
        tl, fn = self.availability(iso3, year)
        sel = classify.resolve(tl, fn)
        if sel is None:
            self.log(f"{iso3} {year}: no data reported by Comtrade")
            s.no_data += 1
            if not self.dry:
                for fl in todo:
                    self._set_state(run_id, iso3, year, fl, "NO_DATA", None)
            return
        for flow in todo:
            st = self._state(iso3, year, flow)
            a = sel.availability
            unchanged = st and st[0] == "SUCCESS" and st[1] == sel.level and st[2] == a.dataset_checksum \
                and st[3] == a.last_released and a.dataset_checksum is not None
            if unchanged and not self.force:
                s.skipped += 1
                self.log(f"{iso3} {year} {flow}: unchanged ({sel.level}), skipped")
                continue
            if st and st[0] == "FAILED" and st[4] >= MAX_RETRIES and not self.force:
                s.skipped += 1
                self.log(f"{iso3} {year} {flow}: retry limit reached, skipped (use --force)")
                continue
            if self.dry:
                s.planned.append(f"{iso3} {year} {flow}: would ingest {sel.level} via {sel.source} ({sel.reason})")
                self.log(s.planned[-1])
                continue
            self._ingest_unit(run_id, iso3, year, flow, sel, fn, st, s)

    def _ingest_unit(self, run_id, iso3, year, flow, sel, final_av, st, s: Summary):
        retry = (st[4] if st else 0)
        self._set_state(run_id, iso3, year, flow, "RUNNING", sel)
        m49 = ISO3_M49[iso3]
        try:
            res = self.api.fetch_tariffline(m49, year, flow, M49_ISO3) if sel.source == "TARIFFLINE" \
                else self.api.fetch_hs6(m49, year, flow, M49_ISO3)
            if not res.rows and sel.source == "TARIFFLINE":
                dem = classify.demote_to_hs6(sel, final_av)
                if dem:
                    self.log(f"{iso3} {year} {flow}: {sel.level} announced but empty, falling back to HS6")
                    sel = dem
                    res = self.api.fetch_hs6(m49, year, flow, M49_ISO3)
            if res.truncated:
                raise ComtradeError("response hit the 250,000-record cap; refusing to store a partial year")
            if not res.rows:
                self._set_state(run_id, iso3, year, flow, "NO_DATA", sel)
                s.no_data += 1
                return
            n = self.load(run_id, iso3, year, flow, sel, res)
            self._set_state(run_id, iso3, year, flow, "SUCCESS", sel, records=n, retry=0)
            s.success += 1
            s.rows += n
            self.log(f"{iso3} {year} {flow}: {n:,} rows stored at {sel.level}")
        except RateLimited:
            self.conn.rollback()
            self._set_state(run_id, iso3, year, flow, "FAILED", sel, error="rate limited", retry=retry)
            raise
        except Exception as e:
            self.conn.rollback()
            self._log_error(run_id, iso3, year, flow, sel.level, sel.source, e, retry + 1)
            self._set_state(run_id, iso3, year, flow, "FAILED", sel, error=str(e), retry=retry + 1)
            s.failed += 1
            self.log(f"{iso3} {year} {flow}: FAILED {e}")


def default_years(back: int = 4) -> list[int]:
    last = datetime.now(timezone.utc).year - 1
    return list(range(last - back + 1, last + 1))


def incremental_years(conn, iso3: str, base: int = 5) -> list[int]:
    "Base years that are not yet complete in both flows, plus the current year."
    now = datetime.now(timezone.utc).year
    want = list(range(now - base, now))
    cur = conn.cursor()
    cur.execute("SELECT year, COUNT(DISTINCT flow) FROM tf_ingest_state WHERE reporter_iso3 = :1 AND status = 'SUCCESS' GROUP BY year", [iso3])
    done = {y for y, n in cur if n >= 2}
    return sorted({y for y in want if y not in done} | {now})
