/**
 * Build the browser client bundle (lib/client.js) for the gauntlet toolview.
 *
 * Emits the DSH client module-system artifact: a closure-factory that calls
 * `window.__ModuleLoader__.load({ id, factory })` and resolves externals
 * through the injected `require` (the loader's module table).
 *
 * CSS Modules (.module.css) are compiled via lightningcss: hashed class
 * names, style injection, and a class-map export -- the twin of the DSH
 * preset's `dsh-css-modules-inline` behaviour.
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = 'gauntlet-loop-plugin'

const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Inline `.module.css` imports as hashed class-map + style injection. */
const cssModulesPlugin = {
  name: 'dsh-css-modules-inline',
  setup(build) {
    build.onResolve({ filter: /\.module\.css$/ }, (args) => {
      return { path: resolve(args.resolveDir, args.path), namespace: 'dsh-cssm' }
    })
    build.onLoad({ filter: /.*/, namespace: 'dsh-cssm' }, async (args) => {
      const source = readFileSync(args.path)
      const { code, exports: cssExports } = transform({
        filename: args.path,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      if (cssExports) {
        const entries = Object.entries(cssExports).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        for (const [local, exp] of entries) classMap[local] = exp.name
      }

      const fileId = args.path.split(/[/\\]/).pop()
      const tagId = PLUGIN_ID + '/' + fileId
      const css = code.toString()
      const moduleLines = [
        'const css = ' + JSON.stringify(css) + ';',
        'const tagId = ' + JSON.stringify(tagId) + ';',
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=\"' + tagId + '\"]') === null) {",
        "  const tag = document.createElement('style');",
        '  tag.dataset.plugin = ' + JSON.stringify(PLUGIN_ID) + ';',
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        'export default ' + JSON.stringify(classMap) + ';',
      ].join('\n')
      return { contents: moduleLines, loader: 'js' }
    })
  },
}

const banner = [
  'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')

const footer = [
  'return module.exports;',
  '} });',
].join('\n')

await build({
  entryPoints: [resolve(ROOT, 'src/client/index.ts')],
  outfile: resolve(ROOT, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  banner: { js: banner },
  footer: { js: footer },
  plugins: [cssModulesPlugin],
  logLevel: 'info',
})

console.log('client bundle written to lib/client.js')
