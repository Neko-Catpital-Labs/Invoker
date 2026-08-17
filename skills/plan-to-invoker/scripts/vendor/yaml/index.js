// `export * as default from ...` fails on Webpack v4
// https://github.com/eemeli/yaml/issues/228
import * as YAML from './lib/index.js'
export default YAML
export * from './lib/index.js'
