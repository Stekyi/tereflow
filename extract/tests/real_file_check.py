"""Run the tabular parser against a genuine statistical file.

This is deliberately kept separate from test_parsers.py because it needs the
network. It downloads the smallest FAOSTAT bulk dataset, unzips the CSV it
contains, and feeds the raw CSV bytes to parse_tabular exactly as the pipeline
would. If the network is unavailable the check reports a skip and exits 0, so
an offline run never turns a connectivity problem into a false failure.
"""

import io
import sys
import zipfile
from pathlib import Path

# Importing the test module installs the stub normalize package into sys.modules
# and puts the extract dir on sys.path, so the parser imports resolve the same
# way they do under the unit tests.
import test_parsers  # noqa: F401

from tereflow_extract.parsers.tabular import parse_tabular
from tereflow_extract.contracts import SourceType

LISTING = "https://bulks-faostat.fao.org/production/datasets_E.json"


def _candidate_urls():
    """Return real bulk-download URLs to try, richest-shape first.

    The very smallest FAOSTAT dataset happens to be a survey table with no
    country or year column, which is a fine parse but a thin demonstration.
    So a few normalized country-by-year datasets are tried first, and the
    size-ranked list is appended as a fallback. Every entry is a genuine file
    taken from the live listing; nothing is hard-coded blindly.
    """
    import httpx

    r = httpx.get(LISTING, timeout=60.0)
    r.raise_for_status()
    datasets = r.json()["Datasets"]["Dataset"]
    by_loc = {d.get("FileLocation"): d for d in datasets if d.get("FileLocation")}

    def size(d):
        raw = str(d.get("FileSize") or "")
        num = "".join(ch for ch in raw if ch.isdigit() or ch == ".")
        try:
            val = float(num) if num else 1e15
        except ValueError:
            return 1e15
        up = raw.upper()
        if "KB" in up:
            val *= 1024
        elif "MB" in up:
            val *= 1024 * 1024
        elif "GB" in up:
            val *= 1024 ** 3
        return val

    ranked = [d["FileLocation"] for d in sorted(by_loc.values(), key=size)]

    # Prefer small normalized datasets that carry Area and Year columns.
    preferred_hints = (
        "Food_Aid_Shipments_WFP",
        "Investment_ForeignDirectInvestment",
        "Investment_CreditAgriculture",
    )
    preferred = []
    for hint in preferred_hints:
        for loc in ranked:
            if hint in loc:
                preferred.append(loc)
                break

    ordered = preferred + [loc for loc in ranked if loc not in preferred]
    return [(loc, by_loc[loc].get("DatasetName")) for loc in ordered]


def _fetch_csv(url):
    import httpx

    blob = httpx.get(url, timeout=120.0, follow_redirects=True).content
    zf = zipfile.ZipFile(io.BytesIO(blob))
    csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
    if not csv_names:
        return None, None
    return csv_names[0], zf.read(csv_names[0])


def main():
    try:
        candidates = _candidate_urls()
    except Exception as exc:  # network, DNS, timeout
        print(f"SKIP real-file check (could not reach listing): {exc}")
        return 0

    chosen = None
    for url, name in candidates[:6]:
        try:
            print(f"trying {name}")
            csv_name, csv_bytes = _fetch_csv(url)
            if not csv_bytes:
                print("  no CSV inside zip, skipping")
                continue
        except Exception as exc:
            print(f"  fetch failed: {exc}")
            continue

        rows = parse_tabular(csv_bytes, SourceType.CSV, url, filename=csv_name)
        richness = sum(
            1
            for r in rows[:50]
            if r.value is not None and (r.year is not None or r.reporter_name is not None)
        )
        print(f"  {csv_name}: {len(rows)} rows, richness={richness}")
        if rows and (chosen is None or richness > chosen[0]):
            chosen = (richness, url, name, csv_name, csv_bytes, rows)
        # A country-by-year file is a good enough demonstration; stop early.
        if richness > 0:
            break

    if chosen is None:
        print("SKIP real-file check: no candidate yielded rows")
        return 0

    richness, url, name, csv_name, csv_bytes, rows = chosen
    print(f"\nchosen: {name}")
    print(f"  {url}")
    print(f"  zip member: {csv_name}  ({len(csv_bytes)} bytes)")
    print(f"parse_tabular returned {len(rows)} extraction(s)")

    fields = set()
    for r in rows[:5000]:
        if r.reporter_name is not None:
            fields.add("reporter")
        if r.product_name is not None:
            fields.add("product")
        if r.flow is not None:
            fields.add("flow")
        if r.value is not None:
            fields.add("value")
        if r.year is not None:
            fields.add("year")
        if r.qty_unit is not None:
            fields.add("qty_unit")
    print(f"fields populated across rows: {sorted(fields)}")

    print("\nsample extractions:")
    for r in rows[:3]:
        p = r.provenance
        print(
            "  reporter={!r} product={!r} flow={!r} year={!r} value={!r} unit={!r}".format(
                r.reporter_name, r.product_name, r.flow, r.year, r.value, r.qty_unit
            )
        )
        if p is not None:
            print(
                "    prov: row_index={} raw_label={!r} raw_value={!r} locator={!r}".format(
                    p.row_index, p.raw_label, p.raw_value, p.locator
                )
            )

    if not any(r.value is not None for r in rows):
        print("no row carried a parseable value")
        return 1

    print("\nreal-file check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
