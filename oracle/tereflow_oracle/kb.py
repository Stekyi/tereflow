"""Product and by-product knowledge base.

Every relationship is a candidate that is CHECKED, not trusted:
  codes_checked       both HS codes exist in the official nomenclature wording held in tf_hs6_name
  derivation_checked  the by-product's official wording names the derivation (a keyword stated per relationship)
  trade_evidence      recorded exports of the by-product code across the countries Tereflow holds

Confidence and status are computed from those checks:
  verified    codes exist AND the wording states the derivation
  plausible   codes exist but the wording does not state the derivation (standard processing knowledge, not yet
              tied to a cited source)
  unverified  no code to check, or a code that is not in the nomenclature
  rejected    a relationship from an earlier list that the checks showed to be wrong; kept so it is not re-added
  established = the official wording of the by-product states the derivation (confidence verified) AND the code has
  recorded international trade of at least ESTABLISHED_USD. Trade alone does not make a link established:
  a heading such as "ethyl alcohol" is traded whatever it is made from. Otherwise possible. A residue
  that is technically usable is not "established" until somebody trades it.

The process and applications text is general knowledge and is flagged detail_sourced = 0 until it is tied to a
cited source. The classification, the derivation wording and the trade figures are the verified parts.

Source of the HS wording: UN Comtrade reference file, https://comtradeapi.un.org/files/v1/app/reference/HS.json
"""
from __future__ import annotations
from datetime import date

ESTABLISHED_USD = 1_000_000
HS_SOURCE_NAME = "UN Comtrade HS reference (official commodity wording)"
HS_SOURCE_URL = "https://comtradeapi.un.org/files/v1/app/reference/HS.json"

# parent codes may be 4 or 6 digits; a 6-digit match is preferred over a 4-digit one when a page is shown.
# kw = words that must appear in the BY-PRODUCT's official wording for the derivation to count as stated.
# status "rejected" records a relationship from an earlier list that the checks showed to be wrong.
C = []


def rel(parents, parent_name, by_code, by_name, kind, process, apps, kw=(), rejected=None, note=None):
    for p in parents:
        C.append(dict(parent_code=p, parent_name=parent_name, byproduct_code=by_code, byproduct_name=by_name, kind=kind,
                      process=process, applications=apps, kw=list(kw), rejected=rejected, note=note))


# ---- cocoa
rel(["180100"], "Cocoa beans", "180200", "Cocoa shells, husks and other cocoa waste", "residue", "Removed from the bean when it is winnowed and processed.", "Mulch, fuel, animal feed and fibre uses are reported; economic viability varies.", ["shells", "husks", "waste"])
rel(["180100"], "Cocoa beans", "180310", "Cocoa paste, not defatted", "processed", "Beans are roasted, shelled and ground to a liquor.", "Raw material for butter, powder and chocolate.", ["paste"])
rel(["180100"], "Cocoa beans", "180320", "Cocoa paste, wholly or partly defatted", "processed", "Part of the fat is pressed out of the paste.", "Raw material for cocoa powder.", ["paste", "defatted"])
rel(["180100"], "Cocoa beans", "180400", "Cocoa butter, fat and oil", "processed", "Pressed from cocoa paste.", "Chocolate, confectionery, cosmetics.", ["butter"])
rel(["180100"], "Cocoa beans", "180500", "Cocoa powder (unsweetened)", "processed", "Ground from the cake left after the butter is pressed out.", "Baking, drinks, confectionery.", ["powder"])
rel(["180100"], "Cocoa beans", "1806", "Chocolate and other cocoa food preparations", "downstream", "Cocoa products are blended with sugar and other ingredients.", "Finished confectionery and chocolate goods.", ["chocolate", "cocoa"])
# ---- cashew
rel(["080131"], "Cashew nuts in shell", "080132", "Cashew kernels (shelled cashews)", "processed", "The shell is cracked and the kernel is separated and peeled.", "The edible kernel, which is the higher-value form.", ["shelled"])
rel(["080131"], "Cashew nuts in shell", "200819", "Roasted or prepared nuts", "downstream", "Kernels are roasted, salted or flavoured.", "Snack and retail nut products.", [])
rel(["080131"], "Cashew nuts in shell", None, "Cashew nut shell liquid", "byproduct", "Extracted from the shell.", "Industrial resins, coatings and friction materials are reported uses.", [], None,
    "The earlier list placed this under heading 1515 without checking. Its HS classification is not confirmed, so it has no code and cannot be traded-checked.")
