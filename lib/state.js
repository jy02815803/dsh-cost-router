/**
 * 开关状态的读写与持久化。
 *
 * 插件配置在启动时由 loader 注入，界面开关则必须能即时生效，因此这里单独
 * 维护一份状态文件，并在内存中保留实时状态。状态文件优先于启动配置，避免
 * 用户在界面上做出的选择在下一次启动时被静态配置覆盖。
 *
 * 查找顺序（第一个可写的目录胜出）：
 *   1. 环境变量 `DSH_HOME`（桌面版通常指向 harness 目录）
 *   2. `~/.dsh`（命令行版默认位置）
 *
 * 文件不存在、JSON 损坏或目录不可写时全部安全降级。写盘失败时只在当前
 * 进程内生效，绝不把文件系统异常抛回宿主。
 *
 * @module dsh-cost-router/state
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 状态文件所在目录名（放在 harness home 下）。 */
const DIR_NAME = 'dsh-cost-router'

/** 状态文件名。 */
const FILE_NAME = 'state.json'

/** 内置默认阈值；与插件 Config 的默认值保持一致。 */
const DEFAULT_MIN_CHARS = 12

/**
 * 内存兜底状态。只在写盘失败时用于当前进程；写盘成功后清空，避免过期的
 * 临时值遮蔽磁盘上的真实状态。
 */
const memory = {
  enabled: undefined,
  minChars: undefined,
}

/**
 * 列出候选的状态目录宿主，并去除重复项。
 *
 * @returns {string[]} 候选 harness home 列表。
 */
function candidateHomes() {
  const homes = []
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') homes.push(fromEnv.trim())

  let userHome = process.env.USERPROFILE || process.env.HOME || ''
  if (userHome === '') {
    try {
      userHome = os.homedir()
    } catch {
      userHome = ''
    }
  }
  if (userHome !== '') homes.push(path.join(userHome, '.dsh'))

  return [...new Set(homes)]
}

/**
 * 解析状态文件路径，并确保目录存在。
 *
 * @returns {string|null} 可写路径；全部候选都不可写时返回 null（走内存兜底）。
 */
