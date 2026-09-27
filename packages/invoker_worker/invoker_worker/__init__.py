from __future__ import annotations

from typing import Any, Literal, TypedDict


class SkipDecision(TypedDict, total=False):
    type: Literal["skip"]
    reason: str


class MutationDecision(TypedDict, total=False):
    type: Literal["mutation"]
    workflowId: str
    channel: str
    args: list[Any]
    priority: str


class EffectDecision(TypedDict, total=False):
    type: Literal["effect"]
    name: str
    detail: Any


WorkerDecision = SkipDecision | MutationDecision | EffectDecision


class Worker:
    kind: str = ""

    def read_state(self, ctx: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def decide(self, state: dict[str, Any], ctx: dict[str, Any]) -> list[WorkerDecision]:
        raise NotImplementedError

    def execute_effect(
        self,
        decision: WorkerDecision,
        state: dict[str, Any],
        ctx: dict[str, Any],
    ) -> None:
        return None

    def tick(self, ctx: dict[str, Any]) -> list[WorkerDecision]:
        state = self.read_state(ctx)
        decisions = self.decide(state, ctx)
        for decision in decisions:
            if decision.get("type") == "effect":
                self.execute_effect(decision, state, ctx)
        return decisions
