"""Behavioural tests for exec.py's multi-repo cron loop.

Run:  python3 scripts/test_mergify_admin_requeue_cron_target_repos.py
"""

from __future__ import annotations

import argparse
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scripts.mergify_admin_requeue_exec as exec_impl
from scripts.mergify_admin_requeue_model import DEFAULT_INVOKER_REPO


def base_args(**overrides):
    values = dict(
        once=True,
        loop=False,
        poll_seconds=60,
        dry_run=False,
        repo=DEFAULT_INVOKER_REPO,
        target_repos="",
        author=None,
        state_file="/tmp/ledger.jsonl",
        pr=[],
        max_requeue_attempts=2,
        max_repair_attempts=3,
        json=False,
    )
    values.update(overrides)
    return argparse.Namespace(**values)


class ResolveRulesForRepoTests(unittest.TestCase):
    def test_invoker_repo_reads_local_file_and_never_calls_gh(self):
        gh = mock.Mock()
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), frozenset({"lint"}))) as load:
            result = exec_impl.resolve_rules_for_repo(DEFAULT_INVOKER_REPO, gh)
        load.assert_called_once()
        gh.file_text.assert_not_called()
        gh.default_branch.assert_not_called()
        self.assertEqual(result, ("master", frozenset({"admin-bypass"}), frozenset({"lint"})))

    def test_foreign_repo_falls_back_to_gh_provided_default_branch(self):
        gh = mock.Mock()
        gh.file_text.return_value = None
        gh.default_branch.return_value = "main"
        trunk, labels, required = exec_impl.resolve_rules_for_repo("some-org/catstack", gh)
        gh.file_text.assert_called_once_with("some-org/catstack", ".mergify.yml")
        gh.default_branch.assert_called_once_with("some-org/catstack")
        self.assertEqual(trunk, "main")
        self.assertEqual(required, frozenset())

    def test_foreign_repo_with_no_default_branch_raises_runtime_error(self):
        gh = mock.Mock()
        gh.file_text.return_value = None
        gh.default_branch.return_value = ""
        with self.assertRaises(RuntimeError):
            exec_impl.resolve_rules_for_repo("some-org/catstack", gh)


class RunCronTargetReposTests(unittest.TestCase):
    def test_scans_each_repo_with_its_own_resolved_rules_and_repo_scoped_args(self):
        args = base_args(repo=DEFAULT_INVOKER_REPO)
        seen_repos = []
        seen_rules = []

        def fake_run_cycle(repo_args, claim, release, rules=None):
            seen_repos.append(repo_args.repo)
            seen_rules.append(rules)
            return False

        with mock.patch.object(
            exec_impl, "resolve_rules_for_repo",
            side_effect=lambda repo, gh: (f"trunk-{repo}", frozenset(), frozenset()),
        ), mock.patch.object(exec_impl, "run_cycle", side_effect=fake_run_cycle):
            code = exec_impl.run_cron_target_repos(
                args, [DEFAULT_INVOKER_REPO, "some-org/catstack"], gh=mock.Mock()
            )
        self.assertEqual(code, 0)
        self.assertEqual(seen_repos, [DEFAULT_INVOKER_REPO, "some-org/catstack"])
        self.assertEqual([rules[0] for rules in seen_rules], [f"trunk-{DEFAULT_INVOKER_REPO}", "trunk-some-org/catstack"])
        # The original args object passed in must not be mutated by the loop.
        self.assertEqual(args.repo, DEFAULT_INVOKER_REPO)

    def test_one_repo_rule_resolution_failure_does_not_block_the_others(self):
        args = base_args()
        scanned = []

        def fake_resolve(repo, gh):
            if repo == "broken-org/repo":
                raise RuntimeError("boom")
            return ("master", frozenset(), frozenset())

        with mock.patch.object(exec_impl, "resolve_rules_for_repo", side_effect=fake_resolve), \
             mock.patch.object(exec_impl, "run_cycle", side_effect=lambda a, c, r, rules=None: scanned.append(a.repo)):
            code = exec_impl.run_cron_target_repos(
                args, ["broken-org/repo", DEFAULT_INVOKER_REPO], gh=mock.Mock()
            )
        self.assertEqual(scanned, [DEFAULT_INVOKER_REPO])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
