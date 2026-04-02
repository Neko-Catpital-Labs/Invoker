-- Migrate persisted tasks from Cursor to Codex as the execution agent.
-- Matching is on columns `execution_agent` and (optionally) `agent_name` equal to "cursor" (case-insensitive).
--
-- Invoker stores the plan’s executionAgent in `execution_agent`. If it is NULL, the app default at
-- runtime is Claude, not Cursor—so rows with NULL are not “Cursor tasks” for this migration.
--
-- DB path: ~/.invoker/invoker.db unless INVOKER_DB_DIR is set (then <dir>/invoker.db).
--
-- Preview (safe):
--   sqlite3 "${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db" < scripts/cursor-execution-agent-to-codex.sql
--
-- Apply after reviewing:
--   sqlite3 "${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db" < scripts/cursor-execution-agent-to-codex-apply.sql
--
-- Or interactive: open the DB in sqlite3, paste sections below.

-- What values exist today?
SELECT 'execution_agent values' AS section, execution_agent AS value, COUNT(*) AS n
FROM tasks
GROUP BY execution_agent
ORDER BY n DESC;

SELECT 'agent_name values' AS section, agent_name AS value, COUNT(*) AS n
FROM tasks
GROUP BY agent_name
ORDER BY n DESC;

-- Rows that would change (execution_agent)
SELECT id, workflow_id, execution_agent, agent_name, description
FROM tasks
WHERE execution_agent IS NOT NULL AND lower(trim(execution_agent)) = 'cursor';

-- Rows that would change (agent_name only — see apply script)
SELECT id, workflow_id, execution_agent, agent_name, description
FROM tasks
WHERE agent_name IS NOT NULL AND lower(trim(agent_name)) = 'cursor';
