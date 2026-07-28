#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    package_path = repo_root / "packages" / "mergify-admin-requeue"

    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    env["PYTHONPATH"] = (
        str(package_path)
        if not existing_pythonpath
        else f"{package_path}{os.pathsep}{existing_pythonpath}"
    )

    os.execvpe("python3", ["python3", "-m", "mergify_admin_requeue", *sys.argv[1:]], env)


if __name__ == "__main__":
    main()
