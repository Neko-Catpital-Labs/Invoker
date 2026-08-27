import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { IpcChannels } from '@invoker/contracts';
import { registerGuiMutationHandler } from '../ipc/ipc-registration.js';

const CHANNEL = 'invoker:planning-chat-rebind-repo';
const REPORTED_URL = 'https://github.com/Neko-Catpital-Labs/Invoker';
const MISSING_PLANNING_CHAT_CHANNELS = [
  'invoker:planning-chat-discard-draft',
  'invoker:planning-chat-rebind-repo',
  'invoker:planning-chat-set-terminal-mode',
] as const;

const guiMutationHandlersSource = readFileSync(
  path.resolve(__dirname, '..', 'ipc', 'gui-mutation-handlers.ts'),
  'utf8',
);
const mainSource = readFileSync(path.resolve(__dirname, '..', 'main.ts'), 'utf8');

function casesIn(block: string): string[] {
  return [...block.matchAll(/case '([^']+)':/g)].map((match) => match[1]);
}

function getTranslatorSource(): string {
  const start = guiMutationHandlersSource.indexOf('function translateGuiMutationToHeadless');
  const end = guiMutationHandlersSource.indexOf('  async function performSharedApproveTask', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return guiMutationHandlersSource.slice(start, end);
}

function getWrapperSource(): string {
  const start = mainSource.indexOf('translateGuiMutationToHeadless: (payload) => {');
  const end = mainSource.indexOf('guiMutationHandlers,', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

function routedPlanningChatChannels(): Set<string> {
  const innerCases = new Set(casesIn(getTranslatorSource()));
  const wrapper = getWrapperSource();
  for (const channel of wrapper.matchAll(/payload\.channel === '([^']+)'/g)) {
    innerCases.add(channel[1]);
  }
  return innerCases;
}

function planningChatInvokeChannels(): string[] {
  return Object.keys(IpcChannels).filter((channel) => channel.startsWith('invoker:planning-chat-'));
}

function productionTranslate(payload: { channel: string; args: unknown[] }) {
  if (routedPlanningChatChannels().has(payload.channel)) {
    return { channel: 'headless.gui-mutation' as const, request: payload };
  }
  return null;
}

function fakeIpcMain() {
  const handleHandlers = new Map<string, (_event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, handler: (_event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handleHandlers.set(channel, handler);
    },
  } as unknown as IpcMain;
  return { ipcMain, handleHandlers };
}

async function invokeFollower(channel: string, args: unknown[]) {
  const { ipcMain, handleHandlers } = fakeIpcMain();
  const request = vi.fn(async (translatedChannel: string, payload: unknown) => ({
    delegated: true,
    translatedChannel,
    payload,
  }));
  registerGuiMutationHandler(
    {
      ipcMain,
      getOwnerMode: () => false,
      getMessageBus: () => ({ request }),
      translateGuiMutationToHeadless: productionTranslate,
    },
    channel,
    async () => ({ ranLocalHandler: true }),
  );
  return handleHandlers.get(channel)?.({}, ...args);
}

describe('planning-chat follower owner delegation', () => {
  it('reproduces the reported repo-field error for a follower GUI', async () => {
    await expect(
      invokeFollower(CHANNEL, [{ sessionId: 'session-1', repoUrl: REPORTED_URL }]),
    ).rejects.toThrow(`No owner delegation route is available for ${CHANNEL}`);
  });

  it.each([...MISSING_PLANNING_CHAT_CHANNELS])(
    'throws the missing-delegation error for follower %s',
    async (channel) => {
      await expect(invokeFollower(channel, [{ sessionId: 'session-1' }])).rejects.toThrow(
        `No owner delegation route is available for ${channel}`,
      );
    },
  );

  it('CONTROL: follower planning-chat-send still forwards to the owner', async () => {
    await expect(
      invokeFollower('invoker:planning-chat-send', [{ sessionId: 'session-1', text: 'hi' }]),
    ).resolves.toMatchObject({ delegated: true, translatedChannel: 'headless.gui-mutation' });
  });

  it('documents the planning-chat invoke channels with no follower translation case', () => {
    const routed = routedPlanningChatChannels();
    const missing = planningChatInvokeChannels().filter((channel) => !routed.has(channel));
    expect(missing.sort()).toEqual([...MISSING_PLANNING_CHAT_CHANNELS].sort());
  });
});
