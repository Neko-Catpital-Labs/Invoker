import { useRef, useState } from 'react';
import type {
  InvokerSetupRequest,
  InvokerSetupResult,
  PrerequisiteCheck,
  PrerequisiteStatus,
  SystemDiagnostics,
} from '@invoker/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './primitives/index.js';

const readinessStatusClasses: Record<PrerequisiteStatus, { dot: string; text: string; badge: string }> = {
  ok: {
    dot: 'bg-green-400',
    text: 'text-green-300',
    badge: 'border-green-700/50 bg-green-950/30 text-green-200',
  },
  warn: {
    dot: 'bg-amber-300',
    text: 'text-amber-200',
    badge: 'border-amber-700/50 bg-amber-950/30 text-amber-100',
  },
  error: {
    dot: 'bg-red-400',
    text: 'text-red-300',
    badge: 'border-red-700/50 bg-red-950/30 text-red-200',
  },
};

function getReadinessChecks(diagnostics: SystemDiagnostics | null): PrerequisiteCheck[] | undefined {
  const readiness = diagnostics?.readiness;
  if (!readiness) return undefined;
  return Array.isArray(readiness) ? readiness : readiness.checks;
}

interface SystemSetupModalProps {
  diagnostics: SystemDiagnostics | null;
  installPending?: boolean;
  installError?: string | null;
  onInstallBundledSkills?: (mode?: 'install' | 'update' | 'reinstall') => void;
  updateCliPending?: boolean;
  setupPending?: boolean;
  setupResult?: InvokerSetupResult | null;
  onRunSetup?: (request: InvokerSetupRequest) => void;
  updateCliError?: string | null;
  onUpdateInvokerCli?: () => void;
  onAddMachine?: (fields: MachineSetupFields) => Promise<MachineCheckOutcome>;
  onClose: () => void;
}

type SetupCheckId = 'updateCli' | 'installHelpers' | 'fixTools' | 'slack';
const setupStepLabels: Record<'choose' | 'review' | 'finish', string> = {
  choose: '1. Choose',
  review: '2. Review',
  finish: '3. Finish',
};

type SlackFieldId = 'botToken' | 'appToken' | 'signingSecret' | 'channelId';

const firstAgentWorkflowTutorialUrl = 'https://github.com/Neko-Catpital-Labs/Invoker/blob/main/docs/tutorial-first-agent-workflow.md';

type MachineFieldId = 'host' | 'user' | 'sshKeyPath' | 'port' | 'maxConcurrentTasks' | 'provisionCommand';

export interface MachineSetupFields {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  maxConcurrentTasks?: number;
  provisionCommand?: string;
}

export interface MachineCheckOutcome {
  ok: boolean;
  message?: string;
}

interface AddedMachine {
  fields: MachineSetupFields;
  message?: string;
}

const machineSetupFields: Array<{ id: MachineFieldId; label: string; placeholder: string; required: boolean }> = [
  { id: 'host', label: 'Host', placeholder: 'e.g. 10.0.0.5 or box.example.com', required: true },
  { id: 'user', label: 'User', placeholder: 'e.g. ubuntu', required: true },
  { id: 'sshKeyPath', label: 'SSH key path', placeholder: '~/.ssh/id_ed25519', required: true },
  { id: 'port', label: 'Port', placeholder: '22', required: false },
  { id: 'maxConcurrentTasks', label: 'Max concurrent tasks', placeholder: '1', required: false },
  { id: 'provisionCommand', label: 'Provision command', placeholder: 'optional', required: false },
];

const emptyMachineFormFields: Record<MachineFieldId, string> = {
  host: '',
  user: '',
  sshKeyPath: '',
  port: '',
  maxConcurrentTasks: '',
  provisionCommand: '',
};

function buildMachineSetupFields(raw: Record<MachineFieldId, string>): MachineSetupFields {
  const fields: MachineSetupFields = {
    host: raw.host.trim(),
    user: raw.user.trim(),
    sshKeyPath: raw.sshKeyPath.trim(),
  };
  if (raw.port.trim() !== '') fields.port = Number(raw.port);
  if (raw.maxConcurrentTasks.trim() !== '') fields.maxConcurrentTasks = Number(raw.maxConcurrentTasks);
  if (raw.provisionCommand.trim() !== '') fields.provisionCommand = raw.provisionCommand.trim();
  return fields;
}

