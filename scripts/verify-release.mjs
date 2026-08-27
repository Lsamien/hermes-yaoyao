#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'))
const release = await json('release.json')
const pkg = await json('package.json')
const lock = await json('package-lock.json')
const pluginManifest = await json('hermes-plugins/yaoyao/dashboard/manifest.json')
const pluginYaml = await readFile(resolve(root, 'hermes-plugins/yaoyao/plugin.yaml'), 'utf8')
const pluginYamlVersion = pluginYaml.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1]

const failures = []
if (release.schemaVersion !== 1) failures.push('release.json schemaVersion 必须为 1')
if (release.releaseVersion !== release.webVersion) failures.push('releaseVersion 与 webVersion 必须一致')
if (release.gitTag !== `v${release.releaseVersion}`) failures.push('gitTag 必须为 v<releaseVersion>')
if (pkg.version !== release.webVersion) failures.push('package.json 版本与 release.json 不一致')
if (lock.version !== release.webVersion || lock.packages?.['']?.version !== release.webVersion) {
  failures.push('package-lock.json 版本与 release.json 不一致')
}
if (pluginManifest.version !== release.pluginVersion) failures.push('插件 manifest.json 版本与 release.json 不一致')
if (pluginYamlVersion !== release.pluginVersion) failures.push('plugin.yaml 版本与 release.json 不一致')

if (failures.length) {
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`发布版本校验通过：Web ${release.webVersion} + 插件 ${release.pluginVersion}\n`)
}
