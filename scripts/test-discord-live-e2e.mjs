#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, REQUIRED_ENV, assertTestGuild, main } from './discord-live-e2e.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'discord-live-e2e.mjs');
const TOKEN = 'test-token-value-must-never-be-printed';
const GUILD = '200000000000000001';
const OTHER_GUILD = '200000000000000777';
const CHANNEL = '300000000000000001';
const CONFIGURED = { DISCORD_BOT_TOKEN: TOKEN, DISCORD_TEST_GUILD_ID: GUILD, DISCORD_TEST_CHANNEL_ID: CHANNEL };
const NETWORK_ATTEMPT_EXIT = 97;

const BLOCK_NETWORK = [
  "import net from 'node:net';",
  "import dns from 'node:dns';",
  'const block = (what) => () => {',
  "  process.stderr.write(`NETWORK_ATTEMPT ${what}\\n`);",
  `  process.exit(${NETWORK_ATTEMPT_EXIT});`,
  '};',
  "net.Socket.prototype.connect = block('net.Socket.connect');",
  "dns.lookup = block('dns.lookup');",
  "dns.promises.lookup = block('dns.promises.lookup');",
  "globalThis.fetch = block('fetch');",
  "globalThis.WebSocket = block('WebSocket');",
].join('\n');

function harness(args, env) {
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(BLOCK_NETWORK)}`, SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(!output.includes('NETWORK_ATTEMPT'), `the harness attempted a network call:\n${output}`);
  assert.ok(!output.includes(TOKEN), `the harness printed the bot token:\n${output}`);
  return { status: result.status, output };
}

const refuseRuntime = () => {
  const calls = [];
  return { calls, loadRuntime: async () => { calls.push('loadRuntime'); throw new Error('the live runtime must not load'); } };
};

let passed = 0;
async function test(name, body) {
  await body();
  passed += 1;
  console.log(`ok - ${name}`);
}

await test('pass, fail and unchecked-because-unconfigured have three distinct exit codes', () => {
  assert.deepEqual(EXIT_CODES, { pass: 0, fail: 1, unconfigured: 2 });
  assert.equal(new Set(Object.values(EXIT_CODES)).size, 3);
});

await test('--check-config exits 0 with configuration present and makes no network call', () => {
  const { status, output } = harness(['--check-config'], CONFIGURED);
  assert.equal(status, EXIT_CODES.pass, output);
  assert.match(output, /discord-live-e2e: PASS \[CONFIG_OK\]/);
  assert.match(output, new RegExp(`refuses ${GUILD.slice(0, -1)}2`));
  assert.match(output, /no network call was made/);
});

await test('--check-config exits non-zero as UNCHECKED with configuration absent', () => {
  const { status, output } = harness(['--check-config'], {});
  assert.equal(status, EXIT_CODES.unconfigured, output);
  assert.notEqual(status, EXIT_CODES.pass);
  assert.match(output, /discord-live-e2e: UNCHECKED \[UNCONFIGURED\] missing DISCORD_BOT_TOKEN, DISCORD_TEST_GUILD_ID, DISCORD_TEST_CHANNEL_ID/);
  assert.doesNotMatch(output, /PASS/);
});

await test('each credential alone missing or blank is named and exits as unconfigured', () => {
  for (const name of REQUIRED_ENV) {
    for (const value of [undefined, '   ']) {
      const env = { ...CONFIGURED };
      if (value === undefined) delete env[name];
      else env[name] = value;
      const { status, output } = harness(['--check-config'], env);
      assert.equal(status, EXIT_CODES.unconfigured, `${name}=${JSON.stringify(value)}: ${output}`);
      assert.match(output, new RegExp(`UNCHECKED \\[UNCONFIGURED\\] missing ${name};`));
    }
  }
});

await test('an unconfigured live run exits non-zero rather than reporting success', async () => {
  const { status, output } = harness([], {});
  assert.equal(status, EXIT_CODES.unconfigured, output);
  assert.doesNotMatch(output, /PASS/);
  assert.match(output, /was not checked, and this is not a pass/);

  const runtime = refuseRuntime();
  const result = await main({ argv: [], env: {}, deps: runtime });
  assert.equal(result.outcome, 'unconfigured');
  assert.notEqual(EXIT_CODES[result.outcome], EXIT_CODES.pass);
  assert.deepEqual(runtime.calls, []);
});

await test('a guild other than DISCORD_TEST_GUILD_ID aborts before any network call', async () => {
  const runtime = refuseRuntime();
  const result = await main({ argv: ['--guild', OTHER_GUILD], env: CONFIGURED, deps: runtime });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'GUILD_GUARD_REFUSED');
  assert.match(result.detail, new RegExp(`guild ${OTHER_GUILD} \\(from --guild\\)`));
  assert.match(result.detail, new RegExp(`DISCORD_TEST_GUILD_ID=${GUILD}`));
  assert.deepEqual(runtime.calls, [], 'the live runtime, and with it the Discord client, was loaded before the guard ran');

  for (const args of [['--guild', OTHER_GUILD], [`--guild=${OTHER_GUILD}`], ['--check-config', '--guild', OTHER_GUILD]]) {
    const { status, output } = harness(args, CONFIGURED);
    assert.equal(status, EXIT_CODES.fail, `${args.join(' ')}: ${output}`);
    assert.match(output, new RegExp(`FAIL \\[GUILD_GUARD_REFUSED\\] refusing to act on guild ${OTHER_GUILD}`));
    assert.match(output, new RegExp(GUILD));
  }
});

await test('the guard accepts only the exact test guild id', () => {
  assert.doesNotThrow(() => assertTestGuild(GUILD, GUILD, 'test'));
  for (const other of [OTHER_GUILD, undefined, '', ` ${GUILD}`, `${GUILD}0`]) {
    assert.throws(() => assertTestGuild(other, GUILD, 'test'), (error) => error.reason === 'GUILD_GUARD_REFUSED');
  }
});

await test('a guild matching DISCORD_TEST_GUILD_ID passes the guard and only then loads the runtime', async () => {
  const runtime = refuseRuntime();
  const result = await main({ argv: ['--guild', GUILD], env: CONFIGURED, deps: runtime });
  assert.deepEqual(runtime.calls, ['loadRuntime']);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'HARNESS_ERROR');
});

await test('malformed ids and unknown arguments fail with a named reason', () => {
  const malformed = harness(['--check-config'], { ...CONFIGURED, DISCORD_TEST_GUILD_ID: 'my-server' });
  assert.equal(malformed.status, EXIT_CODES.fail, malformed.output);
  assert.match(malformed.output, /FAIL \[INVALID_CONFIG\] not a Discord snowflake id: DISCORD_TEST_GUILD_ID="my-server"/);

  const unknown = harness(['--skip-guard'], CONFIGURED);
  assert.equal(unknown.status, EXIT_CODES.fail, unknown.output);
  assert.match(unknown.output, /FAIL \[USAGE\] unknown argument --skip-guard/);
});

await test('--help prints usage and exits 0 without a verdict', () => {
  const { status, output } = harness(['--help'], {});
  assert.equal(status, 0, output);
  assert.match(output, /^Usage: node scripts\/discord-live-e2e\.mjs/);
  assert.doesNotMatch(output, /discord-live-e2e: (PASS|FAIL|UNCHECKED)/);
});

console.log(`\n${passed} discord-live-e2e guard tests passed`);
