Loop instructions for the current deadlock/race investigation:

1. Run `./run.sh`. If it does not succeed, debug and fix it.
2. In parallel, change the agent to be a Codex task.
3. In parallel, rebase and retry every workflow.
4. For every task, make sure it does not take longer than 15 minutes.
5. Do not quit early. Wait until the 15 minute limit.
6. If a task times out after 15 minutes, inspect the logs. Treat it as a bug, usually a deadlock. Investigate and create a repro case.
7. If the repro case is unclear, add logging and go back to step 1.
8. If a task fails, treat it as a bug if it did not retry automatically with Claude three times. Investigate, fix, and go back to step 1.
9. If the deadlock failure is understood and reproducible, plan and implement a fix. Prove it by rerunning the repro case. Then commit and go back to step 1.
10. Do not stop this loop until all workflows are able to succeed to the merge gates.

Critical constraints:

- Do not touch repo pool locks.
- Keep this file available for future compactions and continue following it.
