"""Registered-harness selection, value pinning, and arm configuration equality.

No harness brand is hardwired. `runners.json` registers each supported harness
with the flags that drop the operator's own plugins, memory, and saved model, so
both arms run the same pinned model at the same pinned effort. The resolved
values are recorded before either call and compared field by field afterwards.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .util import run_command

ARM_LOCAL_KEYS = {"arm", "variant", "workspace", "ephemeral_config_dir", "prompt_path"}


@dataclass
class RunnerSpec:
    name: str
    binary: str
    binary_path: str
    version: str
    version_argv: list[str]
    model: str
    effort: str
    cost_telemetry: str
    argv_template: list[str]
    env_template: dict[str, str]
    prompt_mode: str
    budget_usd: float
    timeout_seconds: int
    disallowed_tools: list[str] = field(default_factory=list)

    def fingerprint(self) -> dict[str, Any]:
        """The fields that must be byte-identical across both arms."""
        return {
            "runner": self.name,
            "binary": self.binary,
            "binary_path": self.binary_path,
            "version": self.version,
            "model": self.model,
            "effort": self.effort,
            "cost_telemetry": self.cost_telemetry,
            "argv_template": self.argv_template,
            "env_template_keys": sorted(self.env_template),
            "prompt_mode": self.prompt_mode,
            "budget_usd": self.budget_usd,
            "timeout_seconds": self.timeout_seconds,
        }

    def render_argv(self, substitutions: dict[str, str]) -> list[str]:
        return [self.binary_path] + [_render(token, substitutions) for token in self.argv_template]

    def render_env(self, substitutions: dict[str, str]) -> dict[str, str]:
        return {key: _render(value, substitutions) for key, value in self.env_template.items()}


def _render(token: str, substitutions: dict[str, str]) -> str:
    for key, value in substitutions.items():
        token = token.replace("{" + key + "}", value)
    return token


def load_registry(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def resolve_runner(
    registry: dict[str, Any],
    name: str | None,
    *,
    budget_usd: float,
    timeout_seconds: int,
    model_override: str | None = None,
    effort_override: str | None = None,
) -> RunnerSpec:
    chosen = name or registry["default_runner"]
    if chosen not in registry["runners"]:
        raise SystemExit(
            f"unknown runner {chosen!r}; registered runners: {', '.join(sorted(registry['runners']))}"
        )
    entry = registry["runners"][chosen]
    binary_path = shutil.which(entry["binary"])
    if not binary_path:
        raise SystemExit(f"runner {chosen!r} requires {entry['binary']!r} on PATH")
    version_probe = run_command([binary_path, *entry["version_argv"]], timeout_seconds=120)
    if not version_probe.ok:
        raise SystemExit(f"could not read {chosen} version: {version_probe.tail()}")
    return RunnerSpec(
        name=chosen,
        binary=entry["binary"],
        binary_path=binary_path,
        version=version_probe.stdout.strip().splitlines()[0],
        version_argv=list(entry["version_argv"]),
        model=model_override or entry["model"],
        effort=effort_override or entry["effort"],
        cost_telemetry=entry["cost_telemetry"],
        argv_template=list(entry["argv"]),
        env_template=dict(entry["env"]),
        prompt_mode=entry["prompt_mode"],
        budget_usd=budget_usd,
        timeout_seconds=timeout_seconds,
    )


def arm_configuration(spec: RunnerSpec, arm: str, variant: str) -> dict[str, Any]:
    payload = dict(spec.fingerprint())
    payload["arm"] = arm
    payload["variant"] = variant
    return payload


def configuration_equality(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    """Differences between two arm configurations, ignoring arm-local fields."""
    problems: list[str] = []
    keys = set(left) | set(right)
    for key in sorted(keys - ARM_LOCAL_KEYS):
        if left.get(key) != right.get(key):
            problems.append(f"{key}: {left.get(key)!r} != {right.get(key)!r}")
    return problems
