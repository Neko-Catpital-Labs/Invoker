#!/usr/bin/env bash
export INVOKER_DB_DIR="${INVOKER_DB_DIR:-$HOME/.invoker-nicespeak-eval}"
export INVOKER_REPO_CONFIG_PATH="${INVOKER_REPO_CONFIG_PATH:-$INVOKER_DB_DIR/config.json}"
export INVOKER_IPC_SOCKET="${INVOKER_IPC_SOCKET:-$INVOKER_DB_DIR/ipc-transport.sock}"