rel(["080131"], "Cashew nuts in shell", "0802", "Other nuts, shelled or in shell", "processed", "-", "-", ["cashew"], "Shelled cashew is classified 080132 under heading 0801, not 0802. The earlier list used the wrong heading.")
# ---- shea
rel(["120799"], "Shea nuts", "151590", "Shea butter and other fixed vegetable fats", "processed", "Nuts are dried, crushed and the fat is extracted.", "Cosmetics, confectionery fat substitute, cooking fat.", [], None,
    "Heading 120799 holds several oilseeds besides shea, and the official wording of 151590 does not name shea, so this link cannot be machine-checked.")
rel(["120799"], "Shea nuts", "230690", "Oil cake from other oil seeds (shea cake)", "residue", "Left after the fat is extracted.", "Reported as animal feed or fuel; feed use is limited by tannin content.", [], None,
    "The wording is generic ('n.e.c.'), so this link cannot be machine-checked.")
# ---- coconut
rel(["080119", "080112"], "Coconuts", "151311", "Coconut (copra) oil, crude", "processed", "Copra is dried and pressed, or the oil is extracted from fresh kernel.", "Food, soap, cosmetics, biofuel.", ["coconut", "copra"])
rel(["080119", "080112"], "Coconuts", "230650", "Copra oil cake", "residue", "Left after copra oil is pressed out.", "Animal feed.", ["coconut", "copra"])
rel(["080119", "080112"], "Coconuts", "530500", "Coconut fibre (coir)", "byproduct", "Fibre is separated from the husk.", "Rope, mats, brushes, growing media.", ["coconut"])
# ---- palm
rel(["120710"], "Palm nuts and kernels", "151321", "Palm kernel oil, crude", "processed", "Kernels are separated from the nut and pressed.", "Food, soap, cosmetics, oleochemicals.", ["palm kernel"])
rel(["120710"], "Palm nuts and kernels", "230660", "Palm kernel cake", "residue", "Left after palm kernel oil is pressed out.", "Animal feed.", ["palm nuts or kernels"])
rel(["151110"], "Palm oil", "151321", "Palm kernel oil", "processed", "-", "-", ["palm kernel"], "Palm kernel oil comes from the kernel (120710), not from palm oil. The earlier list gave the wrong parent.")
rel(["151110"], "Palm oil", "230660", "Palm kernel cake", "residue", "-", "-", ["palm nuts or kernels"], "Palm kernel cake comes from the kernel (120710), not from palm oil. The earlier list gave the wrong parent.")
# ---- cassava
rel(["071410"], "Cassava (manioc) roots", "110814", "Cassava starch", "processed", "Roots are washed, grated and the starch is separated.", "Food, paper, textiles, adhesives.", ["manioc", "cassava"])
rel(["071410"], "Cassava (manioc) roots", "110620", "Flour of roots and tubers", "processed", "Roots are dried and milled.", "Flour and composite flours.", ["roots or tubers"])
rel(["071410"], "Cassava (manioc) roots", "190300", "Tapioca", "downstream", "Starch is heated into flakes or pearls.", "Food ingredient.", [])
# ---- rice
rel(["1006"], "Rice", "121300", "Cereal straw and husks", "residue", "Husk is removed from paddy rice.", "Fuel, bedding, silica; economic use varies.", ["husks"], None,
    "Relationships start from paddy (100610); milled rice (100630) has already had its husk and bran removed.")
