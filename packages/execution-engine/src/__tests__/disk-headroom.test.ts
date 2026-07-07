import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DISK_CHECK_INTERVAL_MS,
  DEFAULT_DISK_CRITICAL_PERCENT,
  DEFAULT_DISK_WARN_PERCENT,
  evaluateDiskHeadroom,
  parseDfOutput,
  resolveDiskCheckIntervalMs,
  resolveDiskHeadroomThresholds,
} from '../workers/disk-headroom.js';

const LINUX_DF = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/vda1         81071768 34567890  46503878      43% /`;

describe('parseDfOutput', () => {
  it('parses a standard linux `df -P -k` row', () => {
    const parsed = parseDfOutput(LINUX_DF);
    expect(parsed).not.toBeNull();
    expect(parsed?.filesystem).toBe('/dev/vda1');
    expect(parsed?.usedPercent).toBe(43);
    expect(parsed?.mountedOn).toBe('/');
  });

  it('rejoins a mount point that contains spaces', () => {
    const out = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk1s1 100 10 90 10% /Volumes/My Drive`;
    const parsed = parseDfOutput(out);
    expect(parsed?.mountedOn).toBe('/Volumes/My Drive');
  });

  it('reads the capacity column as the used percent', () => {
    const out = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 100 1 99 77% /`;
    expect(parseDfOutput(out)?.usedPercent).toBe(77);
  });

  it('returns null for header-only output', () => {
    expect(parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on')).toBeNull();
  });

  it('returns null for malformed / short rows', () => {
    expect(parseDfOutput('Filesystem 1024-blocks Used')).toBeNull();
  });
});

describe('evaluateDiskHeadroom', () => {
  const thresholds = { warnPercent: 85, criticalPercent: 95 };
  const usage = (usedPercent: number) => ({
    filesystem: '/dev/vda1',
    blocks1024: 100,
    usedBlocks1024: usedPercent,
    availableBlocks1024: 100 - usedPercent,
    usedPercent,
    mountedOn: '/',
  });

  it('is ok below the warn threshold', () => {
    expect(evaluateDiskHeadroom(usage(84), thresholds, 'local /').level).toBe('ok');
  });

  it('warns at exactly the warn threshold', () => {
    expect(evaluateDiskHeadroom(usage(85), thresholds, 'local /').level).toBe('warn');
  });

  it('stays warn between warn and critical', () => {
    expect(evaluateDiskHeadroom(usage(94), thresholds, 'local /').level).toBe('warn');
  });

  it('is critical at exactly the critical threshold and above', () => {
    expect(evaluateDiskHeadroom(usage(95), thresholds, 'local /').level).toBe('critical');
    expect(evaluateDiskHeadroom(usage(99), thresholds, 'local /').level).toBe('critical');
  });
});

describe('resolveDiskHeadroomThresholds', () => {
  it('defaults to 85/95', () => {
    expect(resolveDiskHeadroomThresholds({} as NodeJS.ProcessEnv)).toEqual({
      warnPercent: DEFAULT_DISK_WARN_PERCENT,
      criticalPercent: DEFAULT_DISK_CRITICAL_PERCENT,
    });
  });

  it('reads from env and clamps critical >= warn', () => {
    expect(
      resolveDiskHeadroomThresholds({
        INVOKER_DISK_WARN_PERCENT: '90',
        INVOKER_DISK_CRITICAL_PERCENT: '80',
      } as NodeJS.ProcessEnv),
    ).toEqual({ warnPercent: 90, criticalPercent: 90 });
  });

  it('ignores invalid values', () => {
    expect(
      resolveDiskHeadroomThresholds({
        INVOKER_DISK_WARN_PERCENT: 'nope',
        INVOKER_DISK_CRITICAL_PERCENT: '-1',
      } as NodeJS.ProcessEnv),
    ).toEqual({ warnPercent: DEFAULT_DISK_WARN_PERCENT, criticalPercent: DEFAULT_DISK_CRITICAL_PERCENT });
  });
});

describe('resolveDiskCheckIntervalMs', () => {
  it('reads a positive integer from env', () => {
    expect(resolveDiskCheckIntervalMs({ INVOKER_DISK_CHECK_INTERVAL_MS: '1234' } as NodeJS.ProcessEnv)).toBe(1234);
  });

  it('falls back for invalid or non-positive values', () => {
    expect(resolveDiskCheckIntervalMs({ INVOKER_DISK_CHECK_INTERVAL_MS: '0' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_DISK_CHECK_INTERVAL_MS,
    );
    expect(resolveDiskCheckIntervalMs({ INVOKER_DISK_CHECK_INTERVAL_MS: '-5' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_DISK_CHECK_INTERVAL_MS,
    );
  });
});
