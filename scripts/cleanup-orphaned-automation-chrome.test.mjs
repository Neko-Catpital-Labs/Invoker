import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  extractUserDataDir,
  findOrphanedAutomationChromeGroups,
  findTrackedBrowserGroups,
  formatGroup,
  isAutomationChromeCommand,
  mergeGroups,
  parsePsSnapshot,
  readTrackedUserDataDirs,
} from './cleanup-orphaned-automation-chrome.mjs';

const orphanChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --enable-automation --headless=new --user-data-dir=/tmp/puppeteer_dev_chrome_profile-abc';
const orphanHelper = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper --type=gpu-process --headless=new --user-data-dir=/tmp/puppeteer_dev_chrome_profile-abc';
const liveChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --enable-automation --headless=new --user-data-dir=/tmp/puppeteer_dev_chrome_profile-live';
const desktopChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const trackedElectron = '/Users/test/electron packages/app/dist/main.js --user-data-dir=/tmp/invoker-e2e-123/electron-user-data';

describe('cleanup-orphaned-automation-chrome', () => {
  it('recognizes Puppeteer headless Chrome commands only', () => {
    assert.equal(isAutomationChromeCommand(orphanChrome), true);
    assert.equal(isAutomationChromeCommand(desktopChrome), false);
    assert.equal(isAutomationChromeCommand(`${orphanChrome} --headless=old`.replace('--headless=new', '')), false);
  });

  it('extracts user-data-dir from process command lines', () => {
    assert.equal(extractUserDataDir(orphanChrome), '/tmp/puppeteer_dev_chrome_profile-abc');
    assert.equal(extractUserDataDir(desktopChrome), undefined);
  });

  it('parses ps snapshots with command payloads', () => {
    const rows = parsePsSnapshot(`58744 1 58744 ${orphanChrome}\n58812 58744 58744 ${orphanHelper}\n`);
    assert.deepEqual(rows, [
      { pid: 58744, ppid: 1, pgid: 58744, command: orphanChrome },
      { pid: 58812, ppid: 58744, pgid: 58744, command: orphanHelper },
    ]);
  });

  it('groups orphaned automation Chrome by process group', () => {
    const groups = findOrphanedAutomationChromeGroups([
      { pid: 58744, ppid: 1, pgid: 58744, command: orphanChrome },
      { pid: 58812, ppid: 58744, pgid: 58744, command: orphanHelper },
      { pid: 2146, ppid: 30346, pgid: 2146, command: liveChrome },
      { pid: 25754, ppid: 1, pgid: 25754, command: desktopChrome },
    ]);
    assert.deepEqual(groups, [{
      pgid: 58744,
      pids: [58744, 58812],
      profiles: ['/tmp/puppeteer_dev_chrome_profile-abc'],
    }]);
  });

  it('finds tracked browser groups by user-data-dir even when not orphaned', () => {
    const groups = findTrackedBrowserGroups([
      { pid: 7000, ppid: 6999, pgid: 7000, command: trackedElectron },
      { pid: 7001, ppid: 7000, pgid: 7000, command: `${trackedElectron} --type=renderer` },
      { pid: 7002, ppid: 6999, pgid: 7002, command: liveChrome },
    ], ['/tmp/invoker-e2e-123/electron-user-data']);
    assert.deepEqual(groups, [{
      pgid: 7000,
      pids: [7000, 7001],
      profiles: ['/tmp/invoker-e2e-123/electron-user-data'],
    }]);
  });

  it('reads tracked user-data-dirs from a registry file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-registry-test-'));
    const registryPath = path.join(dir, 'user-data-dirs.txt');
    writeFileSync(registryPath, '/tmp/a\n/tmp/b\n/tmp/a\n', 'utf8');
    assert.deepEqual(readTrackedUserDataDirs(registryPath), ['/tmp/a', '/tmp/b']);
  });

  it('merges orphaned and tracked groups by process group', () => {
    const merged = mergeGroups(
      [{ pgid: 58744, pids: [58744], profiles: ['/tmp/puppeteer_dev_chrome_profile-abc'] }],
      [{ pgid: 58744, pids: [58812], profiles: ['/tmp/puppeteer_dev_chrome_profile-abc'] }],
    );
    assert.deepEqual(merged, [{
      pgid: 58744,
      pids: [58744, 58812],
      profiles: ['/tmp/puppeteer_dev_chrome_profile-abc'],
    }]);
  });

  it('formats cleanup output with pgid pids and profile', () => {
    assert.equal(
      formatGroup({ pgid: 58744, pids: [58744, 58812], profiles: ['/tmp/puppeteer_dev_chrome_profile-abc'] }),
      'pgid=58744 pids=58744,58812 profiles=/tmp/puppeteer_dev_chrome_profile-abc',
    );
  });
});
