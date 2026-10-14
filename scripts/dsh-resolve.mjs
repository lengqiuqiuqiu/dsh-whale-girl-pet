/**
 * ============================================================================
 * 让 `node --test` 复用 DSH 安装里的宿主包（dev-only，不发布）
 * ============================================================================
 *
 * 【为什么需要】
 *   本插件**不打包**宿主提供的依赖，运行时全部由 DSH 的模块解析拦截层提供
 *   （packages/boot/app-boot/src/profile-resolution/resolver.ts：位于 linked
 *   root 的插件，其裸导入会路由到安装侧提供的包）。当前用到两类：
 *     - `@deepseek-ai/*`：`lib/index.js` 顶层静态导入 `@deepseek-ai/schemastery`、
 *       `@deepseek-ai/dsh-home-paths` 等；
 *     - 其它宿主 peer：`lib/cost-projection.js` 导入 `zod`。
 *
 *   而 `node --test` 走原生 Node 解析，没有那层拦截，插件目录往上也没有
 *   node_modules，于是直接 `ERR_MODULE_NOT_FOUND`（host-routes / cost-projection
 *   两个文件整体跑不起来）。本文件用一个同步解析钩子（`module.registerHooks`）
 *   补上这一步：**只有当原生解析失败时**，才把该裸说明符当成"从 DSH 安装里导入"
 *   再解析一次（覆盖 `@deepseek-ai/*` 与 zod 这类宿主 peer）。因此它既不会改变
 *   任何已成功的解析，也不会让插件多装一份本地副本；真正写错的包名照样报错
 *   （所有 anchor 里都没有）。
 *
 * 【为什么放在 scripts/ 而不是 test/】
 *   `node --test` 无参数时会扫描 test/ 下的文件；放在 test/ 里会被当成一个测试
 *   文件重复加载（并重复注册钩子）。scripts/ 与 sync-install.ps1、
 *   verify-dsh-0.1.7.mjs 一样属于开发脚手架，也都不进 npm 发布物。
 *
 * 【用法】
 *   npm test                     # package.json 的 scripts.test 已接好
 *   # 等价于：node --import ./scripts/dsh-resolve.mjs --test
 *
 * 【anchor 从哪来】按顺序取第一个存在的（重试链，不是唯一来源）：
 *   1. 环境变量 DSH_RESOLVE_ANCHOR —— DSH 安装内某个 package.json 的路径或 file:// URL；
 *   2. $DSH_HOME/profiles/<每个 profile>/package.json（默认 ~/.dsh）—— @deepseek-ai/* 在这里；
 *   3. $DSH_HOME/profiles/package.json —— 根级副本的依赖（zod 等）；
 *   4. 源码检出：$DSH_CHECKOUT/apps/cli/package.json（默认尝试 D:/deepseek-harness）。
 *   一个都找不到时原样抛出原生解析错误，不会静默失效。
 *
 * 【维护点】
 *   这是**测试脚手架**，不是运行时依赖。插件本身仍然不需要声明这些包为 dependencies；
 *   若哪天改为显式声明（自带 node_modules），本文件即可删除。
 * ============================================================================
 */

import { existsSync, readdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 把"路径或 file:// URL"统一成 file:// URL；不存在则丢弃。 */
function toAnchor(value) {
  if (!value) return undefined
  try {
    const url = value.startsWith('file:') ? new URL(value) : pathToFileURL(value)
    return existsSync(url) ? url.href : undefined
  } catch {
    return undefined
  }
}

/** 每个 profile 目录下的 package.json（@deepseek-ai/* 的解析链起点）。 */
function profileAnchors() {
  const profilesDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')
  const found = []
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(join(profilesDir, entry.name, 'package.json'))
    }
  } catch {
    // profiles 目录不存在（例如没装过 DSH）—— 交给后面的候选
  }
  return found
}

/** DSH 主目录下的 profiles 根（根级副本的 node_modules 在这层）。 */
function profilesRootAnchor() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'package.json')
}

const ANCHORS = [
  toAnchor(process.env.DSH_RESOLVE_ANCHOR),
  ...profileAnchors().map(toAnchor),
  toAnchor(profilesRootAnchor()),
  toAnchor(process.env.DSH_CHECKOUT && join(process.env.DSH_CHECKOUT, 'apps', 'cli', 'package.json')),
  toAnchor('D:/deepseek-harness/apps/cli/package.json'),
].filter((href) => href !== undefined)

/** 裸说明符：走 node_modules 链解析，而不是相对/绝对路径、内建模块或 URL。 */
function isBare(specifier) {
  return !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !specifier.startsWith('file:')
    && !specifier.startsWith('node:')
    && !specifier.startsWith('data:')
}

registerHooks({
  /**
   * 先走原生解析；只有裸说明符失败时，才依次用各 anchor 重试。
   * @param specifier - 被导入的说明符。
   * @param context - 解析上下文（含 parentURL）。
   * @param nextResolve - 链上的下一个解析器。
   * @returns 解析结果。
   */
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!isBare(specifier) || ANCHORS.length === 0) throw error
      for (const parentURL of ANCHORS) {
        try {
          return nextResolve(specifier, { ...context, parentURL })
        } catch {
          // 这个 anchor 里没有，换下一个
        }
      }
      throw error
    }
  },
})
