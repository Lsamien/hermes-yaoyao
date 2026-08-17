import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function pngSize(data: Buffer): { width: number; height: number } {
  expect(data.subarray(1, 4).toString()).toBe('PNG')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

describe('brand assets', () => {
  it('keeps the mobile AppIcon as the exact brand source', async () => {
    const data = await readFile(resolve('public/brand/AppIcon-1024.png'))
    expect(createHash('sha256').update(data).digest('hex')).toBe(
      'e19c03450c62238aeb70ad735f612d4bfc61964e1473b1be4bdca1d9230bd086',
    )
    expect(pngSize(data)).toEqual({ width: 1024, height: 1024 })
  })

  it.each([
    ['favicon-32.png', 32],
    ['logo-64.png', 64],
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
  ])('generates %s without changing aspect ratio', async (name, size) => {
    const data = await readFile(resolve('public/icons', name))
    expect(pngSize(data)).toEqual({ width: size, height: size })
  })
})
