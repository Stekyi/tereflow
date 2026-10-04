"""Define the Tereflow ORDS module, its OAuth2 privilege and the Worker's client.

Run: python -m tereflow_oracle define-ords
Handlers live in oracle/ords/handlers/*.plsql. Everything here is idempotent: the module is
rebuilt from the files each time, the role, privilege and client are created once.
"""
from __future__ import annotations
from pathlib import Path

HANDLERS = Path(__file__).resolve().parents[1] / "ords" / "handlers"
MODULE = "tf_api"
BASE = "/tf/"
ROUTES = [
    ("dashboard/:iso3", "dashboard.plsql"),
    ("blue-oceans/:iso3", "blue_oceans.plsql"),
    ("lines/:iso3", "lines.plsql"),
    ("sandbox", "sandbox.plsql"),
]
ROLE, PRIVILEGE, CLIENT = "tf_reader", "tf_read", "tereflow_worker"


def define_module(conn) -> None:
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM user_ords_modules WHERE name = :1", [MODULE])
    if cur.fetchone()[0]:
        cur.execute("BEGIN ORDS.DELETE_MODULE(p_module_name => :1); END;", [MODULE])
    cur.execute("""BEGIN ORDS.DEFINE_MODULE(p_module_name => :m, p_base_path => :b, p_items_per_page => 0,
                   p_status => 'PUBLISHED', p_comments => 'Tereflow read API served from precomputed Oracle data'); END;""",
                {"m": MODULE, "b": BASE})
    for pattern, fname in ROUTES:
        src = (HANDLERS / fname).read_text(encoding="utf-8")
        cur.execute("BEGIN ORDS.DEFINE_TEMPLATE(p_module_name => :m, p_pattern => :p); END;", {"m": MODULE, "p": pattern})
        cur.execute("""BEGIN ORDS.DEFINE_HANDLER(p_module_name => :m, p_pattern => :p, p_method => 'GET',
                       p_source_type => ORDS.source_type_plsql, p_items_per_page => 0, p_source => :s); END;""",
                    {"m": MODULE, "p": pattern, "s": src})
    conn.commit()


def define_security(conn) -> tuple[str, str]:
    """Create the role, privilege and OAuth2 client (client_credentials). Returns (client_id, client_secret)."""
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM user_ords_roles WHERE name = :1", [ROLE])
    if not cur.fetchone()[0]:
        cur.execute("BEGIN ORDS.CREATE_ROLE(p_role_name => :1); END;", [ROLE])
    cur.execute("SELECT COUNT(*) FROM user_ords_privileges WHERE name = :1", [PRIVILEGE])
    if not cur.fetchone()[0]:
        cur.execute("BEGIN ORDS.CREATE_PRIVILEGE(p_name => :p, p_role_name => :r, p_label => 'Tereflow read', "
                    "p_description => 'Read access to the Tereflow API'); END;", {"p": PRIVILEGE, "r": ROLE})
        cur.execute("BEGIN ORDS.CREATE_PRIVILEGE_MAPPING(p_privilege_name => :p, p_pattern => '/tf/*'); END;", {"p": PRIVILEGE})
    cur.execute("SELECT COUNT(*) FROM user_ords_clients WHERE name = :1", [CLIENT])
    if not cur.fetchone()[0]:
        cur.execute("""BEGIN OAUTH.CREATE_CLIENT(p_name => :n, p_grant_type => 'client_credentials', p_owner => 'Tereflow',
                       p_description => 'Cloudflare Worker reading the Tereflow API', p_support_email => 'noreply@tiwaak.com',
                       p_privilege_names => :p); END;""", {"n": CLIENT, "p": PRIVILEGE})
        cur.execute("BEGIN OAUTH.GRANT_CLIENT_ROLE(p_client_name => :n, p_role_name => :r); END;", {"n": CLIENT, "r": ROLE})
    conn.commit()
    cur.execute("SELECT client_id, client_secret FROM user_ords_clients WHERE name = :1", [CLIENT])
    return cur.fetchone()
