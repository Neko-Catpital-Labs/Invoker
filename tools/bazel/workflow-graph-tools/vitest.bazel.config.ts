export default {
  root: '../../../packages/workflow-graph',
  test: {
    globals: true,
    include: ['src/**/__tests__/**/*.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    testTimeout: 20_000,
    pool: 'forks',
  },
};
