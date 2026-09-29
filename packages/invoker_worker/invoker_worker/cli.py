from __future__ import annotations

import json
import sys
from typing import Any

from invoker_worker.idle_task_cleanup import IdleTaskCleanupWorker
from invoker_worker.requeue import RequeueWorker

WORKERS = {
    RequeueWorker.kind: RequeueWorker,
    IdleTaskCleanupWorker.kind: IdleTaskCleanupWorker,
}


def main(argv: list[str] | None = None) -> int:
    _ = argv
    payload = json.load(sys.stdin)
    kind = payload.get("kind")
    if kind not in WORKERS:
        json.dump({"error": f"unknown kind: {kind}"}, sys.stdout)
        return 2
    worker = WORKERS[kind]()
    ctx: dict[str, Any] = {"state": payload.get("state") or {}}
    decisions = worker.tick(ctx)
    json.dump({"decisions": decisions}, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
