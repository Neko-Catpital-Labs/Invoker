export const EXTERNAL_DEPENDENCIES = {
  drafterMcp: {
    packageName: 'drafter-mcp',
    version: '0.1.0',
    commandName: 'drafter-mcp',
  },
} as const;

export const DEFAULT_DRAFTER_MCP_PACKAGE_SPEC = `${EXTERNAL_DEPENDENCIES.drafterMcp.packageName}==${EXTERNAL_DEPENDENCIES.drafterMcp.version}`;
