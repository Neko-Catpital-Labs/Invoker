## Summary

This change eliminates drift between the plan-to-invoker skill documentation, its .cursor mirror, the skill-doctor script, and the layered-split example fixture so they describe one behavior.

Aligning the skill artifacts keeps reviewers reading a single canonical source of truth and removes the small contradictions that were misleading downstream workflow authors.

Targeted skill tests and the full repository regression both confirm the documentation and supporting scripts agree after this drift-elimination update.

## Test Plan

- [ ] `bash scripts/test-plan-to-invoker-skill.sh`
- [ ] `pnpm run test:all`

## Revert Plan

- Safe to revert? Yes
- Revert command: `git revert <sha>`
- Post-revert steps: None
- Data migration? No
