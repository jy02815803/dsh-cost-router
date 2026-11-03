/**
 * 开关状态的读写与持久化。
 *
 * 为什么需要这个模块：插件配置（`Config`）是**启动时**由 loader 注入的，
 * 想改就得重启 Harness。而一个界面开关如果点了要重启才生效，对用户就是
 * 「点了没反应」，比没有开关更糟。
 *
 * 所以开关状态单独存一份 JSON，钩子每次任务都实时读它，做到点一下立刻生效。
 *
 * 查找顺序（第一个能写的胜出）：
 *   1. 环境变量 `DSH_HOME`（桌面版会设置，指向 harness 目录）
 *   2. `~/.dsh`（命令行版默认位置）
 * 都写不了时降级成「只用内存」：开关在当前会话内有效，重启回到默认值，
 * 但绝不抛错、绝不影响宿主启动。
 *
 * @module dsh-cost-router/state
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 状态文件所在目录名（放在 harness home 下）。 */
const DIR_NAME = 'dsh-cost-router'

/** 状态文件名。 */
const FILE_NAME = 'state.json'

/** 内存兜底：状态文件不可写时用它，保证开关至少在本次会话内有效。 */
const memory = { value: undefined }

/**
 * 列出候选的状态目录宿主。
 *
 * @returns {string[]} 候选 harness home 列表。
 */
function candidateHomes() {
  const homes = []
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') homes.push(fromEnv.trim())

  const userHome =
    process.env.USERPROFILE || process.env.HOME || (() => {
      try {
        return os.homedir()
      } catch {
        return ''
      }
    })()
  if (typeof userHome === 'string' && userHome.trim() !== '') {
    homes.push(path.join(userHome, '.dsh'))
  }
  return homes
}

/**
 * 解析状态文件路径，并确保目录存在。
 *
 * @returns {string|null} 可写路径；全都不可写时返回 null（走内存兜底）。
 */
export function resolveStatePath() {
  for (const home of candidateHomes()) {
    try {
      const dir = path.join(home, DIR_NAME)
      mkdirSync(dir, { recursive: true })
      return path.join(dir, FILE_NAME)
    } catch {
      // 这个位置不可写，试下一个。
    }
  }
  return null
}

/**
 * 读取持久化的开关值。
 *
 * @returns {boolean|null} 文件里的值；文件不存在或损坏时返回 null。
 */
export function readPersistedEnabled() {
  const file = resolveStatePath()
  if (file === null) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed?.autoPlanEnabled === 'boolean') return parsed.autoPlanEnabled
    return null
  } catch {
    // 文件不存在（首次运行）或内容损坏：都当作「没有持久化值」处理，
    // 不因为一个坏文件就让插件出问题。
    return null
  }
}

/**
 * 写入开关值。
 *
 * @param {boolean} enabled - 新的开关值。
 * @returns {boolean} 是否成功落到磁盘（false 表示只写进了内存）。
 */
export function writePersistedEnabled(enabled) {
  memory.value = enabled
  const file = resolveStatePath()
  if (file === null) return false
  try {
    writeFileSync(file, `${JSON.stringify({ autoPlanEnabled: enabled }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 决定插件的初始开关值。
 *
 * 优先级：状态文件 > 插件配置 > 内置默认。
 * 状态文件优先是刻意的：用户在界面上点过的选择，不该被配置文件覆盖。
 *
 * @param {object} config - 插件配置（loader 注入）。
 * @returns {{enabled: boolean, source: string}}
 */
export function resolveInitialEnabled(config) {
  if (typeof memory.value === 'boolean') {
    return { enabled: memory.value, source: 'memory' }
  }
  const persisted = readPersistedEnabled()
  if (typeof persisted === 'boolean') {
    return { enabled: persisted, source: 'file' }
  }
  const fromConfig = config?.autoPlan?.enabled
  if (typeof fromConfig === 'boolean') {
    return { enabled: fromConfig, source: 'config' }
  }
  // 内置默认：开启。目标用户是「不懂模型、只想省着用」的人，
  // 装完就能工作才符合预期；懂行的人知道怎么关。
  return { enabled: true, source: 'default' }
}