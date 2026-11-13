// Bundles both halves of the plugin.
//   lib/host.js    the host half (Node): what the Harness loads as the plugin
//   lib/client.js  the browser half: esbuild's CommonJS output wrapped in the Harness's module-loader format, with the Harness's shared
//                  modules left as `require(...)` calls the loader answers. `src/` is never shipped.
import { build } from 'esbuild'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'lib'), { recursive: true, force: true })
mkdirSync(join(root, 'lib'), { recursive: true })

await build({
  entryPoints: [join(root, 'src/host/index.ts')],
  outfile: join(root, 'lib/host.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})

const clientEntry = join(root, 'src/client/index.tsx')
if (existsSync(clientEntry)) {
  // modules the Harness's web shell provides to every plugin bundle (its shared module table); everything else is bundled in
  const shared = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']
  const result = await build({
    entryPoints: [clientEntry],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: shared,
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    legalComments: 'none',
    logLevel: 'info',
  })
  const code = result.outputFiles[0].text
  const id = 'dsh-tameru'
  const wrapped = `// Generated from src/client by scripts/build.mjs. Do not edit by hand.\nwindow.__ModuleLoader__.load({\n  id: ${JSON.stringify(id)},\n  factory: (require) => { const module = { exports: {} }\n${code}\nreturn Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })\n  },\n})\n`
  writeFileSync(join(root, 'lib/client.js'), wrapped)
  console.log(`  lib/client.js  ${(wrapped.length / 1024).toFixed(1)}kb`)
}
