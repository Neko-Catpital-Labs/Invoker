-- Apply: set execution_agent from cursor → codex (and optionally agent_name).
-- Backup first: cp "$HOME/.invoker/invoker.db" ~/invoker.db.bak
--
--   sqlite3 "${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db" < scripts/cursor-execution-agent-to-codex-apply.sql

BEGIN IMMEDIATE;

UPDATE tasks
SET execution_agent = 'codex'
WHERE execution_agent IS NOT NULL AND lower(trim(execution_agent)) = 'cursor';

UPDATE tasks
SET agent_name = 'codex'
WHERE agent_name IS NOT NULL AND lower(trim(agent_name)) = 'cursor';

COMMIT;