rel(["1006"], "Rice", "230240", "Bran and other cereal milling residues", "residue", "Bran is removed when rice is milled.", "Animal feed, rice bran oil.", [], None, "The wording says 'other cereals' and does not name rice, so this link cannot be machine-checked.")
rel(["1006"], "Rice", "100640", "Broken rice", "byproduct", "Grains broken during milling are separated.", "Lower-value rice, flour, brewing.", ["broken"])
rel(["1006"], "Rice", "110290", "Cereal flours other than wheat or maize (rice flour)", "processed", "Milled rice is ground.", "Flour, noodles, baby food.", [], None, "The wording does not name rice, so this link cannot be machine-checked.")
# ---- maize
rel(["1005"], "Maize (corn)", "110812", "Maize starch", "processed", "Wet milling separates the starch.", "Food, paper, adhesives.", ["maize"])
rel(["1005"], "Maize (corn)", "110220", "Maize flour", "processed", "Dry milling.", "Food staple.", ["maize"])
rel(["1005"], "Maize (corn)", "230210", "Maize bran and milling residues", "residue", "Removed during milling.", "Animal feed.", ["maize"])
rel(["1005"], "Maize (corn)", "151521", "Maize (corn) oil, crude", "processed", "Pressed from the germ.", "Cooking oil, margarine.", ["maize"])
rel(["1005"], "Maize (corn)", "230310", "Residues of starch manufacture", "residue", "Left after the starch is separated.", "Animal feed.", [], None, "The wording does not name maize, so this link cannot be machine-checked.")
# ---- sugar
rel(["1701"], "Sugar", "1703", "Molasses", "byproduct", "Left after sugar is crystallised.", "Animal feed, fermentation.", ["molasses"])
rel(["1701"], "Sugar", "230320", "Bagasse and other sugar waste", "residue", "Fibre left after juice extraction.", "Fuel, board, pulp.", ["bagasse"])
rel(["1701"], "Sugar", "2207", "Ethyl alcohol", "downstream", "Molasses is fermented and distilled.", "Fuel, spirits, industrial alcohol.", [], None, "The wording does not name molasses, so this link cannot be machine-checked.")
# ---- oilseeds
rel(["1201"], "Soya beans", "150710", "Soya-bean oil", "processed", "Pressed or solvent-extracted.", "Cooking oil, biodiesel.", ["soya"])
rel(["1201"], "Soya beans", "230400", "Soya-bean oil cake", "residue", "Left after the oil is extracted.", "Protein animal feed.", ["soya"])
rel(["1202"], "Groundnuts", "1508", "Ground-nut oil", "processed", "Pressed from shelled nuts.", "Cooking oil.", ["ground-nut"])
rel(["1202"], "Groundnuts", "230500", "Ground-nut oil cake", "residue", "Left after the oil is extracted.", "Animal feed.", ["ground-nut"])
rel(["5201"], "Cotton", "151221", "Cotton-seed oil, crude", "processed", "Pressed from the seed left after ginning.", "Cooking oil, industrial uses.", ["cotton-seed"])
rel(["5201"], "Cotton", "230610", "Cotton-seed oil cake", "residue", "Left after the oil is extracted.", "Animal feed.", ["cotton seed"])
# ---- fish, wood, hides, coffee, tomato, citrus
rel(["0303"], "Fish", "230120", "Fish meal", "residue", "Made from waste fish and trimmings.", "Animal feed.", ["fish"])
rel(["0303"], "Fish", "150420", "Fish oils and fats", "residue", "Pressed from fish and trimmings.", "Feed, nutrition products.", ["fish"])
rel(["4403"], "Logs", "4407", "Sawn wood", "processed", "Logs are sawn.", "Construction, furniture.", ["sawn"])
rel(["4403"], "Logs", "440290", "Wood charcoal", "byproduct", "Wood or offcuts are carbonised.", "Fuel.", ["charcoal"])
rel(["4403"], "Logs", "441011", "Particle board", "byproduct", "Chips and sawmill waste are bonded.", "Furniture, panels.", [], None, "The wording does not state it comes from sawmill waste, so this link cannot be machine-checked.")
rel(["4101"], "Raw hides and skins", "4104", "Tanned hides and skins", "processed", "Hides are tanned.", "Leather goods.", ["tanned"])
rel(["0901"], "Coffee", "090121", "Roasted coffee", "processed", "Beans are roasted.", "Retail coffee.", ["roasted"])
rel(["0901"], "Coffee", "210111", "Coffee extracts and instant coffee", "downstream", "Roasted coffee is extracted and dried.", "Soluble coffee.", ["coffee"])
rel(["0702"], "Tomatoes", "2002", "Prepared or preserved tomatoes", "processed", "Cooked into paste or canned.", "Paste, sauces, canned goods.", ["tomatoes"])
rel(["0805"], "Citrus fruit", "330119", "Citrus essential oils", "byproduct", "Oil is pressed from the peel.", "Flavours, fragrances.", ["citrus"])
rel(["0805"], "Citrus fruit", "2009", "Fruit and vegetable juices", "processed", "Fruit is pressed.", "Juice and concentrate.", [], None, "The wording does not name citrus at heading level, so this link cannot be machine-checked.")
rel(["0803", "0804"], "Bananas, mangoes and tropical fruit", "2008", "Prepared or preserved fruit", "processed", "Fruit is dried, canned or pulped.", "Dried fruit, pulp, canned fruit.", [], None, "Heading-level relationship; the wording is generic, so this link cannot be machine-checked.")
rel(["0803", "0804"], "Bananas, mangoes and tropical fruit", "2009", "Fruit juices", "processed", "Fruit is pressed.", "Juice and concentrate.", [], None, "Heading-level relationship; the wording is generic, so this link cannot be machine-checked.")
rel(["0803"], "Bananas", "110630", "Flour of fruit (banana flour)", "processed", "Fruit is dried and milled.", "Flour.", [], None, "Heading-level relationship; the wording is generic, so this link cannot be machine-checked.")


def names_under(code, names: dict) -> list[str]:
    """Official wording of every code at or under a 4 or 6 digit code."""
    return [n for c, n in names.items() if code and c.startswith(code)]


