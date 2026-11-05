/**
 * 一键跑全部离线检查。
 *
 * npm test 会先做语法检查，再逐个执行 test/*.test.mjs。
 * 不调用 DSH、不访问网络、不读写用户真实 state.json。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (file, args) => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${file}: ${args.join(' ')} 退出码 ${result.status ?? '未知'}`)
  }
}

const syntax = [
  ...readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`),
  ...readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.mjs')).map((name) => `test/${name}`),
  ...readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.mjs')).map((name) => `scripts/${name}`),
]
for (const file of syntax) run(file, ['--check', file])

const tests = readdirSync(path.join(root, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
for (const name of tests) run(name, [`test/${name}`])

console.log(`全部通过：${syntax.length} 个语法检查，${tests.length} 个离线测试`)