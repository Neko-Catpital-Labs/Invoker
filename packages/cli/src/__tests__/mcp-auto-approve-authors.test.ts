import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../mcp-server.js';
import { readInvokerConfigFile, writeInvokerConfigFile } from '@invoker/contracts';

const tempRoots: string[] = [];

function makeConfigPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-auto-approve-authors-'));
  tempRoots.push(root);
  return join(root, 'config.json');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('invoker_auto_approve_authors MCP tool', () => {
  it('adds the current GitHub user to config.json and leaves the toggle off', async () => {
    const configPath = makeConfigPath();
    writeInvokerConfigFile(configPath, { autoApproveAIFixes: false });
    const server = createMcpServer({
      configPath,
      lookupGithubLogin: async () => 'EdbertChan',
      createMessageBus: async () => {
        throw new Error('live owner should not be required to write autoApproveAuthors');
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'invoker-cli-test-client', version: '0.0.0' });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const result = await client.callTool({
        name: 'invoker_auto_approve_authors',
        arguments: { action: 'add_current_github_user' },
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(parsed).toMatchObject({
        ok: true,
        autoApproveAuthors: ['EdbertChan'],
        allowlistOk: true,
        autoApproveToggleUnchanged: true,
      });
      const saved = readInvokerConfigFile(configPath);
      expect(saved.autoApproveAuthors).toEqual(['EdbertChan']);
      expect(saved.autoApproveAIFixes).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
