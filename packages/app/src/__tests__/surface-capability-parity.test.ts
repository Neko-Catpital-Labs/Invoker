import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IpcChannels } from '@invoker/contracts';
import { SPAWN_REPAIR_WORKFLOW_CHANNEL } from '@invoker/execution-engine';
import { OwnerCapabilityRegistry } from '../owner-capability-registry.js';
import { buildWebInvokerDispatch } from '../web/web-invoker-dispatch.js';

const appSourceRoot = fileURLToPath(new URL('..', import.meta.url));

function productionTypeScriptSources(directory = appSourceRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionTypeScriptSources(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

function desktopCapabilityInventory(): { owner: string[]; invoke: string[] } {
  const registrationSources = productionTypeScriptSources().join('\n');
  const owner = [...registrationSources.matchAll(
    /(?:registrars\.)?register(?:Gui|WorkflowScopedGui|TaskScopedGui)MutationHandler\(\s*'([^']+)'/g,
  )].map((match) => match[1]);
  const invoke = [...registrationSources.matchAll(
    /ipcMain\.handle\(\s*'([^']+)'/g,
  )].map((match) => match[1]);
  const contractChannel = (channel: string): boolean => Object.hasOwn(IpcChannels, channel);

  return {
    owner: [...new Set([...owner, SPAWN_REPAIR_WORKFLOW_CHANNEL])].filter(contractChannel).sort(),
    invoke: [...new Set([...owner, ...invoke, SPAWN_REPAIR_WORKFLOW_CHANNEL])].filter(contractChannel).sort(),
  };
}

describe('surface capability parity', () => {
  it('delegates every registered desktop owner capability through a full webserver profile', async () => {
    const ownerCapabilities = new OwnerCapabilityRegistry();
    const desktopCapabilities = desktopCapabilityInventory().owner;
    const invoked: string[] = [];
    for (const channel of desktopCapabilities) {
      ownerCapabilities.register(channel, async () => {
        invoked.push(channel);
        return channel;
      });
    }
    const dispatch = buildWebInvokerDispatch({
      ownerCapabilities,
      loadConfig: () => ({}),
    } as never);

    expect(desktopCapabilities.length).toBeGreaterThan(40);
    for (const channel of desktopCapabilities) {
      await expect(dispatch(channel, [])).resolves.toBe(channel);
    }
    expect(invoked).toEqual(desktopCapabilities);
  });

  it('keeps every production Electron invoke capability accessible in a full webserver profile', async () => {
    const inventory = desktopCapabilityInventory();
    const ownerCapabilities = new OwnerCapabilityRegistry();
    for (const channel of inventory.owner) {
      ownerCapabilities.register(channel, async () => channel);
    }
    const universal = new Proxy(() => universal, {
      apply: () => universal,
      get: (_target, property) => property === 'then' ? undefined : universal,
    });
    const dispatch = buildWebInvokerDispatch(new Proxy({
      ownerCapabilities,
      loadConfig: () => ({}),
      taskTerminals: universal,
      planningTerminals: universal,
      getBundledSkillsStatus: universal,
    }, {
      get: (target, property) => property in target
        ? target[property as keyof typeof target]
        : universal,
    }) as never);

    expect(inventory.invoke.length).toBeGreaterThan(80);
    const inaccessible: Array<{ channel: string; code: string }> = [];
    for (const channel of inventory.invoke) {
      try {
        await dispatch(channel, []);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'unknown_channel' || code === 'capability_provider_missing') {
          inaccessible.push({ channel, code });
        }
      }
    }

    expect(inaccessible).toEqual([]);
  });
});
