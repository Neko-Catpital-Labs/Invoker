# First Agent Workflow Example

This example backs the first-run tutorial in [../../docs/tutorial-first-agent-workflow.md](../../docs/tutorial-first-agent-workflow.md).

Run the generator from the Invoker repo root:

```bash
examples/first-agent-workflow/create-local-project.sh
```

It creates a temporary local git repo with a failing Node test and generates two reference Invoker plans:

- `first-agent-workflow-codex.yaml`
- `first-agent-workflow-claude.yaml`

The desktop app does not currently import plan files. Follow the linked tutorial to bind the generated repository and use the in-app planner, or run a generated plan directly with `invoker-cli run <plan-path> --live` (which starts it immediately).
