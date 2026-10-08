/**
 * RunPermissionSummary 组件测试（R4 运行前权限确认面，2026-10-08 测试补齐）。
 *
 * 钉的是「确认面说的和执行层放的是同一集合」的 UI 呈现半边（数据源同源
 * 已由 packages/workflow flow-permissions.test.ts 的同源钉子覆盖）：分组
 * chip、静态 URL 比对黄警、模板变量提示、缺席计数黄警、invalid 红条、
 * 子流程标注、空投影零渲染。默认 i18n 上下文 zh-CN（t(key)=key），与
 * chat-composer.test.tsx 同款无 Provider 渲染。
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { FlowPermissionProjection } from '@dagents/workflow'
import { RunPermissionSummary } from './run-permission-summary'

function projection(overrides: Partial<FlowPermissionProjection> = {}): FlowPermissionProjection {
  return {
    commandNodes: [],
    domainNodes: [],
    undeclaredHttp: [],
    invalid: [],
    hasSubflow: false,
    ...overrides,
  }
}

describe('RunPermissionSummary — 权限确认区渲染', () => {
  it('空投影 → 零渲染（无权限面不出空标题，最小惊讶）', () => {
    const { container } = render(<RunPermissionSummary projection={projection()} />)
    expect(container.innerHTML).toBe('')
  })

  it('命令/域名分组 + chip + 运行时裁决提示（AC-R4-4 UI 面）', () => {
    render(
      <RunPermissionSummary
        projection={projection({
          commandNodes: [{ nodeId: 'c1', label: '拉取状态', commands: ['git', 'rg'] }],
          domainNodes: [
            {
              nodeId: 'h1',
              label: '查仓库',
              domains: ['api.github.com'],
              url: 'https://api.github.com/x',
            },
          ],
        })}
      />,
    )
    expect(screen.getByText('权限确认')).toBeTruthy()
    expect(screen.getByText('拉取状态')).toBeTruthy()
    expect(screen.getByText('查仓库')).toBeTruthy()
    expect(screen.getByText('git')).toBeTruthy()
    expect(screen.getByText('rg')).toBeTruthy()
    expect(screen.getByText('api.github.com')).toBeTruthy()
    // 诚实提示：cmd 是运行期字符串，白名单内即放行
    expect(screen.getByText('$exec 实际调用在白名单内即放行——运行时裁决')).toBeTruthy()
  })

  it('静态 URL hostname ∉ 清单 → ⚠ 行内提示（title 带完整判决文案）', () => {
    render(
      <RunPermissionSummary
        projection={projection({
          domainNodes: [
            {
              nodeId: 'h1',
              label: 'H',
              domains: ['api.github.com'],
              url: 'https://api.gitlab.com/x',
            },
          ],
        })}
      />,
    )
    const warn = screen.getByText('⚠ api.gitlab.com')
    expect(warn.getAttribute('title')).toBe('URL 域名不在清单中——运行时将拒绝')
  })

  it('URL 含模板变量 → 「运行时守卫裁决」提示（静态比对不适用）', () => {
    render(
      <RunPermissionSummary
        projection={projection({
          domainNodes: [
            { nodeId: 'h1', label: 'H', domains: ['api.github.com'], url: 'https://{{host}}/x' },
          ],
        })}
      />,
    )
    expect(screen.getByText('（URL 含变量——运行时守卫裁决）')).toBeTruthy()
    // 变量 URL 不做静态比对 → 不出 ⚠
    expect(screen.queryByText(/⚠/)).toBeNull()
  })

  it('declared-empty 域名清单 → ∅ 标记（显式空集如实展示）', () => {
    render(
      <RunPermissionSummary
        projection={projection({
          domainNodes: [{ nodeId: 'h1', label: 'H', domains: [] }],
        })}
      />,
    )
    expect(screen.getByText('∅')).toBeTruthy()
  })

  it('undeclaredHttp 黄警：计数插值 + 节点 id 列表（warn 过渡期文案）', () => {
    render(<RunPermissionSummary projection={projection({ undeclaredHttp: ['h2', 'h9'] })} />)
    expect(
      screen.getByText('2 个 HTTP 节点未声明域名清单——当前过渡期放行，网关 enforce 后将拒绝运行'),
    ).toBeTruthy()
    expect(screen.getByText('（h2、h9）')).toBeTruthy()
  })

  it('invalid 声明 → 红条列出节点 id 与原因（与保存干跑同源错误文本）', () => {
    render(
      <RunPermissionSummary
        projection={projection({
          invalid: [
            { node: 'h1', message: '节点 "h1" 的 allowedDomains 声明非法：应为字符串数组' },
          ],
        })}
      />,
    )
    expect(
      screen.getByText('节点 h1 的声明非法：节点 "h1" 的 allowedDomains 声明非法：应为字符串数组'),
    ).toBeTruthy()
  })

  it('hasSubflow → 「子流程内的声明以子流程画布为准」标注（§3.7 诚实边界）', () => {
    render(
      <RunPermissionSummary
        projection={projection({
          commandNodes: [{ nodeId: 'c1', label: 'C', commands: ['git'] }],
          hasSubflow: true,
        })}
      />,
    )
    expect(screen.getByText('子流程内的声明以子流程画布为准')).toBeTruthy()
  })
})
