# Local Live CLI Submission Smoke Test

Use this live CLI submission smoke test to verify the local headless path end to end.

1. Start a standalone owner process in a separate terminal.
2. Create a tiny disposable plan YAML with one low-risk task.
3. Submit it with:

   ```bash
   ./run.sh --headless run /path/to/plan.yaml
   ```

4. Confirm it appears with:

   ```bash
   ./run.sh --headless query workflows
   ```

Keep the plan temporary and remove it after the check.
