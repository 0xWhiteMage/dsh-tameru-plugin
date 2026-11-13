// Bundles the host half of the plugin into lib/host.js. The Harness loads that file; `src/` is never shipped.
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'lib'), { recursive: true, force: true })
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
