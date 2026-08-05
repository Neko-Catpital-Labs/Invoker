# Frozen Task-Decomposition Prompts

These prompts are the frozen inputs for the split and monolithic arms. The HTML
markers are part of the harness contract; `run-trials.mjs` extracts the exact
text between each marker pair and records that text in `trials.jsonl`.

## crash-not-graceful-quit

### split

<!-- prompt:crash-not-graceful-quit:split:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the split arm: first produce an Invoker task DAG, then execute the DAG. The
plan must isolate evidence gathering, root-cause analysis, implementation, and
verification into separate tasks with explicit dependencies.

Problem: the incident is being labeled as a graceful application quit, but the
repro asserts that the owner crashed and relaunched. Use
`repro/03-crash-not-graceful-quit.mjs` as the frozen acceptance check.

Required outcome: make the minimal repository change needed so this command
passes:

`node repro/03-crash-not-graceful-quit.mjs`

Keep product behavior changes scoped to the diagnosis, preserve existing tests,
and report the evidence that distinguishes crash/relaunch from graceful quit.
<!-- prompt:crash-not-graceful-quit:split:end -->

### monolithic

<!-- prompt:crash-not-graceful-quit:monolithic:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the monolithic arm: one agent, one prompt, no planned task DAG. Diagnose and
fix the repository so the incident is not mislabeled as a graceful application
quit when the evidence shows owner crash and relaunch handoffs.

Frozen acceptance check:

`node repro/03-crash-not-graceful-quit.mjs`

Make the minimal repository change needed, preserve existing tests, and report
the evidence that distinguishes crash/relaunch from graceful quit.
<!-- prompt:crash-not-graceful-quit:monolithic:end -->

## ssh-oauth-root-cause

### split

<!-- prompt:ssh-oauth-root-cause:split:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the split arm: first produce an Invoker task DAG, then execute the DAG. The
plan must isolate log evidence, infrastructure attribution, application-code
inspection, implementation, and verification into separate dependent tasks.

Problem: the incident root cause should be attributed to SSH/OAuth
execution-pool infrastructure and remote disk pressure rather than application
logic. Use `repro/04-root-cause-ssh-oauth-infra.mjs` as the frozen acceptance
check.

Required outcome: make the minimal repository change needed so this command
passes:

`node repro/04-root-cause-ssh-oauth-infra.mjs`

Preserve existing behavior outside this diagnosis path and report the evidence
used for the root-cause attribution.
<!-- prompt:ssh-oauth-root-cause:split:end -->

### monolithic

<!-- prompt:ssh-oauth-root-cause:monolithic:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the monolithic arm: one agent, one prompt, no planned task DAG. Diagnose and
fix the repository so the incident root cause is correctly attributed to
SSH/OAuth execution-pool infrastructure and disk pressure, not application
logic.

Frozen acceptance check:

`node repro/04-root-cause-ssh-oauth-infra.mjs`

Make the minimal repository change needed, preserve unrelated behavior, and
report the evidence used for the attribution.
<!-- prompt:ssh-oauth-root-cause:monolithic:end -->

## real-ssh-error-overwritten

### split

<!-- prompt:real-ssh-error-overwritten:split:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the split arm: first produce an Invoker task DAG, then execute the DAG. The
plan must separate fixture inspection, error-propagation analysis,
implementation, regression coverage, and verification into dependent tasks.

Problem: real SSH executor startup errors are preserved in one path but
orphaned SSH tasks are flattened to `Application quit`, losing diagnosable
context. Use `repro/05-real-ssh-error-overwritten.mjs` as the frozen acceptance
check.

Required outcome: make the minimal repository change needed so this command
passes:

`node repro/05-real-ssh-error-overwritten.mjs`

Preserve existing task-state semantics and report how the fix avoids overwriting
real SSH failure context.
<!-- prompt:real-ssh-error-overwritten:split:end -->

### monolithic

<!-- prompt:real-ssh-error-overwritten:monolithic:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the monolithic arm: one agent, one prompt, no planned task DAG. Diagnose and
fix the repository so orphaned SSH tasks do not lose diagnosable failure context
by being flattened to `Application quit`.

Frozen acceptance check:

`node repro/05-real-ssh-error-overwritten.mjs`

Make the minimal repository change needed, preserve task-state semantics, and
report how the fix keeps real SSH error information available.
<!-- prompt:real-ssh-error-overwritten:monolithic:end -->

## merge-gate-stopped-on-shutdown

### split

<!-- prompt:merge-gate-stopped-on-shutdown:split:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the split arm: first produce an Invoker task DAG, then execute the DAG. The
plan must separate merge-gate source tracing, shutdown lifecycle analysis,
implementation, regression coverage, and verification into dependent tasks.

Problem: `Merge gate execution was stopped before completion` should be treated
as shutdown teardown of an in-flight merge task, not as a merge-gate logic
failure. Use `repro/06-merge-gate-stopped-on-shutdown.mjs` as the frozen
acceptance check.

Required outcome: make the minimal repository change needed so this command
passes:

`node repro/06-merge-gate-stopped-on-shutdown.mjs`

Preserve normal merge-gate behavior and report the source/data evidence that
ties the error to teardown.
<!-- prompt:merge-gate-stopped-on-shutdown:split:end -->

### monolithic

<!-- prompt:merge-gate-stopped-on-shutdown:monolithic:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the monolithic arm: one agent, one prompt, no planned task DAG. Diagnose and
fix the repository so merge-gate stopped-before-completion failures are handled
as shutdown teardown of in-flight work rather than merge-gate logic failures.

Frozen acceptance check:

`node repro/06-merge-gate-stopped-on-shutdown.mjs`

Make the minimal repository change needed, preserve normal merge-gate behavior,
and report the evidence that ties the error to teardown.
<!-- prompt:merge-gate-stopped-on-shutdown:monolithic:end -->

## executing-failures-are-oauth

### split

<!-- prompt:executing-failures-are-oauth:split:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the split arm: first produce an Invoker task DAG, then execute the DAG. The
plan must separate fixture inspection, stderr/stdout cause ranking,
infrastructure attribution, implementation, regression coverage, and
verification into dependent tasks.

Problem: executing-phase failures that include package-manager warnings should
be attributed to the fatal SSH/OAuth infrastructure error, not to misleading
task-local warnings. Use `repro/07-executing-failures-are-oauth-not-task.mjs` as
the frozen acceptance check.

Required outcome: make the minimal repository change needed so this command
passes:

`node repro/07-executing-failures-are-oauth-not-task.mjs`

Preserve useful task output and report why the package-manager warning is not
the fatal cause.
<!-- prompt:executing-failures-are-oauth:split:end -->

### monolithic

<!-- prompt:executing-failures-are-oauth:monolithic:start -->
You are evaluating Invoker task decomposition on a real historic repro.

Use the monolithic arm: one agent, one prompt, no planned task DAG. Diagnose and
fix the repository so executing-phase failures with package-manager warnings are
attributed to the fatal SSH/OAuth infrastructure error when that is the real
cause.

Frozen acceptance check:

`node repro/07-executing-failures-are-oauth-not-task.mjs`

Make the minimal repository change needed, preserve useful task output, and
report why the warning is not the fatal cause.
<!-- prompt:executing-failures-are-oauth:monolithic:end -->
