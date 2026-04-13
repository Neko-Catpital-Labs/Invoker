#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${INVOKER_DB_PATH:-$HOME/.invoker/invoker.db}"
WORKFLOW_ID="${1:-wf-1775936968949-13}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "repro: database not found at $DB_PATH" >&2
  exit 1
fi

IFS=$'\t' read -r FIX_EVENT_AT UPSTREAM_ID DOWNSTREAM_ID DESCENDANT_COMPLETED_AT MERGE_ID MERGE_STATUS <<EOF
$(sqlite3 -tabs "$DB_PATH" "
with recursive
  wf_tasks as (
    select id, status, dependencies
    from tasks
    where workflow_id = '$WORKFLOW_ID'
  ),
  edges(parent_id, child_id) as (
    select json_each.value, wf_tasks.id
    from wf_tasks, json_each(wf_tasks.dependencies)
  ),
  unresolved as (
    select id, status
    from wf_tasks
    where status in ('fixing_with_ai', 'awaiting_approval', 'review_ready')
  ),
  descendants(root_id, id) as (
    select wf_tasks.id, wf_tasks.id
    from wf_tasks
    union all
    select descendants.root_id, edges.child_id
    from descendants
    join edges on edges.parent_id = descendants.id
  ),
  fix_events as (
    select task_id, created_at
    from events
    where task_id in (select id from wf_tasks)
      and event_type = 'task.fixing_with_ai'
  ),
  completed_descendants as (
    select
      fix_events.created_at as fix_event_at,
      fix_events.task_id as upstream_id,
      descendants.id as downstream_id,
      completed_events.created_at as descendant_completed_at
    from fix_events
    join descendants on descendants.root_id = fix_events.task_id
    join events as completed_events on completed_events.task_id = descendants.id
    where descendants.id != fix_events.task_id
      and completed_events.event_type = 'task.completed'
      and completed_events.created_at > fix_events.created_at
      and not exists (
        select 1
        from events as resolution_events
        where resolution_events.task_id = fix_events.task_id
          and resolution_events.created_at > fix_events.created_at
          and resolution_events.created_at < completed_events.created_at
          and resolution_events.event_type in (
            'task.pending',
            'task.running',
            'task.completed',
            'task.awaiting_approval',
            'task.review_ready'
          )
      )
  ),
  bad as (
    select *
    from completed_descendants
    limit 1
  )
select
  coalesce(bad.fix_event_at, ''),
  coalesce(bad.upstream_id, ''),
  coalesce(bad.downstream_id, ''),
  coalesce(bad.descendant_completed_at, ''),
  coalesce(merge_task.id, ''),
  coalesce(merge_task.status, '')
from bad
left join wf_tasks as merge_task on merge_task.id = '__merge__' || '$WORKFLOW_ID'
limit 1;
")
EOF

if [[ -z "$UPSTREAM_ID" || -z "$DOWNSTREAM_ID" ]]; then
  echo "repro: no historical fixing_with_ai -> completed-descendant violation found for workflow $WORKFLOW_ID"
  exit 1
fi

CURRENT_UPSTREAM_STATUS="$(sqlite3 -noheader "$DB_PATH" "select coalesce(status, '') from tasks where id = '$UPSTREAM_ID' limit 1;")"
CURRENT_DOWNSTREAM_STATUS="$(sqlite3 -noheader "$DB_PATH" "select coalesce(status, '') from tasks where id = '$DOWNSTREAM_ID' limit 1;")"

echo "repro: historical stale descendant violation found"
echo "workflow:   $WORKFLOW_ID"
echo "fix event:  $UPSTREAM_ID entered task.fixing_with_ai at $FIX_EVENT_AT"
echo "descendant: $DOWNSTREAM_ID completed at $DESCENDANT_COMPLETED_AT"
if [[ -n "$CURRENT_UPSTREAM_STATUS" ]]; then
  echo "current upstream status:   $CURRENT_UPSTREAM_STATUS"
fi
if [[ -n "$CURRENT_DOWNSTREAM_STATUS" ]]; then
  echo "current downstream status: $CURRENT_DOWNSTREAM_STATUS"
fi
if [[ -n "$MERGE_ID" ]]; then
  echo "merge:      $MERGE_ID ($MERGE_STATUS)"
fi

echo
echo "dependency rows:"
sqlite3 "$DB_PATH" "
select id, status, dependencies
from tasks
where workflow_id = '$WORKFLOW_ID'
order by id;
"

echo
echo "event timeline:"
sqlite3 "$DB_PATH" "
select task_id, event_type, created_at
from events
where task_id in ('$UPSTREAM_ID', '$DOWNSTREAM_ID', '__merge__${WORKFLOW_ID}')
order by created_at;
"
