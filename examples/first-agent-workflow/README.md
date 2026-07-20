# First Agent Workflow Example

This example backs the first-run tutorial in [../../docs/tutorial-first-agent-workflow.md](../../docs/tutorial-first-agent-workflow.md).

Run the generator from the Invoker repo root:

```bash
examples/first-agent-workflow/create-local-project.sh
```

It creates a temporary local git repo with a failing Node test and generates two Invoker plans:

- `first-agent-workflow-codex.yaml`
- `first-agent-workflow-claude.yaml`

Open either generated plan in the desktop app and click `Start`.
