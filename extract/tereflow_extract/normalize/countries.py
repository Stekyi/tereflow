"""
Country names to ISO3, with an explicit refusal to guess.

Fuzzy matching is the obvious tool here and it is also the trap. The pairs that
matter most in trade data are the ones a similarity score gets wrong:

    Niger        Nigeria             one letter apart, both major exporters
    Guinea       Guinea-Bissau       and Equatorial Guinea and Papua New Guinea
    Congo        DR Congo            different countries, both trade heavily
    Korea        which one           depends entirely on context
    Ireland      Iceland             two letters apart
    Sudan        South Sudan         separate countries since 2011
    Dominica     Dominican Republic  different countries

A ratio of 90 would happily map Niger to Nigeria, and nothing downstream would
ever question it: the row would look completely normal, attributed to a country
with roughly twenty times the trade. So every one of those pairs is handled by
an exact-match guard before fuzzy matching is allowed to run at all, and where a
name is genuinely ambiguous this returns None with a low score.

None means the caller flags the row and a person looks. That is the correct
outcome, and cheaper than a wrong attribution nobody notices.
"""

from __future__ import annotations

import re
from functools import lru_cache

import pycountry
from rapidfuzz import fuzz, process

# Names whose closest neighbour is a different real country. Exact match only,
# never fuzzy, because the fuzzy answer is confidently wrong.
DANGEROUS_EXACT: dict[str, str] = {
    "niger": "NER",
    "nigeria": "NGA",
    "guinea": "GIN",
    "guinea-bissau": "GNB",
    "guinea bissau": "GNB",
    "equatorial guinea": "GNQ",
    "papua new guinea": "PNG",
    "ireland": "IRL",
    "iceland": "ISL",
    "sudan": "SDN",
    "south sudan": "SSD",
    "dominica": "DMA",
    "dominican republic": "DOM",
    "austria": "AUT",
    "australia": "AUS",
    "slovakia": "SVK",
    "slovenia": "SVN",
    "mali": "MLI",
    "malawi": "MWI",
    "chad": "TCD",
    "chile": "CHL",
    "china": "CHN",
    "india": "IND",
    "indonesia": "IDN",
    "mauritania": "MRT",
    "mauritius": "MUS",
    "morocco": "MAR",
    "monaco": "MCO",
    "zambia": "ZMB",
    "zimbabwe": "ZWE",
    "gambia": "GMB",
    "the gambia": "GMB",
    "togo": "TGO",
    "tonga": "TON",
    "latvia": "LVA",
    "lithuania": "LTU",
    "somalia": "SOM",
    "samoa": "WSM",
    "armenia": "ARM",
    "albania": "ALB",
    "algeria": "DZA",
    "romania": "ROU",
    "norway": "NOR",
    "north macedonia": "MKD",
    "singapore": "SGP",
    "sierra leone": "SLE",
    "senegal": "SEN",
    "serbia": "SRB",
}

