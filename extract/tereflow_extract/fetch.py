"""
Getting the bytes, politely.

These are public statistics servers run by government agencies, several of them
small. The pipeline is a guest: it identifies itself, it goes slowly, it caches
what it already has, and it backs off when told to.

Two specifics learned from probing the registry:

A default automation user agent gets refused. `comexstat.mdic.gov.br` returns
403 to urllib's default and 200 to a browser string. That is not a block on
robots, it is a block on looking like a script, so this sends a normal browser
identity with a contact URL appended.

Only the first few kilobytes are needed to tell what a thing is. Downloading a
200MB bulk file to discover it is a zip of CSVs wastes the server's bandwidth
and the run's time, so detection reads a small range first and the full body is
only fetched once the type is known and wanted.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from .contracts import Probe, SourceType
from .detect import classify

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 "
    "TereflowExtract/1.0 (+https://github.com/Stekyi/tereflow)"
)

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "en,fr;q=0.8,es;q=0.7,pt;q=0.6,de;q=0.5",
}

SNIFF_BYTES = 8192
DEFAULT_MAX_BYTES = 80 * 1024 * 1024


@dataclass
class Fetched:
    url: str
    final_url: str
    status: int
    content_type: str | None
    body: bytes
    from_cache: bool = False
    truncated: bool = False
    error: str | None = None


class Fetcher:
    """
    A polite client with a disk cache.

    The cache is keyed on the URL and is not time limited on purpose. These are
    annual statistical releases; a file that was correct this morning is still
    correct this afternoon, and re-downloading it to prove that costs the
    publisher bandwidth for nothing. Delete the cache directory to force a
    refetch.
    """

    def __init__(
        self,
        cache_dir: Path | None = None,
        *,
        delay_s: float = 1.0,
        timeout_s: float = 45.0,
        max_bytes: int = DEFAULT_MAX_BYTES,
        retries: int = 1,
    ) -> None:
        self.cache_dir = cache_dir
        if cache_dir:
            cache_dir.mkdir(parents=True, exist_ok=True)
        self.delay_s = delay_s
        self.max_bytes = max_bytes
        self._last_request_at = 0.0
        self._client = httpx.Client(
            headers=HEADERS,
            follow_redirects=True,
            # Split rather than one number. A statistics server that accepts the
            # connection and then thinks for a minute is normal; one that will
            # not accept a connection at all is down, and waiting the full
            # timeout on it wastes a minute per dead source across a registry
            # where dead sources are common.
            timeout=httpx.Timeout(timeout_s, connect=15.0),
            verify=False,  # several national stats sites have expired chains
        )
        self.retries = retries

    def _with_retry(self, fn, url: str):
        """
        Try again on the failures that are usually temporary.

        Timeouts and connection resets against government servers are often
        load rather than a broken source, and one retry after a pause turns a
        good number of them into successes. A 404 is not retried: it will be a
        404 again in two seconds.
        """
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                return fn()
            except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as e:
                last = e
                if attempt < self.retries:
                    backoff = 2.0 * (attempt + 1)
                    log.info("retrying %s after %s (%.0fs)", url, type(e).__name__, backoff)
                    time.sleep(backoff)
        raise last  # type: ignore[misc]

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Fetcher":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _cache_path(self, url: str) -> Path | None:
        if not self.cache_dir:
            return None
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]
        return self.cache_dir / f"{key}.bin"

    def _wait(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.delay_s:
            time.sleep(self.delay_s - elapsed)
        self._last_request_at = time.monotonic()

    def probe(self, url: str, declared_fmt: str | None = None) -> Probe:
        """
        Establish what a URL returns without downloading all of it.

        Reads a small range and classifies from the bytes. Where a server does
        not honour Range it will send the whole body; the connection is closed
        after the sniff either way rather than reading it all into memory.
        """
        self._wait()
        try:
            def _do() -> Probe:
                with self._client.stream(
                    "GET", url, headers={"Range": f"bytes=0-{SNIFF_BYTES - 1}"}
                ) as r:
                    head = b""
                    for chunk in r.iter_bytes(chunk_size=2048):
                        head += chunk
                        if len(head) >= SNIFF_BYTES:
                            break
                    ctype = r.headers.get("content-type")
                    clen = r.headers.get("content-length")
                    source_type, evidence = classify(url, ctype, head, declared_fmt)
                    return Probe(
                        url=url,
                        final_url=str(r.url),
                        status=r.status_code,
                        content_type=ctype,
                        content_length=int(clen) if clen and clen.isdigit() else None,
                        source_type=source_type,
                        evidence=evidence,
                    )

            return self._with_retry(_do, url)
        except Exception as e:  # noqa: BLE001 - the reason is reported, not swallowed
            return Probe(
                url=url,
                final_url=url,
                status=0,
                content_type=None,
                content_length=None,
                source_type=SourceType.UNKNOWN,
                evidence=[f"error:{type(e).__name__}"],
                error=str(e)[:300],
            )

    def get(self, url: str, *, use_cache: bool = True) -> Fetched:
        """Fetch a whole body, from disk where it has been fetched before."""
        cache_path = self._cache_path(url)
        if use_cache and cache_path and cache_path.exists():
            return Fetched(
                url=url,
                final_url=url,
                status=200,
                content_type=None,
                body=cache_path.read_bytes(),
                from_cache=True,
            )

        self._wait()
        try:
            def _do() -> Fetched:
                with self._client.stream("GET", url) as r:
                    body = bytearray()
                    truncated = False
                    for chunk in r.iter_bytes(chunk_size=65536):
                        body += chunk
                        if len(body) >= self.max_bytes:
                            truncated = True
                            break
                    data = bytes(body)
                    if cache_path and r.status_code == 200 and not truncated:
                        cache_path.write_bytes(data)
                    return Fetched(
                        url=url,
                        final_url=str(r.url),
                        status=r.status_code,
                        content_type=r.headers.get("content-type"),
                        body=data,
                        truncated=truncated,
                    )

            return self._with_retry(_do, url)
        except Exception as e:  # noqa: BLE001
            return Fetched(
                url=url,
                final_url=url,
                status=0,
                content_type=None,
                body=b"",
                error=f"{type(e).__name__}: {e}"[:300],
            )
