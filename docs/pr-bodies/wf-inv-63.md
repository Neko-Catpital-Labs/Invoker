## Summary

This PR realigns the `plan-to-invoker` skill with its `.cursor` mirror and tightens the skill-doctor checks so docs drift cannot silently land again.

The positive fixture for `07-prompt-edit-layered-split-with-dormant.yaml` now covers the documented rules end-to-end, so the targeted skill verification exercises every requirement that SKILL.md states.

Companion wiring in `packages/app/src/api-server.ts` and `packages/workflow-core/src/orchestrator.ts` keeps the api-server and orchestrator tests aligned with the new fixture surface.

## Test Plan

- [ ] `bash scripts/test-plan-to-invoker-skill.sh`
- [ ] `pnpm run test:all`

## Revert Plan

- Safe to revert? Yes
- Revert command: `git revert <sha>`
- Post-revert steps: None
- Data migration? No
