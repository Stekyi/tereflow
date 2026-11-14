from tereflow_oracle.inbox import parse

HEAD = "partner_iso3,hs_code,description,value_usd,net_weight_kg,qty,qty_unit\n"


def test_good_file():
    iso, y, f, rows, problems = parse("ETH_2024_X.csv", HEAD + "WLD,180100,Cocoa beans,1000,5,,\nGHA,180100,Cocoa beans,50,,,\n", 2026)
    assert (iso, y, f, len(rows), problems) == ("ETH", 2024, "X", 2, [])


def test_refuses_bad_rows_and_names():
    assert parse("eth.csv", HEAD, 2026)[4]
    p = parse("ETH_2024_M.csv", HEAD + "WLD,1801,x,1,,,\nWLD,180100,x,abc,,,\nWLD,180100,x,1,,,\nWLD,180100,x,1,,,\n", 2026)[4]
    assert len(p) == 4
    assert parse("ETH_2024_M.csv", "a,b\n1,2\n", 2026)[4][0].startswith("missing column")
    assert parse("ETH_2031_M.csv", HEAD + "WLD,180100,x,1,,,\n", 2026)[4]
