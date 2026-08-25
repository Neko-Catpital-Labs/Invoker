#!/usr/bin/env python3
"""Multi-repo admin-bypass worker coverage."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from mergify_admin_requeue_async_repair import repair_bot_thread_plan_name, repair_check_plan_name
from mergify_admin_requeue_exec import parse_args, resolve_repo_merge_policy, run_once
from mergify_admin_requeue_model import DEFAULT_INVOKER_REPO, Ledger, RepoMergePolicy, parse_mergify_admin_bypass_rules


class MultiRepoParseArgsTest(unittest.TestCase):
    def test_repeatable_repo_flags(self) -> None:
        args = parse_args([
            "--once",
            "--repo", "Neko-Catpital-Labs/Invoker",
            "--repo", "EdbertChan/catstack",
        ])
        self.assertEqual(
            args.repos,
            ["Neko-Catpital-Labs/Invoker", "EdbertChan/catstack"],
        )
        self.assertEqual(args.repo, "Neko-Catpital-Labs/Invoker")

    def test_default_repo_when_omitted(self) -> None:
        args = parse_args(["--once"])
        self.assertEqual(args.repos, [DEFAULT_INVOKER_REPO])
        self.assertEqual(args.repo, DEFAULT_INVOKER_REPO)


class LedgerRepoIsolationTest(unittest.TestCase):
    def test_legacy_rows_match_invoker_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            path.write_text(
                '{"kind":"x","pr":1,"headSha":"h","key":"k","epoch":1}\n',
                encoding="utf-8",
            )
            invoker = Ledger(path, repo=DEFAULT_INVOKER_REPO)
            catstack = Ledger(path, repo="EdbertChan/catstack")
            self.assertEqual(invoker.count("x", 1, "h", "k"), 1)
            self.assertEqual(catstack.count("x", 1, "h", "k"), 0)

    def test_new_rows_do_not_collide_across_repos(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"
            invoker = Ledger(path, repo=DEFAULT_INVOKER_REPO)
            catstack = Ledger(path, repo="EdbertChan/catstack")
            invoker.record("repair-bot-thread", 42, "abc", "thread-1")
            catstack.record("repair-bot-thread", 42, "abc", "thread-1")
            invoker2 = Ledger(path, repo=DEFAULT_INVOKER_REPO)
            catstack2 = Ledger(path, repo="EdbertChan/catstack")
            self.assertEqual(invoker2.count("repair-bot-thread", 42, "abc", "thread-1"), 1)
            self.assertEqual(catstack2.count("repair-bot-thread", 42, "abc", "thread-1"), 1)
            raw = path.read_text(encoding="utf-8")
            self.assertIn(DEFAULT_INVOKER_REPO, raw)
            self.assertIn("EdbertChan/catstack", raw)


class PlanNameRepoSlugTest(unittest.TestCase):
    def test_invoker_keeps_legacy_plan_name(self) -> None:
        self.assertEqual(
            repair_bot_thread_plan_name(42, "abcdef0123"),
            "admin-bypass-repair-bot-thread-pr-42-abcdef0",
        )
        self.assertEqual(
            repair_bot_thread_plan_name(42, "abcdef0123", repo=DEFAULT_INVOKER_REPO),
            "admin-bypass-repair-bot-thread-pr-42-abcdef0",
        )

    def test_other_repo_includes_slug(self) -> None:
        name = repair_bot_thread_plan_name(42, "abcdef0123", repo="EdbertChan/catstack")
        self.assertEqual(
            name,
            "admin-bypass-repair-bot-thread-edbertchan-catstack-pr-42-abcdef0",
        )
        check = repair_check_plan_name(7, "PR Body", "deadbeef", repo="EdbertChan/catstack")
        self.assertIn("edbertchan-catstack", check)


class RepoMergePolicyTest(unittest.TestCase):
    def test_missing_admin_bypass_falls_back_to_default_branch(self) -> None:
        gh = mock.Mock()
        gh.fetch_file_contents.return_value = "queue_rules:\n  - name: other\n"
        gh.default_branch.return_value = "main"
        policy = resolve_repo_merge_policy(gh, "EdbertChan/catstack")
        self.assertEqual(policy.trunk, "main")
        self.assertFalse(policy.has_admin_bypass_queue)
        self.assertEqual(policy.required_checks, frozenset())

    def test_parses_admin_bypass_from_fetched_text(self) -> None:
        text = Path(".mergify.yml").read_text(encoding="utf-8")
        trunk, labels, required = parse_mergify_admin_bypass_rules(text)
        self.assertEqual(trunk, "master")
        self.assertIn("admin-bypass", labels)
        self.assertTrue(required)

        gh = mock.Mock()
        gh.fetch_file_contents.return_value = text
        policy = resolve_repo_merge_policy(gh, "EdbertChan/catstack")
        self.assertTrue(policy.has_admin_bypass_queue)
        self.assertEqual(policy.trunk, trunk)
        self.assertEqual(policy.required_checks, required)


class RunOnceFailSoftTest(unittest.TestCase):
    def test_one_repo_failure_does_not_abort_others(self) -> None:
        calls: list[str] = []

        def fake_cycle(args, *_rest):
            calls.append(args.repo)
            if args.repo == "bad/repo":
                raise RuntimeError("boom")
            return False

        args = parse_args([
            "--once",
            "--repo", "bad/repo",
            "--repo", "EdbertChan/catstack",
        ])
        with mock.patch("mergify_admin_requeue_exec.run_cycle", side_effect=fake_cycle):
            code = run_once(args)
        self.assertEqual(code, 0)
        self.assertEqual(calls, ["bad/repo", "EdbertChan/catstack"])


if __name__ == "__main__":
    unittest.main()