# Names a source is likely to print that ISO does not carry, and historic or
# political variants. These are exact aliases, not guesses.
ALIASES: dict[str, str] = {
    "usa": "USA", "u.s.a.": "USA", "u.s.": "USA", "us": "USA",
    "united states": "USA", "united states of america": "USA",
    "america": "USA",
    "uk": "GBR", "u.k.": "GBR", "great britain": "GBR", "britain": "GBR",
    "united kingdom": "GBR",
    "united kingdom of great britain and northern ireland": "GBR",
    "uae": "ARE", "u.a.e.": "ARE", "united arab emirates": "ARE",
    "drc": "COD", "dr congo": "COD", "d.r. congo": "COD",
    "democratic republic of the congo": "COD",
    "democratic republic of congo": "COD", "congo, dem. rep.": "COD",
    "congo (kinshasa)": "COD", "congo-kinshasa": "COD", "zaire": "COD",
    "congo": "COG", "republic of the congo": "COG", "congo, rep.": "COG",
    "congo (brazzaville)": "COG", "congo-brazzaville": "COG",
    "south korea": "KOR", "korea, rep.": "KOR", "republic of korea": "KOR",
    "korea, republic of": "KOR", "korea (south)": "KOR", "rep. of korea": "KOR",
    "north korea": "PRK", "korea, dem. people's rep.": "PRK",
    "democratic people's republic of korea": "PRK", "korea (north)": "PRK",
    "russia": "RUS", "russian federation": "RUS",
    "ivory coast": "CIV", "cote d'ivoire": "CIV", "côte d'ivoire": "CIV",
    "cote divoire": "CIV", "cote d ivoire": "CIV",
    "cabo verde": "CPV", "cape verde": "CPV",
    "swaziland": "SWZ", "eswatini": "SWZ",
    "burma": "MMR", "myanmar": "MMR",
    "east timor": "TLS", "timor-leste": "TLS",
    "czech republic": "CZE", "czechia": "CZE",
    "macedonia": "MKD", "fyrom": "MKD",
    "turkey": "TUR", "türkiye": "TUR", "turkiye": "TUR",
    "netherlands": "NLD", "holland": "NLD", "the netherlands": "NLD",
    "vietnam": "VNM", "viet nam": "VNM",
    "laos": "LAO", "lao pdr": "LAO", "lao people's democratic republic": "LAO",
    "syria": "SYR", "syrian arab republic": "SYR",
    "iran": "IRN", "iran, islamic rep.": "IRN", "islamic republic of iran": "IRN",
    "venezuela": "VEN", "venezuela, rb": "VEN",
    "bolivia": "BOL", "plurinational state of bolivia": "BOL",
    "tanzania": "TZA", "united republic of tanzania": "TZA",
    "moldova": "MDA", "republic of moldova": "MDA",
    "brunei": "BRN", "brunei darussalam": "BRN",
    "cape verde islands": "CPV",
    "hong kong": "HKG", "hong kong sar": "HKG", "hong kong, china": "HKG",
    "china, hong kong sar": "HKG",
    "macao": "MAC", "macau": "MAC", "china, macao sar": "MAC",
    "taiwan": "TWN", "chinese taipei": "TWN", "taiwan, china": "TWN",
    "china, taiwan province of": "TWN",
    "egypt": "EGY", "egypt, arab rep.": "EGY",
    "yemen": "YEM", "yemen, rep.": "YEM",
    "gambia, the": "GMB",
    "bahamas, the": "BHS", "the bahamas": "BHS", "bahamas": "BHS",
    "kyrgyzstan": "KGZ", "kyrgyz republic": "KGZ",
    "slovak republic": "SVK",
    "st. lucia": "LCA", "saint lucia": "LCA",
    "st. kitts and nevis": "KNA", "saint kitts and nevis": "KNA",
    "st. vincent and the grenadines": "VCT",
    "saint vincent and the grenadines": "VCT",
    "antigua and barbuda": "ATG",
    "trinidad and tobago": "TTO",
    "bosnia and herzegovina": "BIH", "bosnia": "BIH",
    "central african republic": "CAF", "car": "CAF",
    "sao tome and principe": "STP", "são tomé and príncipe": "STP",
    "burkina faso": "BFA", "burkina": "BFA",
    "new zealand": "NZL",
    "papua new guinea ": "PNG",
    "south africa": "ZAF",
    "saudi arabia": "SAU",
    "sri lanka": "LKA",
    "costa rica": "CRI",
    "el salvador": "SLV",
    "puerto rico": "PRI",
    "north cyprus": "CYP",
    "palestine": "PSE", "state of palestine": "PSE",
    "west bank and gaza": "PSE",
    "kosovo": "XKX",
}

# Aggregates. Real rows in trade tables, but not countries, and mapping them to
# one would corrupt every total downstream.
AGGREGATES: set[str] = {
    "world", "total", "all countries", "all", "total world", "world total",
    "european union", "eu", "eu27", "eu-27", "eu28", "eu-28", "euro area",
    "africa", "asia", "europe", "america", "americas", "north america",
    "south america", "latin america", "oceania", "middle east",
    "sub-saharan africa", "sub saharan africa", "north africa",
    "developing economies", "developed economies", "least developed countries",
    "ldc", "ldcs", "oecd", "opec", "asean", "ecowas", "sadc", "comesa",
    "mercosur", "nafta", "usmca", "brics", "g7", "g20", "commonwealth",
    "rest of world", "other countries", "others", "not specified",
    "unspecified", "areas nes", "not allocated", "free zones",
    "special categories", "confidential", "bunkers", "eu institutions",
    "intra-eu", "extra-eu", "intra eu", "extra eu",
}

