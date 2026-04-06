/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'warn',
      comment:
        'This dependency is part of a circular relationship. You might want to revise ' +
        'your solution (i.e. use dependency inversion, make sure the modules have a single responsibility) ',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-orphans',
      comment:
        "This is an orphan module - it's likely not used (anymore?). Either use it or remove it.",
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$', // dot files
          '\\.d\\.ts$', // TypeScript declaration files
          '(^|/)tsconfig\\.json$', // TypeScript config
          '(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts|json)$', // tool configs
          '(^|/)answer\\.js$', // project-specific answer.js file
        ],
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      comment:
        'A module depends on a node core module that has been deprecated. Find an alternative - these are ' +
        "bound to exist - node doesn't deprecate lightly.",
      severity: 'warn',
      from: {},
      to: {
        dependencyTypes: ['core'],
        path: [
          '^(v8/tools/codemap)$',
          '^(v8/tools/consarray)$',
          '^(v8/tools/csvparser)$',
          '^(v8/tools/logreader)$',
          '^(v8/tools/profile_view)$',
          '^(v8/tools/profile)$',
          '^(v8/tools/SourceMap)$',
          '^(v8/tools/splaytree)$',
          '^(v8/tools/tickprocessor-driver)$',
          '^(v8/tools/tickprocessor)$',
          '^(node-inspect/lib/_inspect)$',
          '^(node-inspect/lib/internal/inspect_client)$',
          '^(node-inspect/lib/internal/inspect_repl)$',
          '^(async_hooks)$',
          '^(punycode)$',
          '^(domain)$',
          '^(constants)$',
          '^(sys)$',
          '^(_linklist)$',
          '^(_stream_wrap)$',
        ],
      },
    },
    {
      name: 'not-to-deprecated',
      comment:
        'This module uses a (version of an) npm module that has been deprecated. Either upgrade to a later ' +
        'version of that module, or find an alternative. Deprecated modules are a security risk.',
      severity: 'warn',
      from: {},
      to: {
        dependencyTypes: ['deprecated'],
      },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      comment:
        "This module depends on an npm package that isn't in the 'dependencies' section of your package.json. " +
        "That's problematic as the package either (1) won't be available on live (2) will be available, but " +
        'is unnecessarily large or (3) will sorta work, but might break on random occasions.',
      from: {},
      to: {
        dependencyTypes: ['npm-no-pkg', 'npm-unknown'],
      },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        "This module depends on a module that cannot be found ('resolved to disk'). If it's an npm " +
        'module: add it to your package.json. In all other cases: adjust your path. ' +
        'See https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md#detecting-unresolvable-imports for more info.',
      severity: 'error',
      from: {},
      to: {
        couldNotResolve: true,
        // Ignore unresolvable workspace packages - these are handled by TypeScript
        pathNot: '^@invoker/',
      },
    },
    {
      name: 'no-duplicate-dep-types',
      comment:
        "Likely this module depends on an external ('npm') package that occurs more than once " +
        'in your package.json i.e. both in dependencies and in devDependencies. This will cause ' +
        'maintenance problems later on.',
      severity: 'warn',
      from: {},
      to: {
        moreThanOneDependencyType: true,
        // as it's pretty common to have a type import be a type only import
        // _and_ (e.g.) a devDependency - don't consider type-only dependency
        // types for this rule
        dependencyTypesNot: ['type-only'],
      },
    },

    /* Package boundary rules */
    {
      name: 'layer-0-no-deps',
      comment:
        'Layer 0 packages (contracts, workflow-graph, transport, runtime-domain, runtime-service, shell, ui) should not depend on other workspace packages.',
      severity: 'error',
      from: {
        path: '^packages/(contracts|workflow-graph|transport|runtime-domain|runtime-service|shell|ui)/',
      },
      to: {
        path: '^packages/',
        pathNot: '^packages/(contracts|workflow-graph|transport|runtime-domain|runtime-service|shell|ui)/',
      },
    },
    {
      name: 'layer-1-deps',
      comment:
        'Layer 1 packages (workflow-core, protocol, runtime-adapters, graph) can only depend on Layer 0.',
      severity: 'error',
      from: {
        path: '^packages/(workflow-core|protocol|runtime-adapters|graph)/',
      },
      to: {
        path: '^packages/',
        pathNot: [
          '^packages/(workflow-core|protocol|runtime-adapters|graph)/',
          '^packages/(contracts|workflow-graph|transport|runtime-domain|runtime-service|shell|ui)/',
        ],
      },
    },
    {
      name: 'layer-2-deps',
      comment:
        'Layer 2 packages (data-store, persistence, core) can only depend on Layer 0 and Layer 1.',
      severity: 'error',
      from: {
        path: '^packages/(data-store|persistence|core)/',
      },
      to: {
        path: '^packages/',
        pathNot: [
          '^packages/(data-store|persistence|core)/',
          '^packages/(workflow-core|protocol|runtime-adapters|graph)/',
          '^packages/(contracts|workflow-graph|transport|runtime-domain|runtime-service|shell|ui)/',
        ],
      },
    },
    {
      name: 'layer-3-deps',
      comment:
        'Layer 3 packages (execution-engine, surfaces) can only depend on Layers 0, 1, and 2.',
      severity: 'error',
      from: {
        path: '^packages/(execution-engine|surfaces)/',
      },
      to: {
        path: '^packages/',
        pathNot: [
          '^packages/(execution-engine|surfaces)/',
          '^packages/(data-store|persistence|core)/',
          '^packages/(workflow-core|protocol|runtime-adapters|graph)/',
          '^packages/(contracts|workflow-graph|transport|runtime-domain|runtime-service|shell|ui)/',
        ],
      },
    },
    {
      name: 'layer-4-deps',
      comment:
        'Layer 4 packages (executors, test-kit, app) can only depend on Layers 0, 1, 2, and 3.',
      severity: 'error',
      from: {
        path: '^packages/(executors|test-kit|app)/',
      },
      to: {
        path: '^packages/',
        pathNot: [
          '^packages/(executors|test-kit|app)/',
          '^packages/(execution-engine|surfaces)/',
          '^packages/(data-store|persistence|core)/',
          '^packages/(workflow-core|protocol|runtime-adapters|graph)/',
          '^packages/(contracts|workflow-graph|transport|runtime-domain|runtime-service|shell|ui)/',
        ],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    },
    exclude: {
      path: [
        '^vitest\\.shared\\.ts$',
        '^packages/core/',
        '^packages/persistence/',
        '^packages/executors/',
        '^packages/graph/',
        '^packages/protocol/',
        'node_modules',
        '__tests__',
        '\\.test\\.(ts|tsx|js|jsx)$',
        '\\.spec\\.(ts|tsx|js|jsx)$',
        'dist',
        'build',
      ],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)',
      },
      archi: {
        collapsePattern: '^packages/([^/]+)',
      },
      text: {
        highlightFocused: true,
      },
    },
  },
};
