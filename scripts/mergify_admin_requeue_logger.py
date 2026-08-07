from __future__ import annotations

import json
import sys
from typing import Mapping, Sequence

try:
    from .mergify_admin_requeue_model import Action
except ImportError:
    from mergify_admin_requeue_model import Action


class AdminBypassLogger:
    def trace(self, event: str, **fields: object) -> None:
        payload = {"event": event, **fields}
        print(f"TRACE {json.dumps(payload, sort_keys=True)}", file=sys.stderr)

    def error(self, event: str, **fields: object) -> None:
        payload = {"event": event, **fields}
        print(f"ERROR {json.dumps(payload, sort_keys=True)}", file=sys.stderr)

    def action_payload(self, action: Action) -> dict[str, object]:
        return {
            "kind": action.kind,
            "pr_number": action.pr_number,
            "key": action.key,
            "detail": action.detail,
        }

    def stack_action_payload(self, actions: Sequence[Action]) -> list[dict[str, object]]:
        return [self.action_payload(action) for action in actions]

    def stack(self, event: str, summary: Mapping[str, object], **fields: object) -> None:
        self.trace(event, **fields, summary=summary)
