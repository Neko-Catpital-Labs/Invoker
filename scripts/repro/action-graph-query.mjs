#!/usr/bin/env node

const [command, ...args] = process.argv.slice(2);
const input = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => resolve(data));
});

if (!command || !input.trim()) {
  process.exit(2);
}

const graph = JSON.parse(input);
const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];

function parseTimestamp(value) {
  if (!value) return NaN;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
  }
  return Date.parse(value);
}

function taskNode(taskId) {
  const matches = nodes.filter((node) => node.type === 'task-attempt' && node.taskId === taskId);
  return matches.find((node) => Array.isArray(node.history)) ?? matches[0];
}

function intentNode(intentId) {
  return nodes.find((node) => node.type === 'mutation-intent' && String(node.intentId) === String(intentId));
}

switch (command) {
  case 'task-status': {
    const node = taskNode(args[0]);
    process.stdout.write(String(node?.details?.taskStatus ?? ''));
    break;
  }
  case 'intent-id': {
    const [workflowId, needle, excludedId] = args;
    const node = nodes
      .filter((candidate) => candidate.type === 'mutation-intent')
      .filter((candidate) => candidate.workflowId === workflowId)
      .filter((candidate) => String(candidate.intentId) !== String(excludedId ?? ''))
      .filter((candidate) => JSON.stringify(candidate.details?.args ?? []).includes(needle))
      .sort((a, b) => Number(b.intentId ?? 0) - Number(a.intentId ?? 0))[0];
    process.stdout.write(node?.intentId === undefined ? '' : String(node.intentId));
    break;
  }
  case 'intent-status': {
    process.stdout.write(String(intentNode(args[0])?.status ?? ''));
    break;
  }
  case 'task-event-count-since-intent': {
    const [taskId, eventType, intentId] = args;
    const task = taskNode(taskId);
    const intent = intentNode(intentId);
    const since = intent?.createdAt ? Date.parse(intent.createdAt) : NaN;
    const history = Array.isArray(task?.history) ? task.history : [];
    const count = history.filter((entry) => {
      const timestamp = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
      return entry?.source === eventType && Number.isFinite(timestamp) && Number.isFinite(since) && timestamp >= since;
    }).length;
    process.stdout.write(String(count));
    break;
  }
  case 'task-event-time-since': {
    const [taskId, eventType, sinceRaw] = args;
    const task = taskNode(taskId);
    const since = parseTimestamp(sinceRaw);
    const history = Array.isArray(task?.history) ? task.history : [];
    const entry = history
      .filter((candidate) => {
        const timestamp = parseTimestamp(candidate?.timestamp);
        return candidate?.source === eventType && Number.isFinite(timestamp) && timestamp >= since;
      })
      .sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp))[0];
    process.stdout.write(String(entry?.timestamp ?? ''));
    break;
  }
  case 'task-event-count-between': {
    const [taskId, eventType, afterRaw, beforeRaw] = args;
    const task = taskNode(taskId);
    const after = parseTimestamp(afterRaw);
    const before = parseTimestamp(beforeRaw);
    const history = Array.isArray(task?.history) ? task.history : [];
    const count = history.filter((entry) => {
      const timestamp = parseTimestamp(entry?.timestamp);
      return entry?.source === eventType
        && Number.isFinite(timestamp)
        && Number.isFinite(after)
        && Number.isFinite(before)
        && timestamp > after
        && timestamp < before;
    }).length;
    process.stdout.write(String(count));
    break;
  }
  default:
    process.exit(2);
}
