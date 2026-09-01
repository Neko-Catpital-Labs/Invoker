
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProve } from '../lib/prove.mjs';
import { featuresDir, resolveRepoRoot } from '../lib/repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRoot(__dirname);
const featuresRoot = featuresDir(repoRoot);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const FIRE_CASES = [
  {
    id: 'attention',
    promptIncludes: ['attention surface'],
    proveMustInclude: 'attention-click-hitch-responsiveness.spec.ts',
  },
  {
    id: 'command-palette',
    promptIncludes: ['Cmd+K', 'command palette'],
    proveMustInclude: 'command-palette-open.spec.ts',
  },
  {
    id: 'workers',
    promptIncludes: ['workers surface', 'sidebar-workers'],
    proveMustInclude: 'workers-surface.spec.ts',
  },
  {
    id: 'terminal-drawer',
    promptIncludes: ['terminal drawer', 'embedded terminal'],
    proveMustInclude: 'embedded-terminal-pty.spec.ts',
  },
  {
    id: 'history-timeline',
    promptIncludes: ['history timeline'],
    proveMustInclude: 'ui-delta-timeline.spec.ts',
  },
  {
    id: 'home',
    promptIncludes: ['home surface'],
    proveMustInclude: 'keyboard-navigation.spec.ts',
  },
  {
    id: 'merge-gate',
    promptIncludes: ['merge gate'],
    proveMustInclude: 'pending-review-gate-target-repo.proof.spec.ts',
  },
  {
    id: 'modals',
    promptIncludes: ['modal flow'],
    proveMustInclude: 'fix-with-agent-transition.spec.ts',
  },
  {
    id: 'multi-surface-journeys',
    promptIncludes: ['multi-surface journey'],
    proveMustInclude: 'keyboard-navigation.spec.ts',
  },
  {
    id: 'plan-graph',
    promptIncludes: ['plan graph'],
    proveMustInclude: 'visual-proof.spec.ts',
  },
  {
    id: 'queue-task-panel',
    promptIncludes: ['queue task panel'],
    proveMustInclude: 'queue-running-vs-queued.spec.ts',
  },
  {
    id: 'system-setup',
    promptIncludes: ['system setup'],
    proveMustInclude: 'system-setup-visual-proof.spec.ts',
  },
  {
    id: 'workflows',
    promptIncludes: ['workflow surface'],
    proveMustInclude: 'workflow-lifecycle.spec.ts',
  },
  {
    id: 'visual-proof-pr-path',
    promptIncludes: ['before/after', 'visual proof'],
    proveMustInclude: 'scripts/ui-visual-proof.sh',
  },
];

const firesPath = join(__dirname, 'fires_example.md');
const silentPath = join(__dirname, 'stays_silent_example.md');

{
  const fires = readFileSync(firesPath, 'utf8');
  assert(fires.includes('prove command-palette'), 'fires_example must name prove command-palette');
  assert(fires.includes('control-invoker'), 'fires_example must name control-invoker');
  assert(fires.includes('Do not ask the human'), 'fires_example must forbid human-as-verifier');

  const silent = readFileSync(silentPath, 'utf8');
  assert(silent.includes('does not apply'), 'stays_silent_example must say verify does not apply');
  assert(silent.includes('packages/contracts'), 'stays_silent_example must be a non-UI contracts change');
  assert(!silent.includes('prove command-palette'), 'stays_silent must not route to a UI prove');
  console.log('OK efficacy fixtures present');
}

for (const c of FIRE_CASES) {
  const resolved = resolveProve(featuresRoot, c.id);
  assert(resolved.ok, `resolveProve(${c.id}) failed: ${resolved.error}`);
  assert(
    resolved.command.includes(c.proveMustInclude),
    `${c.id}: expected prove to include ${c.proveMustInclude}, got ${resolved.command}`,
  );
  console.log(`OK route ${c.id} → ${c.proveMustInclude}`);
}

{
  const bad = resolveProve(featuresRoot, 'not-a-real-surface');
  assert(!bad.ok, 'unknown feature must fail closed');
  console.log('OK unknown feature fails closed');
}

console.log('OK: verify efficacy router tests passed');