const slackSetupFields: Array<{
  id: SlackFieldId;
  label: string;
  placeholder: string;
  sourceTitle: string;
  sourceUrl: string;
  sourcePath: string;
}> = [
  {
    id: 'botToken',
    label: 'Bot token',
    placeholder: 'xoxb-…',
    sourceTitle: 'Slack API apps',
    sourceUrl: 'https://api.slack.com/apps',
    sourcePath: 'Your app > OAuth & Permissions > Bot User OAuth Token',
  },
  {
    id: 'appToken',
    label: 'App token',
    placeholder: 'xapp-…',
    sourceTitle: 'Slack API apps',
    sourceUrl: 'https://api.slack.com/apps',
    sourcePath: 'Your app > Basic Information > App-Level Tokens',
  },
  {
    id: 'signingSecret',
    label: 'Signing secret',
    placeholder: 'Signing secret',
    sourceTitle: 'Slack API apps',
    sourceUrl: 'https://api.slack.com/apps',
    sourcePath: 'Your app > Basic Information > App Credentials > Signing Secret',
  },
  {
    id: 'channelId',
    label: 'Lobby channel ID',
    placeholder: 'C…',
    sourceTitle: 'Slack channel details',
    sourceUrl: 'https://slack.com/app_redirect?channel=',
    sourcePath: 'Open the channel > channel name > About > Channel ID',
  },
];


