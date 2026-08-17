import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const expected = 'e19c03450c62238aeb70ad735f612d4bfc61964e1473b1be4bdca1d9230bd086'
const source = fileURLToPath(new URL('../public/brand/AppIcon-1024.png', import.meta.url))
const digest = createHash('sha256').update(await readFile(source)).digest('hex')

if (digest !== expected) {
  throw new Error(`Brand source hash mismatch: expected ${expected}, received ${digest}`)
}

process.stdout.write(`Brand source verified: ${digest}\n`)