def assess(r: dict, names: dict, trade: dict) -> dict:
    """Confidence, status and evidence for one candidate. Pure: the caller supplies the official wording and trade."""
    parent_words = names_under(r["parent_code"], names)
    by_words = names_under(r["byproduct_code"], names) if r["byproduct_code"] else []
    codes_checked = bool(parent_words) and bool(by_words)
    text = " ".join(by_words).lower()
    derivation = codes_checked and bool(r["kw"]) and any(k.lower() in text for k in r["kw"])
    t = trade.get(r["byproduct_code"]) if r["byproduct_code"] else None
    usd = t["usd"] if t else None
    if r["rejected"]:
        # A relationship shown to be wrong carries no supporting trade: that figure would read as evidence for it.
        confidence, status, t, usd = "rejected", "rejected", None, None
    else:
        confidence = "verified" if derivation else "plausible" if codes_checked else "unverified"
        # Established needs BOTH the wording to state the derivation AND recorded trade in the code. Trade alone is
        # not enough: a heading such as "ethyl alcohol" is traded whatever it is made from.
        status = "established" if (derivation and (usd or 0) >= ESTABLISHED_USD) else "possible"
    return {
        "codes_checked": int(codes_checked), "derivation_checked": int(derivation),
        "confidence": confidence, "status": status,
        "parent_official": parent_words[0] if parent_words else None,
        "byproduct_official": by_words[0] if by_words else None,
        "trade_usd": usd, "trade_year": t["year"] if t else None, "trade_reporters": t["reporters"] if t else None,
    }


def sql_str(v) -> str:
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def to_sql(rows: list[dict], names: dict, trade: dict, today: str | None = None) -> str:
    today = today or date.today().isoformat()
    out = ["DELETE FROM kb_relationship;"]
    for r in rows:
        a = assess(r, names, trade)
        rid = f"{r['parent_code']}>{r['byproduct_code'] or r['byproduct_name'].lower().replace(' ', '-')}"
        if a["trade_usd"] is not None:
            tnote = f"Recorded exports of this code in {a['trade_year']} across {a['trade_reporters']} of the countries Tereflow holds."
        elif r["byproduct_code"]:
            tnote = "No exports of this code are recorded for the countries Tereflow holds."
        else:
            tnote = "No HS code, so no trade can be checked."
        ev = []
        if a["codes_checked"]:
            ev.append("Both HS codes exist in the official nomenclature.")
        if a["derivation_checked"]:
            ev.append("The official wording of the by-product states the derivation.")
        if r["rejected"]:
            ev = [r["rejected"]]
        elif r["note"]:
            ev.append(r["note"])
        out.append(
            "INSERT OR REPLACE INTO kb_relationship (id, parent_name, parent_code, byproduct_name, byproduct_code, kind, process_method, applications, "
            "detail_sourced, status, confidence, parent_hs_official, byproduct_hs_official, hs_codes_checked, derivation_checked, "
            "trade_evidence_usd, trade_evidence_year, trade_evidence_note, evidence_note, source_name, source_url, verified_at) VALUES ("
            + ", ".join([
                sql_str(rid), sql_str(r["parent_name"]), sql_str(r["parent_code"]), sql_str(r["byproduct_name"]), sql_str(r["byproduct_code"]),
                sql_str(r["kind"]), sql_str(None if r["rejected"] else r["process"]), sql_str(None if r["rejected"] else r["applications"]),
                "0", sql_str(a["status"]), sql_str(a["confidence"]), sql_str(a["parent_official"]), sql_str(a["byproduct_official"]),
                str(a["codes_checked"]), str(a["derivation_checked"]),
                "NULL" if a["trade_usd"] is None else repr(round(a["trade_usd"], 2)), "NULL" if a["trade_year"] is None else str(a["trade_year"]),
                sql_str(tnote), sql_str(" ".join(ev) or None), sql_str(HS_SOURCE_NAME), sql_str(HS_SOURCE_URL), sql_str(today),
            ]) + ");")
    return "\n".join(out) + "\n"


def load_names(conn) -> dict:
    cur = conn.cursor()
    cur.execute("SELECT code, name FROM tf_hs6_name")
    return {c: n for c, n in cur}


def load_trade(conn, rows: list[dict], year: int = 2025) -> dict:
    """Recorded exports per by-product code, from the pre-aggregated product totals, with how many countries report it."""
    cur = conn.cursor()
    out = {}
    for code in sorted({r["byproduct_code"] for r in rows if r["byproduct_code"]}):
        cur.execute("""SELECT NVL(SUM(all_partner_value_usd), 0), COUNT(DISTINCT reporter_iso3)
                         FROM tf_product_totals WHERE flow = 'X' AND year = :y AND hs_code LIKE :c || '%'
                          AND all_partner_value_usd > 0""", {"y": year, "c": code})
        usd, n = cur.fetchone()
        if n:
            out[code] = {"usd": float(usd), "year": year, "reporters": int(n)}
    return out
