/**
 * 0.6.0 质量与兼容回归。
 *
 * 全部离线：不调用模型、不访问网络、不读写用户状态。
 * 运行：node test/quality-compat.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, isHeterogeneous, requiresStrong } from '../lib/router.js'
import { validateSubtasks } from '../lib/orchestrator.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 中英文规则分离：英文样本不再靠中文关键词碰运气。
{
  const enKinds = classify('Read this chart image, extract the table, compare the rows, and write a report')
  assert.deepEqual(enKinds, ['vision', 'writing'])
  assert.equal(isHeterogeneous('Read this chart image, extract the table, compare the rows, and write a report', enKinds).yes, true)
  assert.equal(requiresStrong('Urgent: polish this notice into a board-ready final version; it must be exact'), true)
  assert.equal(requiresStrong('Write a short meeting summary with three bullet points'), false)
}

// 分解结果 schema：重复 id、空指令、未知 kind、悬空依赖与依赖环都必须在调用模型前拦下。
{
  const two = [
    { id: 't1', kind: 'vision', instruction: '看图', depends_on: [] },
    { id: 't2', kind: 'writing', instruction: '写稿', depends_on: ['t1'] },
  ]
  validateSubtasks(two)

  assert.throws(() => validateSubtasks([
    { id: 't1', kind: 'vision', instruction: '看图', depends_on: [] },
    { id: 't1', kind: 'writing', instruction: '写稿', depends_on: [] },
  ]), /重复子任务 id/)
  assert.throws(() => validateSubtasks([
    { id: 't1', kind: 'vision', instruction: '  ', depends_on: [] },
  ]), /指令为空/)
  assert.throws(() => validateSubtasks([
    { id: 't1', kind: 'telepathy', instruction: '读心', depends_on: [] },
  ]), /未知子任务类型/)
  assert.throws(() => validateSubtasks([
    { id: 't1', kind: 'writing', instruction: '写稿', depends_on: ['t9'] },
  ]), /不存在的依赖/)
  assert.throws(() => validateSubtasks([
    { id: 't1', kind: 'vision', instruction: '看图', depends_on: ['t2'] },
    { id: 't2', kind: 'writing', instruction: '写稿', depends_on: ['t1'] },
  ]), /依赖环/)
}

// 兼容矩阵与评测集要可复现：文件存在、字段完整、DSH 实测版本有明确记录。
{
  const matrix = JSON.parse(readFileSync(path.join(root, 'docs', 'compatibility.json'), 'utf8'))
  assert.equal(matrix.schemaVersion, 1)
  assert.ok(Array.isArray(matrix.entries) && matrix.entries.length > 0)
  const verified = matrix.entries.filter((entry) => entry.status === 'verified')
  assert.ok(verified.length >= 1, '至少要有一条实机验收过的 DSH 版本')
  assert.ok(verified.every((entry) => entry.dshVersion && entry.os && entry.pluginVersion && entry.verifiedAt))

  const evaluation = JSON.parse(readFileSync(path.join(root, 'config', 'auto-plan-eval.json'), 'utf8'))
  assert.equal(evaluation.schemaVersion, 1)
  assert.equal(evaluation.cases.length, 16)
  assert.equal(evaluation.cases.filter((c) => c.language === 'zh').length, 8)
  assert.equal(evaluation.cases.filter((c) => c.language === 'en').length, 8)
}

console.log('0.6.0 质量与兼容回归测试通过')