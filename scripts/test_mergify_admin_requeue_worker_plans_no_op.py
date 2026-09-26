from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WORKER_PLAN_SOURCES = sorted(
    [*REPO.glob("scripts/cron-pr-*.sh"), *REPO.glob("scripts/mergify_admin_requeue*.py")],
)
ON_FINISH_NONE = re.compile(r"onFinish: none")
NO_OP = re.compile(r"mergeMode: no_op")


class WorkerPlansUseNoOpMerge(unittest.TestCase):
    def test_sources_were_found(self):
        self.assertGreater(len(WORKER_PLAN_SOURCES), 0)

    def test_every_worker_plan_that_publishes_nothing_skips_the_merge_gate(self):
        offenders = []
        for path in WORKER_PLAN_SOURCES:
            if path.name.startswith("test_"):
                continue
            lines = path.read_text(encoding="utf-8").splitlines()
            for index, line in enumerate(lines):
                if ON_FINISH_NONE.search(line) and not any(NO_OP.search(near) for near in lines[index:index + 4]):
                    offenders.append(f"{path.relative_to(REPO)}:{index + 1}")
        self.assertEqual(offenders, [], "worker plans with onFinish: none must also set mergeMode: no_op")


if __name__ == "__main__":
    unittest.main()
