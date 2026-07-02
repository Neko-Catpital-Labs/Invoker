import type { SystemDiagnostics } from '@invoker/contracts';

interface SystemSetupModalProps {
  diagnostics: SystemDiagnostics | null;
  installPending?: boolean;
  installError?: string | null;
  onInstallBundledSkills?: (mode?: 'install' | 'update' | 'reinstall') => void;
  updateCliPending?: boolean;
  updateCliError?: string | null;
  onUpdateInvokerCli?: () => void;
  onClose: () => void;
}

export function SystemSetupModal({
  diagnostics,
  installPending = false,
  installError = null,
  onInstallBundledSkills,
  updateCliPending = false,
  updateCliError = null,
  onUpdateInvokerCli,
  onClose,
}: SystemSetupModalProps) {
  const installedAgents = diagnostics?.tools.filter((tool) => (tool.id === 'claude' || tool.id === 'codex') && tool.installed) ?? [];
  const bundledSkills = diagnostics?.bundledSkills;
  const cliInstaller = diagnostics?.cliInstaller;
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col border border-gray-700">
        <div className="p-6 pb-3 shrink-0">
          <h2 className="text-lg font-semibold text-gray-100">System Setup</h2>
          <p className="text-sm text-gray-400 mt-1">
            {diagnostics
              ? `Invoker ${diagnostics.appVersion} on ${diagnostics.platform}/${diagnostics.arch}${diagnostics.isPackaged ? ' (packaged app)' : ' (repo/dev mode)'}`
              : 'Loading system diagnostics...'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
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

              <div className="rounded bg-gray-950/60 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono">
                <code>/invoker-plan-to-invoker &quot;help me plan &lt;change&gt;&quot;</code>
              </div>

              <div className="text-sm text-gray-300">
                Bundled skills: {bundledSkills.bundledSkillNames.length > 0
                  ? bundledSkills.bundledSkillNames.map((name) => `${bundledSkills.managedPrefix}${name}`).join(', ')
                  : 'none'}
              </div>

              {bundledSkills.targets.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-gray-400">Skills</div>
                  <div className="rounded border border-gray-700 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-900 text-gray-300">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Target</th>
                          <th className="text-left px-4 py-2 font-medium">Path</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bundledSkills.targets.map((target) => (
                          <tr key={target.id} className="border-t border-gray-700">
                            <td className="px-4 py-3 text-gray-100">{target.name}</td>
                            <td className="px-4 py-3 text-gray-400 font-mono text-xs break-all">{target.path}</td>
                            <td className="px-4 py-3">
                              <div className={target.upToDate ? 'text-green-400' : target.installed ? 'text-yellow-300' : 'text-amber-300'}>
                                {target.upToDate ? 'Installed and up to date' : target.installed ? 'Installed, update available' : 'Not installed'}
                              </div>
                              {target.diagnostic && (
                                <div className="mt-1 text-xs text-gray-400">
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
                  <div className="text-xs uppercase tracking-wide text-gray-400">Commands</div>
                  <div className="rounded border border-gray-700 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-900 text-gray-300">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Target</th>
                          <th className="text-left px-4 py-2 font-medium">Path</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bundledSkills.commandTargets.map((target) => (
                          <tr key={target.id} className="border-t border-gray-700">
                            <td className="px-4 py-3 text-gray-100">{target.name}</td>
                            <td className="px-4 py-3 text-gray-400 font-mono text-xs break-all">{target.path}</td>
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
                  <div className="text-xs uppercase tracking-wide text-gray-400">MCP</div>
                  <div className="rounded border border-gray-700 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-900 text-gray-300">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Target</th>
                          <th className="text-left px-4 py-2 font-medium">Path</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bundledSkills.mcpTargets.map((target) => (
                          <tr key={target.id} className="border-t border-gray-700">
                            <td className="px-4 py-3 text-gray-100">{target.name}</td>
                            <td className="px-4 py-3 text-gray-400 font-mono text-xs break-all">{target.path}</td>
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
                      className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded text-sm font-medium transition-colors"
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

              <div className="text-sm text-gray-300">
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

          <div className="rounded border border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-300">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Tool</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Version</th>
                  <th className="text-left px-4 py-2 font-medium">Hint</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics?.tools.map((tool) => (
                  <tr key={tool.id} className="border-t border-gray-700">
                    <td className="px-4 py-3 text-gray-100">
                      {tool.name}
                      {tool.required && <span className="ml-2 text-xs text-red-300">required</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={tool.installed ? 'text-green-400' : tool.required ? 'text-red-400' : 'text-yellow-300'}>
                        {tool.installed ? 'Installed' : tool.required ? 'Missing' : 'Optional'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs">{tool.version ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-400">{tool.installHint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
