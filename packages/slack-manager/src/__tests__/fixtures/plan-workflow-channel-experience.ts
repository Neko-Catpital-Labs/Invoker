import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const JOURNEY = {
  slack: {
    workflowId: 'wf-slack-101',
    userId: 'U_SLACK_101',
    lobbyChannelId: 'C_PLAN_LOBBY',
    lobbyThreadTs: '1710000000.101',
    workflowChannelId: 'C_WORKFLOW_SLACK',
  },
  inApp: {
    workflowId: 'wf-in-app-202',
    userId: 'U_IN_APP_202',
    lobbyChannelId: 'C_IN_APP_HOME',
    lobbyThreadTs: '1710000000.202',
    workflowChannelId: 'C_WORKFLOW_IN_APP',
  },
  inviteFailure: {
    workflowId: 'wf-invite-303',
    userId: 'U_INVITE_303',
    lobbyChannelId: 'C_FAILURE_LOBBY',
    lobbyThreadTs: '1710000000.303',
    workflowChannelId: 'C_WORKFLOW_INVITE_FAILED',
    errorCode: 'missing_scope',
  },
  unmappedWorkflowId: 'wf-unmapped-404',
  duplicateChannelId: 'C_DUPLICATE_SHOULD_NOT_EXIST',
} as const;

export type JourneyLedgerEntry =
  | { operation: 'create'; channelId: string; name: string; isPrivate: boolean }
  | { operation: 'invite'; channelId: string; userId: string; outcome: 'ok' | `error:${string}` }
  | { operation: 'post'; channelId: string; threadTs?: string; messageTs: string; text: string }
  | { operation: 'update'; channelId: string; messageTs: string; text: string }
  | {
      operation: 'mapping';
      workflowId: string;
      channelId: string;
      requestedBy?: string;
      lobbyChannelId?: string;
      lobbyThreadTs?: string;
    };

export const JOURNEY_ARTIFACT_PATH = fileURLToPath(
  new URL('../artifacts/plan-workflow-channel-experience.html', import.meta.url),
);

export function maybeUpdateJourneyArtifact(html: string): void {
  if (process.env.UPDATE_PLAN_WORKFLOW_CHANNEL_ARTIFACT === '1') {
    writeFileSync(JOURNEY_ARTIFACT_PATH, html, 'utf8');
  }
}

export function readJourneyArtifact(): string {
  return readFileSync(JOURNEY_ARTIFACT_PATH, 'utf8');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function detail(entry: JourneyLedgerEntry): string {
  switch (entry.operation) {
    case 'create':
      return `${entry.name} → ${entry.channelId} (${entry.isPrivate ? 'private' : 'public'})`;
    case 'invite':
      return `${entry.userId} → ${entry.channelId} (${entry.outcome})`;
    case 'post':
      return `${entry.channelId}${entry.threadTs ? ` / thread ${entry.threadTs}` : ''} / ${entry.messageTs}\n${entry.text}`;
    case 'update':
      return `${entry.channelId} / ${entry.messageTs}\n${entry.text}`;
    case 'mapping':
      return `${entry.workflowId} → ${entry.channelId}\nrequester=${entry.requestedBy ?? 'none'} lobby=${entry.lobbyChannelId ?? 'none'} thread=${entry.lobbyThreadTs ?? 'none'}`;
  }
}

export function renderJourneyArtifact(entries: readonly JourneyLedgerEntry[]): string {
  const channelsByWorkflow = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.operation !== 'mapping') continue;
    const channels = channelsByWorkflow.get(entry.workflowId) ?? new Set<string>();
    channels.add(entry.channelId);
    channelsByWorkflow.set(entry.workflowId, channels);
  }
  const duplicateWorkflowIds = [...channelsByWorkflow]
    .filter(([, channelIds]) => channelIds.size > 1)
    .map(([workflowId]) => workflowId);
  const verdict = duplicateWorkflowIds.length === 0 ? 'PASS' : 'FAIL';
  const verdictDetail = duplicateWorkflowIds.length === 0
    ? 'Every workflow has one channel mapping.'
    : `Repeated workflow_created delivery remapped: ${duplicateWorkflowIds.join(', ')}.`;
  const counts = ['create', 'invite', 'post', 'update', 'mapping']
    .map((operation) => `${operation}=${entries.filter((entry) => entry.operation === operation).length}`)
    .join(' · ');
  const rows = entries.map((entry, index) => `
        <tr data-operation="${entry.operation}">
          <td>${String(index + 1).padStart(2, '0')}</td>
          <td><code>${entry.operation}</code></td>
          <td><pre>${escapeHtml(detail(entry))}</pre></td>
        </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plan → workflow channel journey</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background: #f4f1eb; color: #202124; }
    body { max-width: 1120px; margin: 0 auto; padding: 40px 24px 64px; }
    h1 { margin: 0 0 8px; font-size: 30px; }
    .lede { margin: 0 0 24px; color: #5f6368; }
    .verdict { border: 2px solid #b3261e; border-radius: 12px; background: #f9dedc; padding: 16px 18px; margin-bottom: 18px; }
    .verdict strong { color: #8c1d18; font-size: 22px; margin-right: 10px; }
    .counts { border-radius: 10px; background: #e8f0fe; color: #174ea6; padding: 12px 16px; margin-bottom: 18px; font-weight: 650; }
    table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 2px 14px #00000014; }
    th, td { border-bottom: 1px solid #dadce0; padding: 12px; text-align: left; vertical-align: top; }
    th { background: #202124; color: white; position: sticky; top: 0; }
    td:first-child { width: 42px; color: #5f6368; }
    td:nth-child(2) { width: 92px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    tr[data-operation="mapping"] { background: #edf7ed; }
    tr[data-operation="invite"] { background: #fff8e1; }
  </style>
</head>
<body>
  <h1>Plan → workflow channel journey</h1>
  <p class="lede">Deterministic Slack API and SQLite mapping trace generated by the stitched end-to-end proof.</p>
  <section class="verdict"><strong>${verdict}</strong>${escapeHtml(verdictDetail)}</section>
  <div class="counts">${counts}</div>
  <table>
    <thead><tr><th>#</th><th>Operation</th><th>Exact captured detail</th></tr></thead>
    <tbody>${rows}
    </tbody>
  </table>
</body>
</html>
`;
}