_NOISE = re.compile(r"\s*\((?:[^)]*)\)\s*$")
_FOOTNOTE = re.compile(r"[\*\u2020\u2021\d]+$")


def _norm(name: str) -> str:
    s = str(name).strip().lower()
    s = s.replace("\u00a0", " ")
    s = _NOISE.sub("", s)          # drop a trailing parenthetical
    s = _FOOTNOTE.sub("", s).strip()  # drop footnote markers
    s = re.sub(r"\s+", " ", s)
    s = s.strip(" .,:;")
    return s


@lru_cache(maxsize=1)
def _iso_index() -> dict[str, str]:
    """Every official and common ISO name, lowercased, to alpha-3."""
    index: dict[str, str] = {}
    for c in pycountry.countries:
        for attr in ("name", "official_name", "common_name"):
            v = getattr(c, attr, None)
            if v:
                index[_norm(v)] = c.alpha_3
        index[c.alpha_3.lower()] = c.alpha_3
        index[c.alpha_2.lower()] = c.alpha_3
    return index


@lru_cache(maxsize=1)
def _fuzzy_pool() -> dict[str, str]:
    """
    The names fuzzy matching is allowed to consider.

    Everything in DANGEROUS_EXACT is excluded, because those are precisely the
    names where a near miss lands on a different real country.
    """
    pool = {k: v for k, v in _iso_index().items() if k not in DANGEROUS_EXACT}
    for alias, iso in ALIASES.items():
        if alias not in DANGEROUS_EXACT:
            pool[alias] = iso
    return pool


def is_aggregate(name: str) -> bool:
    """Whether a label is a region or grouping rather than a country."""
    return _norm(name) in AGGREGATES


def resolve_country(name: str | None) -> tuple[str | None, str | None, float]:
    """
    Resolve a printed country name to ISO3.

    Returns (iso3, canonical name, confidence). Confidence is graded:

      1.00  an ISO code, an exact ISO name, or a known alias
      0.95  an exact match on a name that fuzzy matching is barred from
      0.85  a fuzzy match at or above 93, where the runner-up is clearly worse
      0.00  aggregate, unknown, or too close to call

    A zero score with a None code is a real answer meaning "this needs a human".
    It is never a licence to pick the nearest name.
    """
    if not name:
        return None, None, 0.0

    key = _norm(name)
    if not key:
        return None, None, 0.0

    if key in AGGREGATES:
        return None, None, 0.0

    # Guarded names first, exact only.
    if key in DANGEROUS_EXACT:
        iso = DANGEROUS_EXACT[key]
        return iso, _canonical(iso), 0.95

    if key in ALIASES:
        iso = ALIASES[key]
        return iso, _canonical(iso), 1.0

    index = _iso_index()
    if key in index:
        iso = index[key]
        return iso, _canonical(iso), 1.0

    # A bare 2 or 3 letter token that is not a known code is not a country.
    # Guessing from it lands on nonsense.
    if len(key) <= 3:
        return None, None, 0.0

    pool = _fuzzy_pool()
    matches = process.extract(key, pool.keys(), scorer=fuzz.WRatio, limit=3)
    if not matches:
        return None, None, 0.0

    best_name, best_score, _ = matches[0]

    if best_score < 93:
        return None, None, 0.0

    # If a guarded name scores nearly as well as the winner, the input is
    # sitting between two real countries and must not be resolved.
    for dangerous in DANGEROUS_EXACT:
        if fuzz.WRatio(key, dangerous) >= best_score - 4:
            return None, None, 0.0

    # A close runner-up pointing somewhere else is the same problem.
    if len(matches) > 1:
        second_name, second_score, _ = matches[1]
        if second_score >= best_score - 3 and pool[second_name] != pool[best_name]:
            return None, None, 0.0

    iso = pool[best_name]
    return iso, _canonical(iso), 0.85


def _canonical(iso3: str) -> str | None:
    c = pycountry.countries.get(alpha_3=iso3)
    if not c:
        return None
    return getattr(c, "common_name", None) or c.name
