"""Environment loading. Secrets come from the environment or a gitignored .env."""
from __future__ import annotations
import os
from pathlib import Path


def load_env(path: str | None = None) -> None:
    candidates = [Path(path)] if path else [Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"]
    for p in candidates:
        if p.is_file():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            return


def need(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise RuntimeError(f"{name} is not set. Add it to .env or the environment.")
    return v
