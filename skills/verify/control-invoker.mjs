#!/usr/bin/env node

import { resolveRepoRoot, featuresDir } from './lib/repo.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { runProve, resolveProve } from './lib/prove.mjs';
import { runCatalogCheck } from './lib/catalog.mjs';
import { runOwner } from './lib/owner.mjs';
import { runVisualProof } from './lib/visual-proof.mjs';
import { runDrive } from './lib/drive.mjs';
import { loadFeatureMap } from './lib/feature-map.mjs';

function printHelp() {
  console.log(`control-invoker — verify Invoker UI/live-path via existing levers

Commands:
  doctor [--json] [--skip-cli-doctor]
      invoker-cli doctor + UI/app build freshness + Playwright + feature map

  prove <feature-id> [--dry-run] [--json]
      Run the prove: command from references/features/<id>.md

  catalog --check [--json]
      Drift gate: required sidebar testids + prove paths must exist

  catalog --list [--json]
      List feature ids and prove commands

  visual-proof <capture-before|capture-after|compare|embed|validate> [--dry-run]
      Thin wrap of scripts/ui-visual-proof.sh

  owner <invoker-ctl-or-query-args...> [--dry-run] [--json]
      Wrap ./invoker-ctl or invoker-cli query/wait.
      Destructive cmds (cancel/approve/delete/...) require omit --dry-run to run.

  snapshot|screenshot|click|aria-click|press|send [--dry-run] [--json]
      Drive an isolated Electron build (never the user's open window).
      click --testid <id>
      aria-click --name <label> [--role button]
      press --key <Meta+K>
      screenshot [--out path.png]
      send --text <message>

Flags:
  --json          machine-readable stdout
  --dry-run       print/resolve without side effects
  --help, -h      this help
`);
}

function parseArgs(argv) {
  const flags = new Set();
  const kv = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json' || a === '--dry-run' || a === '--skip-cli-doctor' || a === '--check' || a === '--list' || a === '--help' || a === '-h') {
      flags.add(a);
      continue;
    }
    if (a.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      kv[a.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    positional.push(a);
  }
  return { flags, kv, positional };
}

function emit(jsonMode, payload, exitCode) {
  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.error) {
    console.error(payload.error);
  } else if (typeof payload.stdout === 'string' && payload.stdout) {
    process.stdout.write(payload.stdout.endsWith('\n') ? payload.stdout : `${payload.stdout}\n`);
  } else if (payload.detail) {
    console.log(payload.detail);
  } else if (payload.command) {
    console.log(payload.command);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
  if (payload.stderr && !jsonMode) {
    process.stderr.write(payload.stderr.endsWith('\n') ? payload.stderr : `${payload.stderr}\n`);
  }
  process.exitCode = exitCode;
}

async function main() {
  const { flags, kv, positional } = parseArgs(process.argv.slice(2));
  if (flags.has('--help') || flags.has('-h') || positional.length === 0) {
    printHelp();
    process.exitCode = positional.length === 0 && !flags.has('--help') && !flags.has('-h') ? 1 : 0;
    return;
  }

  const jsonMode = flags.has('--json');
  const dryRun = flags.has('--dry-run');
  const repoRoot = resolveRepoRoot();
  const featuresRoot = featuresDir(repoRoot);
  const cmd = positional[0];

  if (cmd === 'doctor') {
    const result = runDoctor({ repoRoot, skipCliDoctor: flags.has('--skip-cli-doctor') });
    if (jsonMode) {
      emit(true, result, result.ok ? 0 : 1);
      return;
    }
    for (const check of result.checks) {
      console.log(`${check.ok ? 'OK' : 'FAIL'}  ${check.name}: ${check.detail}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (cmd === 'prove') {
    const featureId = positional[1];
    if (!featureId) {
      emit(jsonMode, { error: 'prove requires <feature-id>' }, 1);
      return;
    }
    if (dryRun) {
      const resolved = resolveProve(featuresRoot, featureId);
      emit(jsonMode, resolved.ok
        ? { ok: true, dryRun: true, feature: resolved.feature.id, command: resolved.command, testids: resolved.feature.testids }
        : { ok: false, error: resolved.error }, resolved.ok ? 0 : 1);
      return;
    }
    const result = runProve({ featuresRoot, featureId, repoRoot, dryRun: false });
    emit(jsonMode, result, result.exitCode);
    return;
  }

  if (cmd === 'catalog') {
    if (flags.has('--list')) {
      const features = loadFeatureMap(featuresRoot);
      const payload = features.map((f) => ({ id: f.id, prove: f.prove, testids: f.testids }));
      if (jsonMode) console.log(JSON.stringify(payload, null, 2));
      else for (const f of payload) console.log(`${f.id}\t${f.prove}`);
      process.exitCode = 0;
      return;
    }
    if (!flags.has('--check')) {
      emit(jsonMode, { error: 'catalog requires --check or --list' }, 1);
      return;
    }
    const result = runCatalogCheck({ featuresRoot, repoRoot });
    if (jsonMode) {
      emit(true, result, result.ok ? 0 : 1);
      return;
    }
    for (const w of result.warnings) console.warn(`WARN  ${w}`);
    for (const e of result.errors) console.error(`FAIL  ${e}`);
    if (result.ok) console.log(`OK  catalog --check (${result.featureCount} features)`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (cmd === 'visual-proof') {
    const sub = positional[1];
    if (!sub) {
      emit(jsonMode, { error: 'visual-proof requires a subcommand' }, 1);
      return;
    }
    const result = runVisualProof({ repoRoot, subcommand: sub, extraArgs: positional.slice(2), dryRun });
    emit(jsonMode, result, result.exitCode);
    return;
  }

  if (cmd === 'owner') {
    const result = runOwner({ repoRoot, args: positional.slice(1), dryRun });
    emit(jsonMode, result, result.exitCode);
    return;
  }

  const driveActions = new Set(['snapshot', 'screenshot', 'click', 'aria-click', 'press', 'send']);
  if (driveActions.has(cmd)) {
    const result = await runDrive({
      repoRoot,
      action: cmd,
      args: kv,
      dryRun,
    });
    emit(jsonMode, result, result.exitCode ?? (result.ok ? 0 : 1));
    return;
  }

  emit(jsonMode, { error: `unknown command: ${cmd}` }, 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
