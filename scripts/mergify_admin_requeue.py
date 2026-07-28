#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import sys


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    package_root = repo_root / "packages" / "mergify-admin-requeue"
    env = os.environ.copy()
    pythonpath = str(package_root)
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env["PYTHONPATH"] = pythonpath
    os.execvpe("python3", ["python3", "-m", "mergify_admin_requeue", *sys.argv[1:]], env)


if __name__ == "__main__":
    main()
