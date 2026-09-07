"""
Command line.

    python -m tereflow_extract.cli probe   --url URL
    python -m tereflow_extract.cli run     --url URL [--slug ghana] [--fmt csv]
    python -m tereflow_extract.cli run     --file sources.json --out out/
    python -m tereflow_extract.cli sources --db-json registry.json --out out/

`probe` answers "what is this and would you be able to read it" without
downloading or parsing anything, which is the cheap way to survey a registry
before committing to a full run.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from pathlib import Path

from .emit import write_run
from .fetch import Fetcher
from .pipeline import Pipeline, run_urls


def _log(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(levelname)s  %(message)s",
        stream=sys.stderr,
    )


def cmd_probe(args: argparse.Namespace) -> int:
    urls: list[dict]
    if args.file:
        urls = json.loads(Path(args.file).read_text(encoding="utf-8"))
    else:
        urls = [{"url": args.url, "fmt": args.fmt}]

    agree = disagree = failed = 0
    with Fetcher(cache_dir=Path(args.cache) if args.cache else None, delay_s=args.delay) as f:
        for item in urls:
            p = f.probe(item["url"], declared_fmt=item.get("fmt"))
            overridden = any(e.startswith("override:") for e in p.evidence)
            if p.error or p.status >= 400:
                failed += 1
                mark = "FAIL"
            elif overridden:
                disagree += 1
                mark = "DIFFERS"
            else:
                agree += 1
                mark = "ok"
            print(f"{mark:8} {p.status:>4}  {p.source_type.value:<12} {item['url'][:70]}")
            if args.verbose:
                print(f"         {', '.join(p.evidence)}")
                if p.error:
                    print(f"         error: {p.error}")

    if len(urls) > 1:
        print(
            f"\n{agree} matched the registry label, {disagree} did not, {failed} could not be reached"
        )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    if args.file:
        urls = json.loads(Path(args.file).read_text(encoding="utf-8"))
    else:
        urls = [
            {
                "url": args.url,
                "entity_slug": args.slug,
                "fmt": args.fmt,
                "reporter_iso3": args.iso3,
                "flow": args.flow,
            }
        ]

    results = run_urls(
        urls,
        cache_dir=Path(args.cache) if args.cache else None,
        delay_s=args.delay,
        follow_links=not args.no_follow,
    )

    out_dir = Path(args.out)
    manifest = write_run(out_dir, results, run_id=uuid.uuid4().hex[:12])

    print(f"\nSources        {manifest['sources']}")
    print(f"With facts     {manifest['sources_with_facts']}")
    print(f"Errored        {manifest['sources_with_error']}")
    print(f"Facts written  {manifest['facts_written']}")
    print(f"Held back      {manifest['quarantined']}")
    if manifest["quarantine_reasons"]:
        for reason, n in sorted(
            manifest["quarantine_reasons"].items(), key=lambda kv: -kv[1]
        ):
            print(f"    {n:>6}  {reason}")
    print(f"\nWritten to     {out_dir.resolve()}")
    return 0


def cmd_sources(args: argparse.Namespace) -> int:
    """
    Run against a registry export.

    Expects the JSON that this query produces:

      npx wrangler d1 execute tereflow --local --json --command "
        SELECT s.url, s.fmt, s.category, e.slug, e.iso3, e.name
          FROM entity_sources s JOIN entities e ON e.id = s.entity_id
         WHERE e.is_active = 1"
    """
    raw = json.loads(Path(args.db_json).read_text(encoding="utf-8"))
    rows = raw[0]["results"] if isinstance(raw, list) and raw and "results" in raw[0] else raw

    urls = [
        {
            "url": r["url"],
            "entity_slug": r.get("slug"),
            "fmt": r.get("fmt"),
            "reporter_iso3": r.get("iso3"),
            "reporter_name": r.get("name"),
            # The category a source was registered under says which direction
            # it covers. 'commerce' covers both and settles nothing, so it is
            # left unset rather than guessed at.
            "flow": r.get("category") if r.get("category") in ("export", "import") else None,
            "source_ref": f"extract:{r.get('fmt', 'unknown')}",
        }
        for r in rows
    ]
    if args.limit:
        urls = urls[: args.limit]

    args.file = None
    args.url = None
    results = run_urls(
        urls,
        cache_dir=Path(args.cache) if args.cache else None,
        delay_s=args.delay,
        follow_links=not args.no_follow,
    )
    manifest = write_run(Path(args.out), results, run_id=uuid.uuid4().hex[:12])
    print(json.dumps({k: v for k, v in manifest.items() if k != "per_source"}, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tereflow-extract")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--cache", default=".cache", help="directory for fetched bodies")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe", help="say what a URL really is, without parsing it")
    p.add_argument("--url")
    p.add_argument("--file", help="JSON array of {url, fmt}")
    p.add_argument("--fmt", help="what the registry claims it is")
    p.set_defaults(fn=cmd_probe)

    r = sub.add_parser("run", help="extract facts from one or more URLs")
    r.add_argument("--url")
    r.add_argument("--file", help="JSON array of source objects")
    r.add_argument("--slug", help="entity slug the facts belong to")
    r.add_argument("--fmt")
    r.add_argument("--iso3", help="reporting country, where the file does not say")
    r.add_argument("--flow", choices=["export", "import"])
    r.add_argument("--out", default="out")
    r.add_argument("--no-follow", action="store_true", help="do not follow download links")
    r.set_defaults(fn=cmd_run)

    s = sub.add_parser("sources", help="run against a registry export")
    s.add_argument("--db-json", required=True)
    s.add_argument("--out", default="out")
    s.add_argument("--limit", type=int)
    s.add_argument("--no-follow", action="store_true")
    s.set_defaults(fn=cmd_sources)

    args = ap.parse_args(argv)
    _log(args.verbose)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
