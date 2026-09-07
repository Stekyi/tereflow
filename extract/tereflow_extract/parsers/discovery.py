"""
Finding the actual data file when a source hands back a page instead.

This is the module that earns its keep. The registry calls 288 of 600 sources
HTML, and worse, most of the ones it calls csv also return HTML: a landing
page, a database description, a portal, with the real CSV or spreadsheet one
click away behind a link. A source that returns markup is not a dead source,
it is a source with one more hop to take. This module takes that hop by
reading the page and ranking every link on it by how likely it points at the
dataset a caller actually wanted.

The ranking never trusts a single signal. A `.csv` in the href is strong but a
page full of `.csv` links to per-country subsets still needs the download word
and the trade words and the most recent year to sort the wanted file to the
top. Every link that comes back carries the reasons it scored what it did, in
plain words, so a wrong ranking can be argued with rather than just distrusted.

Two page shapes get special handling because they are not really pages:

  - Apache and nginx autoindex listings, where the "page" is a directory of
    files and every data file in it should come back.
  - S3 and CloudFront `ListBucketResult` XML, which is what several government
    bulk-download hosts serve instead of a browsable index. FAOSTAT's bulk
    host is one of these.

Nothing here invents a link. A candidate is only returned when a real signal
in the href, the link text, or the surrounding heading justifies it, and the
`reason` states which signals those were.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse, parse_qs, unquote

from bs4 import BeautifulSoup


@dataclass
class DataLink:
    url: str
    """The link text, or a nearby caption, describing what the link points at."""
    label: str
    """One of csv, excel, pdf, json, zip, api. The best guess from the href."""
    guessed_type: str
    """0 to 1. How likely this link is the dataset the caller wanted."""
    score: float
    """The signals that produced the score, in plain words."""
    reason: str


# What a file extension tells us the link points at. Kept separate from the
# MIME guessing in detect.py because here we are reading an href, not bytes,
# and an href only ever offers an extension as evidence.
_EXT_TYPE: dict[str, str] = {
    ".csv": "csv",
    ".tsv": "csv",
    ".xlsx": "excel",
    ".xls": "excel",
    ".xlsm": "excel",
    ".ods": "excel",
    ".pdf": "pdf",
    ".json": "json",
    ".zip": "zip",
    ".gz": "zip",
    ".7z": "zip",
    ".rar": "zip",
    ".tar": "zip",
    # SDMX and other XML files are files, but the guessed_type vocabulary the
    # caller expects has no xml member. api is the closest honest label for a
    # machine-readable XML endpoint.
    ".xml": "api",
}

# Query keys and key=value tokens that mean "this link is an export request",
# not a page. Only the query string is trusted for this, never the path: a
# path like /data-downloads/ contains the word download but is a landing page,
# whereas ?format=csv is an unambiguous instruction to a server.
_EXPORT_FORMAT: dict[str, str] = {
    "csv": "csv",
    "tsv": "csv",
    "xlsx": "excel",
    "xls": "excel",
    "excel": "excel",
    "json": "json",
    "zip": "zip",
    "pdf": "pdf",
}
_EXPORT_KEYS = ("format", "outputformat", "downloadformat", "output", "type", "fmt")
_EXPORT_TRIGGER_KEYS = ("download", "export", "dl")

# Words in link text that signal a download, across the languages this
# registry actually spans. A strong word is enough on its own to make a link a
# candidate; a weak word is only a tie-breaker, because "data" appears on every
# navigation bar ever built and cannot by itself mark a file.
_STRONG_LABEL = (
    "download",
    "télécharger",
    "telecharger",
    "descargar",
    "baixar",
    "herunterladen",
    "scaricare",
    "scarica",
    "csv",
    "excel",
    "xlsx",
    ".xls",
    "spreadsheet",
    "full dataset",
    "full data",
    "bulk",
)
_WEAK_LABEL = ("data", "dataset", "datos", "données", "donnees", "dados", "daten")

# Words that mark trade relevance in link text or a nearby heading. Relevance
# is a bonus, never a data signal on its own: a link labelled "Exports" that
# points at another landing page is still not a file.
_TRADE = (
    "export",
    "import",
    "trade",
    "commerce",
    "comercio",
    "commodit",
    "merchandise",
    "tariff",
    "exportation",
    "importation",
    "exportacion",
    "importacion",
    "handel",
)
_TRADE_HS = re.compile(r"\bhs[\s\-_]?\d{0,6}\b", re.I)

# Words that mark a link as something other than the data: help, legal,
# navigation, and metadata. Metadata is useful but it is documentation about
# the data, not the data, and returning it as the dataset would be a lie.
_PENALTY = (
    "about",
    "contact",
    "methodology",
    "privacy",
    "terms",
    "licence",
    "license",
    "login",
    "signin",
    "sign-in",
    "help",
    "faq",
    "documentation",
    "metadata",
    "disclaimer",
    "cookie",
    "sitemap",
    "accessibility",
    "glossary",
    "newsletter",
    "subscribe",
    "copyright",
)

# A four-digit year that is not embedded in a longer run of digits, so a
# table id like 1210012101 does not read as the year 2100.
_YEAR = re.compile(r"(?<!\d)(19|20)\d{2}(?!\d)")


def find_data_links(html: bytes, base_url: str, *, want: str | None = None) -> list[DataLink]:
    """
    Rank the links on a page by how likely each points at the wanted dataset.

    `want` optionally biases toward a type, 'csv' or 'excel', when a source is
    known to offer several formats of the same data. Malformed input returns an
    empty list rather than raising, because a page that will not parse is a
    page with no findable links, which is a result and not an error.
    """
    if not html:
        return []

    # An S3 or CloudFront bucket listing is XML, not a page. It is what several
    # bulk hosts serve, so it is checked before the HTML path rather than left
    # to be mis-parsed as tag soup.
    head = html[:512].lstrip()
    if head[:5] == b"<?xml" or b"ListBucketResult" in html[:4096]:
        links = _parse_s3_listing(html, base_url, want)
        if links:
            return links

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        try:
            soup = BeautifulSoup(html, "html.parser")
        except Exception:
            return []

    listing = _parse_dir_listing(soup, base_url, want)
    if listing:
        return listing

    seen: dict[str, DataLink] = {}
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.lower().startswith(("mailto:", "javascript:", "tel:")):
            continue

        label = " ".join(a.get_text(" ", strip=True).split())
        if not label:
            label = (a.get("title") or a.get("aria-label") or "").strip()

        nearby = _nearby_text(a)
        candidate = _score_link(href, label, nearby, base_url, want)
        if candidate is None:
            continue

        prior = seen.get(candidate.url)
        if prior is None or candidate.score > prior.score:
            seen[candidate.url] = candidate

    ranked = list(seen.values())
    _apply_recency(ranked)
    ranked.sort(key=lambda d: d.score, reverse=True)
    return ranked


def _score_link(
    href: str, label: str, nearby: str, base_url: str, want: str | None
) -> DataLink | None:
    """
    Judge one link. Returns None when nothing justifies calling it data.

    A link is only a candidate when at least one real data signal fires: a data
    extension, an explicit export query, a file named in a fragment, or a
    strong download word in its text. Trade relevance, a weak "data" label, or
    a recent year add to a candidate that already qualifies but can never make
    one on their own.
    """
    absolute = urljoin(base_url, href)
    parsed = urlparse(absolute)
    path = parsed.path.lower()
    query = parsed.query.lower()
    frag = unquote(parsed.fragment).lower()
    text = f"{label} {nearby}".lower()

    score = 0.0
    reasons: list[str] = []
    guessed: str | None = None
    has_data_signal = False

    ext = _path_ext(path)
    if ext and ext in _EXT_TYPE:
        guessed = _EXT_TYPE[ext]
        has_data_signal = True
        if guessed == "pdf":
            score += 0.25
            reasons.append(f"href ends {ext}, a document")
        else:
            score += 0.45
            reasons.append(f"href ends {ext}")

    fmt_type = _export_format(query)
    if fmt_type is not None:
        has_data_signal = True
        score += 0.40
        reasons.append("query asks for an export format")
        if guessed is None:
            guessed = fmt_type
    elif _export_triggered(query):
        has_data_signal = True
        score += 0.30
        reasons.append("query is an export or download request")
        if guessed is None:
            guessed = "api"

    # A file named inside the fragment is how JavaScript table viewers point at
    # a CSV, seen on StatCan. The href alone is a page anchor, so the fragment
    # is where the real target hides.
    frag_ext = _fragment_file(frag)
    if frag_ext is not None:
        has_data_signal = True
        score += 0.30
        reasons.append("a data file is named in the link fragment")
        if guessed is None or guessed == "api":
            guessed = _EXT_TYPE.get(frag_ext, guessed or "csv")

    strong = _first_hit(text, _STRONG_LABEL)
    if strong is not None:
        has_data_signal = True
        score += 0.18
        reasons.append(f"link text says '{strong}'")
        if guessed is None:
            guessed = _label_type(strong)

    if not has_data_signal:
        weak = _first_hit(text, _WEAK_LABEL)
        # A bare "data" is not enough. Without a real signal there is nothing
        # to return, however trade-relevant or recent the link looks.
        if weak is None:
            return None
        return None

    penalty = _first_hit(f"{path} {text}", _PENALTY)
    if penalty is not None:
        score -= 0.6
        reasons.append(f"penalised: looks like '{penalty}', not the data")

    if _first_hit(text, _TRADE) is not None or _TRADE_HS.search(text) is not None:
        score += 0.18
        reasons.append("text is about trade")

    weak = _first_hit(text, _WEAK_LABEL)
    if weak is not None and strong is None:
        score += 0.05
        reasons.append(f"link text mentions '{weak}'")

    if want and guessed == want:
        score += 0.15
        reasons.append(f"matches the wanted type '{want}'")

    if guessed is None:
        guessed = "api"

    if score <= 0:
        return None

    year = _max_year(f"{absolute} {label}")
    if year is not None:
        reasons.append(f"references {year}")

    return DataLink(
        url=absolute,
        label=label or absolute.rsplit("/", 1)[-1],
        guessed_type=guessed,
        score=round(min(score, 1.0), 4),
        reason="; ".join(reasons),
    )


def _apply_recency(links: list[DataLink]) -> None:
    """
    Nudge the newest files up.

    A year present at all is worth a little; being the most recent year among
    all the candidates is worth a little more, so this year's release outranks
    last year's when everything else about them is equal.
    """
    years: dict[int, int] = {}
    for d in links:
        y = _max_year(f"{d.url} {d.label}")
        years[id(d)] = y or 0
    newest = max(years.values(), default=0)
    if newest == 0:
        return
    for d in links:
        y = years[id(d)]
        if y <= 0:
            continue
        bump = 0.06
        note = "has a year"
        if y == newest:
            bump = 0.12
            note = f"is the most recent year seen ({y})"
        d.score = round(min(d.score + bump, 1.0), 4)
        d.reason = f"{d.reason}; {note}"


def _parse_dir_listing(soup: BeautifulSoup, base_url: str, want: str | None) -> list[DataLink]:
    """
    Read an Apache or nginx directory index and return every data file in it.

    Detected by the "Index of" title these servers emit and by the <pre> block
    of file links they lay the listing out in. Parent-directory and
    column-sort links are dropped; subdirectories are dropped because they are
    not files; everything with a data extension is kept.
    """
    title = soup.title.get_text(strip=True) if soup.title else ""
    h1 = soup.find(["h1", "h2"])
    heading = h1.get_text(strip=True) if h1 else ""
    is_index = title.lower().startswith("index of") or heading.lower().startswith("index of")

    pre = soup.find("pre")
    anchors = []
    if pre is not None and pre.find("a", href=True):
        anchors = pre.find_all("a", href=True)
    elif is_index:
        anchors = soup.find_all("a", href=True)
    else:
        return []

    out: dict[str, DataLink] = {}
    for a in anchors:
        href = a["href"].strip()
        low = href.lower()
        if not href or href in ("../", "./") or href.startswith("?") or low.startswith("mailto:"):
            continue
        if href.endswith("/"):
            # A subdirectory, not a file. The crawler can recurse into it, but
            # it is not itself a dataset to return here.
            continue
        ext = _path_ext(urlparse(href).path.lower())
        if ext not in _EXT_TYPE:
            continue
        absolute = urljoin(base_url, href)
        label = " ".join(a.get_text(" ", strip=True).split()) or href
        guessed = _EXT_TYPE[ext]
        score = 0.6
        reasons = [f"file in a directory listing, ends {ext}"]
        if want and guessed == want:
            score += 0.15
            reasons.append(f"matches the wanted type '{want}'")
        if _first_hit(label.lower(), _TRADE) is not None:
            score += 0.1
            reasons.append("name is about trade")
        year = _max_year(f"{href} {label}")
        if year is not None:
            reasons.append(f"references {year}")
        dl = DataLink(
            url=absolute,
            label=label,
            guessed_type=guessed,
            score=round(min(score, 1.0), 4),
            reason="; ".join(reasons),
        )
        prior = out.get(absolute)
        if prior is None or dl.score > prior.score:
            out[absolute] = dl

    ranked = list(out.values())
    _apply_recency(ranked)
    ranked.sort(key=lambda d: d.score, reverse=True)
    return ranked


def _parse_s3_listing(xml: bytes, base_url: str, want: str | None) -> list[DataLink]:
    """
    Read an S3 or CloudFront ListBucketResult and return every data file keyed
    in it. This is what FAOSTAT-style bulk hosts serve in place of a browsable
    index, so it is treated as a first-class listing rather than an error page.
    """
    try:
        soup = BeautifulSoup(xml, "xml")
    except Exception:
        try:
            soup = BeautifulSoup(xml, "lxml-xml")
        except Exception:
            return []

    root = urlparse(base_url)
    origin = f"{root.scheme}://{root.netloc}/"

    out: dict[str, DataLink] = {}
    for contents in soup.find_all("Contents"):
        key_el = contents.find("Key")
        if key_el is None:
            continue
        key = key_el.get_text(strip=True)
        if not key or key.endswith("/"):
            continue
        ext = _path_ext(key.lower())
        if ext not in _EXT_TYPE:
            continue
        absolute = urljoin(origin, key)
        guessed = _EXT_TYPE[ext]
        score = 0.6
        reasons = [f"object in a bucket listing, ends {ext}"]
        if want and guessed == want:
            score += 0.15
            reasons.append(f"matches the wanted type '{want}'")
        if _first_hit(key.lower(), _TRADE) is not None:
            score += 0.1
            reasons.append("key is about trade")
        year = _max_year(key)
        if year is not None:
            reasons.append(f"references {year}")
        dl = DataLink(
            url=absolute,
            label=key.rsplit("/", 1)[-1],
            guessed_type=guessed,
            score=round(min(score, 1.0), 4),
            reason="; ".join(reasons),
        )
        out[absolute] = dl

    ranked = list(out.values())
    _apply_recency(ranked)
    ranked.sort(key=lambda d: d.score, reverse=True)
    return ranked


def _nearby_text(a) -> str:
    """
    The heading a link sits under, so relevance can be read from context.

    A link labelled only "Download" tells you nothing on its own, but the
    "Merchandise exports by partner" heading above it does. This looks at the
    nearest enclosing cell or list item and the closest heading before the
    link, and stops there rather than dragging in the whole page.
    """
    parts: list[str] = []
    parent = a.find_parent(["td", "th", "li", "p", "figcaption", "caption", "dd", "dt"])
    if parent is not None:
        parts.append(parent.get_text(" ", strip=True))

    heading = None
    node = a
    for _ in range(6):
        node = node.find_previous(["h1", "h2", "h3", "h4", "caption", "legend"])
        if node is None:
            break
        heading = node.get_text(" ", strip=True)
        if heading:
            break
    if heading:
        parts.append(heading)

    return " ".join(" ".join(parts).split())[:400]


def _path_ext(path: str) -> str | None:
    last = path.rsplit("/", 1)[-1]
    dot = last.rfind(".")
    if dot <= 0:
        return None
    return last[dot:]


def _export_format(query: str) -> str | None:
    """A query that names an output format, returned as that type."""
    if not query:
        return None
    q = parse_qs(query)
    for key in _EXPORT_KEYS:
        for val in q.get(key, []):
            v = val.lower().strip().lstrip(".")
            if v in _EXPORT_FORMAT:
                return _EXPORT_FORMAT[v]
    return None


def _export_triggered(query: str) -> bool:
    """A query that asks to download or export without naming a format."""
    if not query:
        return False
    q = parse_qs(query)
    for key in _EXPORT_TRIGGER_KEYS:
        if key in q:
            return True
    return False


def _fragment_file(frag: str) -> str | None:
    """A data file named in a URL fragment, as JS table viewers do it."""
    if not frag:
        return None
    m = re.search(r"file=([^&]+)", frag)
    target = m.group(1) if m else frag
    ext = _path_ext(target)
    if ext in _EXT_TYPE and ext != ".pdf":
        return ext
    return None


def _label_type(word: str) -> str:
    w = word.lower()
    if w in ("csv", "tsv"):
        return "csv"
    if w in ("excel", "xlsx", ".xls", "spreadsheet"):
        return "excel"
    return "api"


def _first_hit(text: str, words) -> str | None:
    for w in words:
        if w in text:
            return w
    return None


def _max_year(text: str) -> int | None:
    years = [int(m.group(0)) for m in _YEAR.finditer(text)]
    if not years:
        return None
    plausible = [y for y in years if 1900 <= y <= 2099]
    return max(plausible) if plausible else None
