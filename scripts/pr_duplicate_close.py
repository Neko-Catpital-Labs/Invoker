#!/usr/bin/env python3
from __future__ import annotations

import sys
from typing import Sequence

try:
    from . import pr_duplicate_close_exec as exec_impl
except ImportError:
    import pr_duplicate_close_exec as exec_impl

parse_args = exec_impl.parse_args
run_once = exec_impl.run_once
run_loop = exec_impl.run_loop
REPO_ROOT = exec_impl.REPO_ROOT


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    return run_loop(args) if args.loop else run_once(args)


if __name__ == "__main__":
    raise SystemExit(main())