export function resolveStatePath() {
  for (const home of candidateHomes()) {
    let probe
    try {
      const dir = path.join(home, DIR_NAME)
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, FILE_NAME)

      // 目录存在不代表真能写：只读挂载、ACL 拒绝或磁盘已满都可能让真正的
      // 写盘在稍后才失败。这里用唯一探测文件实际走一遍创建、写入和删除；
      // 失败就换下一个候选目录，别让用户刚点的开关悄悄只留在内存里。
      probe = path.join(
        dir,
        `.state-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )
      let fd
      try {
        fd = openSync(probe, 'wx', 0o600)
        writeFileSync(fd, 'probe')
      } finally {
        if (fd !== undefined) closeSync(fd)
        unlinkSync(probe)
        probe = undefined
      }
      return file
    } catch {
      // 当前候选目录不可写，继续尝试下一个。
      if (probe !== undefined) {
        try {
          unlinkSync(probe)
        } catch {
          // 探测文件可能根本没创建成功，或已被清理。
        }
      }
    }
  }
  return null
}

/**
 * 把各种历史输入归一成合法的阈值。
 *
 * @param {unknown} value - 待校验的值。
 * @returns {number|undefined} 有限且 >= 1 的整数；非法值返回 undefined。
 */
function normalizeMinChars(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined
  return Math.floor(value)
}

/**
 * 从已解析的 JSON 中读取状态，兼容 0.4.0 的单字段格式。
 *
 * @param {unknown} parsed - JSON.parse 的结果。
 * @returns {{enabled?: boolean, minChars?: number}} 归一化后的状态。
 */
function normalizeState(parsed) {
  const state = {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return state

  const enabled = parsed.autoPlanEnabled
  if (typeof enabled === 'boolean') state.enabled = enabled

  const minChars = normalizeMinChars(parsed.autoPlanMinChars)
  if (minChars !== undefined) state.minChars = minChars

  return state
}

/**
 * 从磁盘读取状态。读取失败一律视为没有持久化状态。
 *
 * @returns {{enabled?: boolean, minChars?: number}} 磁盘状态。
 */
export function readPersistedState() {
  const file = resolveStatePath()
  if (file === null) return {}
  try {
    return normalizeState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // 首次运行时文件不存在；损坏文件也不应该阻断插件。
    return {}
  }
}

/**
 * 读取持久化的开关值（保留旧 API）。
 *
 * @returns {boolean|null} 文件里的布尔值；缺失或损坏时返回 null。
 */
export function readPersistedEnabled() {
  const state = readPersistedState()
  return typeof state.enabled === 'boolean' ? state.enabled : null
}

/**
 * 合并磁盘、内存兜底和本次补丁中的有效字段。
 *
 * @param {object} patch - 本次要写入的字段。
 * @returns {{enabled?: boolean, minChars?: number}} 合并后的完整状态。
 */
function mergePersistedState(patch) {
  const state = readPersistedState()
  if (typeof memory.enabled === 'boolean') state.enabled = memory.enabled
  if (typeof memory.minChars === 'number') state.minChars = memory.minChars

  if (patch && typeof patch === 'object') {
    if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled
    const minChars = normalizeMinChars(patch.minChars)
    if (minChars !== undefined) state.minChars = minChars
  }
  return state
}

/**
 * 写入状态。先更新内存（保证即时生效），再尽力原子落盘。
 *
 * @param {{enabled?: boolean, minChars?: number}} patch - 要更新的字段。
 * @returns {boolean} 是否成功落到磁盘；false 表示仅在本次进程内生效。
 */
export function writePersistedState(patch) {
  const state = mergePersistedState(patch)
  if (typeof state.enabled === 'boolean') memory.enabled = state.enabled
  if (typeof state.minChars === 'number') memory.minChars = state.minChars

  const file = resolveStatePath()
  if (file === null) return false

  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({
      autoPlanEnabled: state.enabled,
      autoPlanMinChars: state.minChars,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
    // 磁盘已是真实来源，清掉本次进程的临时兜底，避免后续读取被旧值遮蔽。
    memory.enabled = undefined
    memory.minChars = undefined
    return true
  } catch {
    try {
      unlinkSync(temp)
    } catch {
      // 临时文件可能尚未创建，或清理失败；保留内存状态即可。
    }
    return false
  }
}

/**
 * 写入开关值（保留旧 API），并保留磁盘/内存中已有的 minChars。
 *
 * @param {boolean} enabled - 新的开关值。
 * @returns {boolean} 是否成功落到磁盘。
 */
export function writePersistedEnabled(enabled) {
  return writePersistedState({ enabled })
}

/**
 * 决定插件的初始状态。
 *
 * 优先级固定为：状态文件 > 插件配置 > 内置默认。写盘失败后的内存兜底只
 * 影响当前进程，并在开关来源中标记为 `memory`。
 *
 * @param {object} config - 插件配置（loader 注入）。
 * @returns {{enabled: boolean, minChars: number, source: string}}
 */
export function resolveInitialEnabled(config) {
  const persisted = readPersistedState()

  let source
  let enabled
  if (typeof memory.enabled === 'boolean') {
    enabled = memory.enabled
    source = 'memory'
  } else if (typeof persisted.enabled === 'boolean') {
    enabled = persisted.enabled
    source = 'file'
  } else if (typeof config?.autoPlan?.enabled === 'boolean') {
    enabled = config.autoPlan.enabled
    source = 'config'
  } else {
    // 默认开启：目标用户装完即可获得花费保护，需要时可在界面关闭。
    enabled = true
    source = 'default'
  }

  let minChars
  if (typeof memory.minChars === 'number') {
    minChars = memory.minChars
  } else if (typeof persisted.minChars === 'number') {
    minChars = persisted.minChars
  } else {
    minChars = normalizeMinChars(config?.autoPlan?.minChars) ?? DEFAULT_MIN_CHARS
  }

  return { enabled, minChars, source }
}