export function SystemSetupModal({
  diagnostics,
  installPending = false,
  installError = null,
  setupPending = false,
  setupResult = null,
  onInstallBundledSkills,
  updateCliPending = false,
  updateCliError = null,
  onRunSetup,
  onUpdateInvokerCli,
  onAddMachine,
  onClose,
}: SystemSetupModalProps) {
  const [setupChecks, setSetupChecks] = useState<Record<SetupCheckId, boolean>>({
    updateCli: true,
    installHelpers: true,
    fixTools: true,
    slack: false,
  });
  const [slackFields, setSlackFields] = useState<Record<SlackFieldId, string>>({
    botToken: '',
    appToken: '',
    signingSecret: '',
    channelId: '',
  });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [systemDetailsOpen, setSystemDetailsOpen] = useState(false);
  const [machineFormFields, setMachineFormFields] = useState<Record<MachineFieldId, string>>(emptyMachineFormFields);
  const [machineFormOpen, setMachineFormOpen] = useState(true);
  const [machineCheckPending, setMachineCheckPending] = useState(false);
  const [machineCheckError, setMachineCheckError] = useState<string | null>(null);
  const [addedMachines, setAddedMachines] = useState<AddedMachine[]>([]);
  const [machinesStepDone, setMachinesStepDone] = useState(false);
  const [machineCloseConfirmOpen, setMachineCloseConfirmOpen] = useState(false);
  const machineSubmitInFlightRef = useRef(false);
  const machineRequiredFieldsComplete = machineSetupFields
    .filter((field) => field.required)
    .every((field) => machineFormFields[field.id].trim() !== '');
  const machineFormHasValues = machineSetupFields.some((field) => machineFormFields[field.id].trim() !== '');
  const hasUnconfirmedMachineFields = machineFormOpen && machineFormHasValues;
  const submitMachineForm = async (): Promise<void> => {
    if (!onAddMachine || machineSubmitInFlightRef.current || !machineRequiredFieldsComplete) return;
    machineSubmitInFlightRef.current = true;
    setMachineCheckPending(true);
    setMachineCheckError(null);
    const fields = buildMachineSetupFields(machineFormFields);
    try {
      const outcome = await onAddMachine(fields);
      if (outcome.ok) {
        setAddedMachines((prev) => [...prev, { fields, message: outcome.message }]);
        setMachineFormFields(emptyMachineFormFields);
        setMachineFormOpen(false);
      } else {
        setMachineCheckError(outcome.message ?? 'Could not add this machine.');
      }
    } catch (err) {
      setMachineCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      machineSubmitInFlightRef.current = false;
      setMachineCheckPending(false);
    }
  };
  const requestCloseModal = (): void => {
    if (hasUnconfirmedMachineFields) {
      setMachineCloseConfirmOpen(true);
      return;
    }
    onClose();
  };
  const anySetupSelected = setupChecks.updateCli || setupChecks.installHelpers || setupChecks.fixTools || setupChecks.slack;
  const slackFieldsComplete = slackSetupFields.every((field) => slackFields[field.id] !== '');
  const firstMissingSlackField = setupChecks.slack
    ? slackSetupFields.find((field) => slackFields[field.id] === '')
    : undefined;
  const currentSetupStep: keyof typeof setupStepLabels = setupResult ? 'finish' : reviewOpen ? 'review' : 'choose';
  const hasRunnableSetup = setupChecks.updateCli || setupChecks.installHelpers || setupChecks.fixTools || (setupChecks.slack && slackFieldsComplete);
  const toggleSetupCheck = (id: SetupCheckId): void => {
    setSetupChecks((prev) => ({ ...prev, [id]: !prev[id] }));
    setReviewOpen(false);
  };
  const runSelectedSetup = (): void => {
    if (!onRunSetup || !hasRunnableSetup) return;
    onRunSetup({
      updateCli: setupChecks.updateCli,
      installHelpers: setupChecks.installHelpers,
      fixTools: setupChecks.fixTools,
      slack: setupChecks.slack && slackFieldsComplete ? slackFields : false,
    });
  };

  const installedAgents = diagnostics?.tools.filter((tool) => (tool.id === 'claude' || tool.id === 'codex') && tool.installed) ?? [];
  const bundledSkills = diagnostics?.bundledSkills;
  const cliInstaller = diagnostics?.cliInstaller;
  const readinessChecks = getReadinessChecks(diagnostics);
  const canInstallBundledSkills = Boolean(bundledSkills?.available && onInstallBundledSkills);
  const helperTargets = bundledSkills
    ? [...bundledSkills.targets, ...bundledSkills.commandTargets, ...bundledSkills.mcpTargets]
    : [];
  const installActionMode = helperTargets.some((target) => target.installed && !target.upToDate)
    ? 'update'
    : helperTargets.some((target) => target.installed)
      ? 'reinstall'
      : 'install';
  const installActionLabel = installActionMode === 'update'
    ? 'Update Helpers'
    : installActionMode === 'reinstall'
      ? 'Reinstall Helpers'
      : 'Install Helpers';
  const missingRequiredTools = diagnostics?.tools.filter((tool) => tool.required && !tool.installed) ?? [];
  const missingOptionalTools = diagnostics?.tools.filter((tool) => !tool.required && !tool.installed) ?? [];
  const guidedSetupSteps: Array<{
    checkId: keyof typeof setupChecks;
    title: string;
    detail: string;
    status: string;
  }> = [
    {
      checkId: 'updateCli',
      title: 'Install or update invoker-cli',
      detail: cliInstaller?.supported
        ? cliInstaller.upToDate
          ? `Ready: ${cliInstaller.installedVersion ?? cliInstaller.bundledVersion}`
          : cliInstaller.installedVersion
            ? `Update ${cliInstaller.installedVersion} to ${cliInstaller.bundledVersion}`
            : `Install ${cliInstaller.bundledVersion} on PATH`
        : 'Not needed in this app mode',
      status: cliInstaller?.supported && !cliInstaller.upToDate ? 'Needs setup' : 'Ready',
    },
    {
      checkId: 'installHelpers',
      title: 'Install Invoker helpers',
      detail: bundledSkills?.available
        ? helperTargets.length === 0
          ? 'No helper targets found'
          : helperTargets.every((target) => target.upToDate)
            ? 'Skills, commands, and MCP entries are up to date'
            : 'Install or update skills, slash commands, and MCP entries'
        : 'No bundled helpers available',
      status: bundledSkills?.available && helperTargets.some((target) => !target.upToDate) ? 'Needs setup' : 'Ready',
    },
    {
      checkId: 'fixTools',
      title: 'Install missing tools',
      detail: missingRequiredTools.length > 0
        ? `Missing required: ${missingRequiredTools.map((tool) => tool.name).join(', ')}`
        : missingOptionalTools.length > 0
          ? `Optional missing: ${missingOptionalTools.map((tool) => tool.name).join(', ')}`
          : 'All detected tools are installed',
      status: missingRequiredTools.length > 0 ? 'Needs setup' : missingOptionalTools.length > 0 ? 'Optional' : 'Ready',
    },
    {
      checkId: 'slack',
      title: 'Set up Slack integration',
      detail: 'Slack is optional; turn it on to add app values.',
      status: slackFieldsComplete ? 'Ready to run' : 'Needs fields',
    },
  ];
  const selectedSetupSteps = guidedSetupSteps.filter((step) => setupChecks[step.checkId]);
  const runnableSetupSteps = selectedSetupSteps.filter((step) => step.checkId !== 'slack' || slackFieldsComplete);
  const waitingSetupSteps = selectedSetupSteps.filter((step) => step.checkId === 'slack' && !slackFieldsComplete);


  return (
    <Dialog open onOpenChange={(open) => { if (!open) requestCloseModal(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden" hideCloseButton>
        <DialogHeader className="p-6 pb-3 shrink-0">
          <DialogTitle>System Setup</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {diagnostics
              ? `Invoker ${diagnostics.appVersion} on ${diagnostics.platform}/${diagnostics.arch}${diagnostics.isPackaged ? ' (packaged app)' : ' (repo/dev mode)'}`
              : 'Loading system diagnostics...'}
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
          {onRunSetup && (
            <div className="rounded border border-border-strong/60 bg-secondary/70 px-4 py-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-foreground">Set up Invoker</div>
                  <div className="text-sm text-muted-foreground/80 mt-1">
                    Pick what to configure. Invoker runs the safe parts and asks only for what it cannot do alone.
                  </div>
                </div>
                <div className="shrink-0 rounded bg-secondary px-2 py-1 text-xs text-foreground">
                  {setupStepLabels[currentSetupStep]}
                </div>
              </div>

              <div className="rounded border border-border-strong/70 bg-card/40">
                <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Choose setup items
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-secondary">
                  {guidedSetupSteps.map((step) => (
                    <label key={step.checkId} className="flex gap-3 bg-card/70 px-3 py-3 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={setupChecks[step.checkId]}
                        onChange={() => toggleSetupCheck(step.checkId)}
                        className="mt-1 h-4 w-4 rounded border-border-strong bg-background"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-3">
                          <span className="font-medium">{step.title}</span>
                          <span className="shrink-0 rounded bg-secondary px-2 py-0.5 text-xs text-foreground">{step.status}</span>
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground/80">{step.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {!reviewOpen && (
                <button
                  onClick={() => setReviewOpen(true)}
                  disabled={!anySetupSelected}
                  className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-secondary disabled:text-muted-foreground text-white rounded text-sm font-medium transition-colors"
                >
                  Set it up for me
                </button>
              )}

              {reviewOpen && (
                <div className="rounded border border-border-strong/70 bg-card/50 px-3 py-3 text-sm text-foreground space-y-3">
                  <div>
                    <div className="font-medium">Review setup plan</div>
                    <div className="mt-1 text-xs text-muted-foreground/80">
                      Approve the safe setup run. Any missing Slack value stays here as the next step.
                    </div>
                  </div>

                  {runnableSetupSteps.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Will run now</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {runnableSetupSteps.map((step) => (
                          <span key={step.checkId} className="rounded bg-secondary/90 px-2 py-1 text-xs text-foreground">
                            {step.title}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {waitingSetupSteps.length > 0 && firstMissingSlackField && (
                    <div className="rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
                      Slack waits for {firstMissingSlackField.label}. The rest can run now.
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={runSelectedSetup}
                      disabled={setupPending || !hasRunnableSetup}
                      className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-secondary disabled:text-muted-foreground text-white rounded text-sm font-medium transition-colors"
                    >
                      {setupPending ? 'Setting up…' : hasRunnableSetup ? 'Approve and run setup' : 'Add the missing info first'}
                    </button>
                    <button
                      onClick={() => setReviewOpen(false)}
                      disabled={setupPending}
                      className="px-3 py-2 bg-muted hover:bg-accent disabled:bg-secondary disabled:text-muted-foreground text-white rounded text-sm transition-colors"
                    >
                      Change selection
                    </button>
                  </div>
                </div>
              )}

              {reviewOpen && setupChecks.slack && firstMissingSlackField && (
                <div className="rounded border border-amber-600/50 bg-amber-950/40 px-3 py-3 text-sm text-amber-100">
                  <div className="font-medium">Next: add {firstMissingSlackField.label}</div>
                  <div className="mt-1 text-amber-100/90">
                    Find it at{' '}
                    <a href={firstMissingSlackField.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                      {firstMissingSlackField.sourceTitle}
                    </a>
                    {' '}→ {firstMissingSlackField.sourcePath}.
                  </div>
                  <label className="mt-3 block text-xs text-amber-100">
                    {firstMissingSlackField.label} <span className="text-amber-100/70">({firstMissingSlackField.placeholder})</span>
                    <input
                      value={slackFields[firstMissingSlackField.id]}
                      onChange={(event) => {
                        setSlackFields((prev) => ({ ...prev, [firstMissingSlackField.id]: event.target.value }));
                      }}
                      type={firstMissingSlackField.id === 'channelId' ? 'text' : 'password'}
                      className="mt-1 w-full rounded border border-amber-700 bg-card px-2 py-1.5 text-sm text-foreground"
                    />
                  </label>
                </div>
              )}
              {setupResult && (
                <div className={`rounded border px-3 py-2 text-sm ${setupResult.ok ? 'border-green-700/50 bg-green-950/30 text-green-100' : 'border-red-700/50 bg-red-950/30 text-red-100'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="font-medium">{setupResult.ok ? 'Setup completed' : 'Setup completed with failures'}</div>
                    {currentSetupStep === 'finish' && (
                      <a
                        href={firstAgentWorkflowTutorialUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded bg-green-800/70 px-3 py-1.5 text-xs font-medium text-green-50 hover:bg-green-700"
                      >
                        Open the First Agent Workflow Tutorial
                      </a>
                    )}
                  </div>
                  <div className="mt-2 space-y-2">
                    {setupResult.steps.map((step) => (
                      <div key={step.id} className="rounded bg-card/50 px-2 py-2">
                        <div className={step.ok ? 'text-green-200' : 'text-red-200'}>{step.ok ? 'ok' : 'failed'} — {step.name}</div>
                        {step.error && <div className="mt-1 text-xs text-red-200">{step.error}</div>}
                        {step.output && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-foreground">{step.output}</pre>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {onAddMachine && (
            <div className="rounded border border-border-strong/60 bg-secondary/70 px-4 py-4 space-y-4">
              <div>
                <div className="text-sm font-medium text-foreground">Add remote machines</div>
                <div className="text-sm text-muted-foreground/80 mt-1">
                  Add machines Invoker can run tasks on over SSH. Each machine is checked before it&apos;s added.
                </div>
              </div>

              {addedMachines.length > 0 && (
                <div className="rounded border border-border-strong/70 bg-card/40 divide-y divide-border">
                  {addedMachines.map((machine, index) => (
                    <div key={`${machine.fields.host}-${index}`} className="px-3 py-2 text-sm text-foreground">
                      <span className="font-medium">{machine.fields.user}@{machine.fields.host}</span>
                      {machine.message && <span className="ml-2 text-xs text-muted-foreground">{machine.message}</span>}
                    </div>
                  ))}
                </div>
              )}

              {machineFormOpen && (
                <div className="space-y-3">
                  {machineSetupFields.map((field) => (
                    <label key={field.id} className="block text-xs text-foreground">
                      {field.label} {!field.required && <span className="text-muted-foreground/70">(optional)</span>}
                      <input
                        value={machineFormFields[field.id]}
                        onChange={(event) => {
                          const { value } = event.target;
                          setMachineFormFields((prev) => ({ ...prev, [field.id]: value }));
                          setMachineCheckError(null);
                        }}
                        type={field.id === 'port' || field.id === 'maxConcurrentTasks' ? 'number' : 'text'}
                        placeholder={field.placeholder}
                        className="mt-1 w-full rounded border border-border-strong bg-card px-2 py-1.5 text-sm text-foreground"
                      />
                    </label>
                  ))}

                  {machineCheckError && (
                    <div className="rounded border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                      {machineCheckError}
                    </div>
                  )}

                  <button
                    onClick={submitMachineForm}
                    disabled={machineCheckPending || !machineRequiredFieldsComplete}
                    className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-secondary disabled:text-muted-foreground text-white rounded text-sm font-medium transition-colors"
                  >
                    {machineCheckPending ? 'Checking machine…' : 'Check and add machine'}
                  </button>
                </div>
              )}

              {!machineFormOpen && !machinesStepDone && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setMachineFormOpen(true)}
                    className="px-3 py-2 bg-muted hover:bg-accent text-white rounded text-sm transition-colors"
                  >
                    Add another machine
                  </button>
                  <button
                    onClick={() => setMachinesStepDone(true)}
                    className="px-3 py-2 bg-primary hover:bg-primary/90 text-white rounded text-sm font-medium transition-colors"
                  >
                    Done adding machines
                  </button>
                </div>
              )}

              {machineCloseConfirmOpen && (
                <div className="rounded border border-amber-600/50 bg-amber-950/40 px-3 py-3 text-sm text-amber-100">
                  <div className="font-medium">Discard machine details?</div>
                  <div className="mt-1 text-amber-100/90">
                    You entered machine fields that haven&apos;t been added yet. Closing now will discard them.
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={onClose}
                      className="px-3 py-2 bg-red-700 hover:bg-red-600 text-white rounded text-sm font-medium transition-colors"
                    >
                      Discard and close
                    </button>
                    <button
                      onClick={() => setMachineCloseConfirmOpen(false)}
                      className="px-3 py-2 bg-muted hover:bg-accent text-white rounded text-sm transition-colors"
                    >
                      Keep editing
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {diagnostics && installedAgents.length === 0 && (
            <div className="rounded border border-amber-600/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
              No execution agent CLI is installed yet. Install Claude CLI or Codex CLI before running agent-backed tasks.
            </div>
          )}

          {bundledSkills?.available && (
            <div className="rounded border border-indigo-700/60 bg-indigo-950/30 px-4 py-4 space-y-3">
              <div>
                <div className="text-sm font-medium text-indigo-100">Invoker AI helpers</div>
                <div className="text-sm text-indigo-200/80 mt-1">
                  Install first-party skills, slash commands, and the OMP MCP entry. Then use /invoker-plan-to-invoker in your harness to plan first, generate Invoker YAML, and submit it to the running Invoker app.
                </div>
              </div>

              <div className="rounded bg-card/60 border border-border px-3 py-2 text-sm text-foreground font-mono">
                <code>/invoker-plan-to-invoker &quot;help me plan &lt;change&gt;&quot;</code>
              </div>

              <div className="text-sm text-muted-foreground">
                Bundled skills: {bundledSkills.bundledSkillNames.length > 0
                  ? bundledSkills.bundledSkillNames.map((name) => `${bundledSkills.managedPrefix}${name}`).join(', ')
                  : 'none'}
              </div>

              {bundledSkills.targets.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Skills</div>
                  <div className="rounded border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-background text-muted-foreground">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Target</th>
                          <th className="text-left px-4 py-2 font-medium">Path</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bundledSkills.targets.map((target) => (
                          <tr key={target.id} className="border-t border-border">
                            <td className="px-4 py-3 text-foreground">{target.name}</td>
                            <td className="px-4 py-3 text-muted-foreground font-mono text-xs break-all">{target.path}</td>
                            <td className="px-4 py-3">
                              <div className={target.upToDate ? 'text-green-400' : target.installed ? 'text-yellow-300' : 'text-amber-300'}>
                                {target.upToDate ? 'Installed and up to date' : target.installed ? 'Installed, update available' : 'Not installed'}
                              </div>
                              {target.diagnostic && (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {target.diagnostic}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {bundledSkills.commandTargets.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Commands</div>
                  <div className="rounded border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-background text-muted-foreground">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Target</th>
                          <th className="text-left px-4 py-2 font-medium">Path</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bundledSkills.commandTargets.map((target) => (
                          <tr key={target.id} className="border-t border-border">
                            <td className="px-4 py-3 text-foreground">{target.name}</td>
                            <td className="px-4 py-3 text-muted-foreground font-mono text-xs break-all">{target.path}</td>
                            <td className="px-4 py-3">
                              <span className={target.upToDate ? 'text-green-400' : target.installed ? 'text-yellow-300' : 'text-amber-300'}>
                                {target.upToDate ? 'Installed and up to date' : target.installed ? 'Installed, update available' : 'Not installed'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {bundledSkills.mcpTargets.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">MCP</div>
                  <div className="rounded border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-background text-muted-foreground">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Target</th>
                          <th className="text-left px-4 py-2 font-medium">Path</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bundledSkills.mcpTargets.map((target) => (
                          <tr key={target.id} className="border-t border-border">
                            <td className="px-4 py-3 text-foreground">{target.name}</td>
                            <td className="px-4 py-3 text-muted-foreground font-mono text-xs break-all">{target.path}</td>
                            <td className="px-4 py-3">
                              <span className={target.upToDate ? 'text-green-400' : target.installed ? 'text-yellow-300' : 'text-amber-300'}>
                                {target.upToDate ? 'Installed and up to date' : target.installed ? 'Installed, update available' : 'Not installed'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {bundledSkills.lastInstallError && (
                <div className="rounded border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                  Last install error: {bundledSkills.lastInstallError}
                </div>
              )}

              {installError && (
                <div className="rounded border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                  {installError}
                </div>
              )}

              {canInstallBundledSkills && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onInstallBundledSkills?.(installActionMode)}
                    disabled={installPending}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:text-indigo-200 text-white rounded text-sm font-medium transition-colors"
                  >
                    {installPending ? 'Installing…' : installActionLabel}
                  </button>
                  {helperTargets.some((target) => target.installed) && (
                    <button
                      onClick={() => onInstallBundledSkills?.('reinstall')}
                      disabled={installPending}
                      className="px-4 py-2 bg-muted hover:bg-accent disabled:bg-secondary disabled:text-muted-foreground text-white rounded text-sm font-medium transition-colors"
                    >
                      Reinstall Helpers
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {cliInstaller?.supported && (
            <div className="rounded border border-indigo-700/60 bg-indigo-950/30 px-4 py-4 space-y-3">
              <div>
                <div className="text-sm font-medium text-indigo-100">Invoker CLI</div>
                <div className="text-sm text-indigo-200/80 mt-1">
                  The `invoker-cli` command is installed onto your PATH and kept at the app&apos;s version.
                </div>
              </div>

              <div className="text-sm text-muted-foreground">
                {cliInstaller.installedVersion
                  ? `Installed ${cliInstaller.installedVersion} at ${cliInstaller.installedPath} — app version ${cliInstaller.bundledVersion}`
                  : 'Not installed'}
                {' '}
                <span className={cliInstaller.upToDate ? 'text-green-400' : cliInstaller.installedVersion ? 'text-yellow-300' : 'text-amber-300'}>
                  {cliInstaller.upToDate ? 'Up to date' : cliInstaller.installedVersion ? 'Update available' : ''}
                </span>
              </div>

              {cliInstaller.warning && (
                <div className="rounded border border-amber-600/50 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
                  {cliInstaller.warning}
                </div>
              )}

              {(cliInstaller.lastInstallError || updateCliError) && (
                <div className="rounded border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                  {updateCliError ?? cliInstaller.lastInstallError}
                </div>
              )}

              {onUpdateInvokerCli && !cliInstaller.upToDate && (
                <button
                  onClick={() => onUpdateInvokerCli()}
                  disabled={updateCliPending}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:text-indigo-200 text-white rounded text-sm font-medium transition-colors"
                >
                  {updateCliPending ? 'Updating…' : cliInstaller.installedVersion ? 'Update invoker-cli' : 'Install invoker-cli'}
                </button>
              )}
            </div>
          )}

          {readinessChecks?.length ? (
            <div className="rounded border border-border bg-card/20 overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-background">
                <div className="text-sm font-medium text-foreground">Readiness</div>
              </div>
              <div className="divide-y divide-gray-700">
                {readinessChecks.map((check) => {
                  const statusClasses = readinessStatusClasses[check.status];
                  return (
                    <div key={check.id} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${statusClasses.dot}`} aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-medium text-foreground">{check.name}</div>
                            <span className={`rounded border px-2 py-0.5 text-xs font-medium uppercase ${statusClasses.badge}`}>
                              {check.status}
                            </span>
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">{check.detail}</div>
                          {check.status !== 'ok' && check.remediation && (
                            <div className={`mt-2 text-sm ${statusClasses.text}`}>
                              {check.remediation}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="rounded border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setSystemDetailsOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-4 border-b border-border bg-background px-4 py-3 text-left"
            >
              <span>
                <span className="block text-sm font-medium text-foreground">System check details</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Full diagnostic table. Open only when you need the raw checks.
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{systemDetailsOpen ? 'Hide' : 'Show'}</span>
            </button>
            {systemDetailsOpen && (
              <table className="w-full text-sm">
                <thead className="bg-background text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Tool</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium">Version</th>
                    <th className="text-left px-4 py-2 font-medium">Hint</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics?.tools.map((tool) => (
                    <tr key={tool.id} className="border-t border-border">
                      <td className="px-4 py-3 text-foreground">
                        {tool.name}
                        {tool.required && <span className="ml-2 text-xs text-red-300">required</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={tool.installed ? 'text-green-400' : tool.required ? 'text-red-400' : 'text-yellow-300'}>
                          {tool.installed ? 'Installed' : tool.required ? 'Missing' : 'Optional'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{tool.version ?? '—'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{tool.installHint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border sm:justify-end">
          <Button type="button" onClick={requestCloseModal}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
