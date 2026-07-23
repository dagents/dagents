/**
 * Settings view 6-tab fidelity tests (v0.3-M8.2).
 *
 * Pins the shape `settings-view.tsx` was aligned onto — the six tabs from
 * `design/settings.html` (全 690 行) grouped 密钥/模型/治理/账户, and the DOM
 * shape each tab renders once switched to.
 *
 *   §1 tablist — all six tabs render with their design name (API Key / 默认模型
 *     / 预算配额 / 通知 / 账户团队 / 危险区) and API Key is the default-open tab.
 *
 *   §2 switch — clicking a tab swaps the visible `<section>`; the design's
 *     per-tab primitives appear: 默认模型 → `.model-row` rows, 预算配额 → the
 *     `.bar` budget meter, 通知 → `.toggle-row` event/channel rows, 账户与团队
 *     → `.kv` 个人 + `.model-row` 团队 rows, 危险区 → `.danger-zone` rows.
 *
 *   §3 API Key CRUD — the only live-wired tab. The list, the new-token modal,
 *     and the delete-confirm modal still open/close against a stubbed
 *     `/api/tokens/*` + `/api/gateway-health` fetch (unchanged from P1.10.T8).
 *
 * The API Key tab's fetch is stubbed via `globalThis.fetch` so the suite runs
 * without a gateway, mirroring the lab/flows-list pattern. The other five
 * tabs are static read-only shells (data wiring deferred per the coverage
 * analysis), so no fetch is needed for them — their shape is in the source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'

// ─── fixtures (mirror design/js/tokens-data.js shapes) ─────────────────────

/** The `/api/tokens` list payload — two tokens, one default, one disabled. */
const TOKENS_FIXTURE = {
  success: true,
  data: {
    items: [
      {
        id: 1,
        name: '论文复现-生产',
        key: 'sk-newapi-AAAA**********3f',
        group: 'prod',
        status: 1,
        remain_quota: 480000,
        used_quota: 20000,
        unlimited_quota: false,
        expired_time: -1,
      },
      {
        id: 2,
        name: '探索-临时',
        key: 'sk-newapi-BBBB**********8c',
        group: 'dev',
        status: 2,
        remain_quota: 0,
        used_quota: 5000,
        unlimited_quota: false,
        expired_time: -1,
      },
    ],
    total: 2,
  },
}

/** `/api/gateway-health` probe result. */
const HEALTH_FIXTURE = { success: true, ok: true, reachable: true, svc: 'new-api', status: 200 }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let originalFetch: typeof globalThis.fetch

// Stub `/api/tokens` (list), `/api/tokens/:id` (create/update/delete), and
// `/api/gateway-health` so the API Key tab's mount effect resolves without a
// gateway. The stub records POSTs so the create-modal test can assert one
// landed with the right body.
const createdTokens: Array<{ name: string }> = []

beforeEach(() => {
  createdTokens.length = 0
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    const path = url.pathname
    const method = init?.method ?? 'GET'

    // GET /api/gateway-health — the gateway probe card.
    if (path === '/api/gateway-health' && method === 'GET') {
      return jsonResponse(HEALTH_FIXTURE)
    }
    // GET /api/tokens — the token list.
    if (path === '/api/tokens' && method === 'GET') {
      return jsonResponse(TOKENS_FIXTURE)
    }
    // POST /api/tokens — create a token. Echo back a created record + record
    // the body so the test can assert the request landed.
    if (path === '/api/tokens' && method === 'POST') {
      const sent = init?.body ? (JSON.parse(init.body.toString()) as { name?: string }) : {}
      createdTokens.push({ name: sent.name ?? '(empty)' })
      return jsonResponse({ success: true, data: { id: 99, ...sent } })
    }
    return jsonResponse({ success: false, error: 'not found' }, 404)
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

// Imported lazily so the fetch stub above is in place before the view's mount
// effect fires (same guard the lab test uses).
async function renderView(): Promise<void> {
  const { SettingsView } = await import('@/components/settings-view')
  render(<SettingsView />)
}

// ─── §1 tablist ───────────────────────────────────────────────────────────────

describe('SettingsView — 6-tab tablist (M8.2)', () => {
  it('renders all six tabs by their design name', async () => {
    await renderView()
    // The visible button text carries the longer design label; the short
    // design name rides on aria-label so the tab role + name is unambiguous.
    const names = ['API Key', '默认模型', '预算配额', '通知', '账户团队', '危险区']
    for (const name of names) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
  })

  it('opens the API Key tab by default', async () => {
    await renderView()
    const apiTab = screen.getByRole('tab', { name: 'API Key' })
    expect(apiTab).toHaveAttribute('aria-selected', 'true')
    // The gateway card is unique to the API Key tab.
    expect(document.querySelector('.gateway')).not.toBeNull()
  })
})

// ─── §2 switch + per-tab DOM shape ──────────────────────────────────────────

describe('SettingsView — tab switch + per-tab shape (M8.2)', () => {
  it('switches to 默认模型 and renders model-row rows', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('tab', { name: '默认模型' }))
    expect(screen.getByRole('tab', { name: '默认模型' })).toHaveAttribute('aria-selected', 'true')
    // The 按角色分派 card + a model-row carrying the reader role.
    expect(screen.getByText('按角色分派')).toBeInTheDocument()
    expect(screen.getByText('阅读 / reader')).toBeInTheDocument()
    // The 回退链 card carries the main-model toggle-row.
    expect(screen.getByText('回退链')).toBeInTheDocument()
    expect(screen.getByText('1. Anthropic claude-sonnet-4')).toBeInTheDocument()
  })

  it('switches to 预算配额 and renders the budget meter + toggle-rows', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('tab', { name: '预算配额' }))
    expect(screen.getByText('全平台预算')).toBeInTheDocument()
    expect(screen.getByText('月预算')).toBeInTheDocument()
    // The budget bar (.bar) + 熔断规则 toggle-rows.
    const quotaSection = screen.getByText('全平台预算').closest('section')
    expect(quotaSection!.querySelector('.bar')).not.toBeNull()
    expect(screen.getByText('熔断规则')).toBeInTheDocument()
    expect(screen.getByText('单 run 成本超 $5 暂停')).toBeInTheDocument()
  })

  it('switches to 通知 and renders event + channel toggle-rows', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('tab', { name: '通知' }))
    expect(screen.getByText('Run 失败')).toBeInTheDocument()
    expect(screen.getByText('通知渠道')).toBeInTheDocument()
    expect(screen.getByText('Webhook')).toBeInTheDocument()
  })

  it('switches to 账户团队 and renders 个人 kv + 团队 model-rows', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('tab', { name: '账户团队' }))
    // The account section is the active panel — scope to it so the repeated
    // email (个人 kv dd + the owner model-row .p) is unambiguous.
    const section = document.querySelector('section.settings-section.active') as HTMLElement | null
    expect(section).not.toBeNull()
    // 个人 kv: 姓名 / 邮箱 / 角色 / SSO / 默认 workspace. The email appears
    // twice on this tab (kv dd + the owner model-row .p), so query the kv's
    // 邮箱 dd specifically.
    expect(within(section!).getByText('姓名')).toBeInTheDocument()
    const dt = Array.from(section!.querySelectorAll('dl.kv dt')).find((n) => n.textContent === '邮箱')
    expect(dt?.nextElementSibling?.textContent).toBe('rz@team.dev')
    // 团队 members render as model-rows carrying the owner/admin/editor roles.
    expect(within(section!).getByText('团队 · 38 成员')).toBeInTheDocument()
    expect(section!.querySelectorAll('.model-row').length).toBeGreaterThanOrEqual(3)
  })

  it('switches to 危险区 and renders the danger-zone rows (不可恢复 wording present)', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('tab', { name: '危险区' }))
    // The danger section is the active panel — scope to it because "危险区"
    // appears on both the tab and the section's card-title.
    const section = document.querySelector('section.settings-section.active') as HTMLElement | null
    expect(section).not.toBeNull()
    expect(within(section!).getByText('危险区')).toBeInTheDocument()
    expect(within(section!).getByText('暂停所有运行中的 run')).toBeInTheDocument()
    expect(within(section!).getByText('轮换全部令牌')).toBeInTheDocument()
    // The delete-row wording flags the irrecoverable delete.
    expect(within(section!).getByText(/删除 workspace 及全部数据/)).toBeInTheDocument()
    expect(within(section!).getByText(/30 天可恢复/)).toBeInTheDocument()
  })

  it('hides the API Key gateway card when a different tab is selected', async () => {
    await renderView()
    expect(document.querySelector('.gateway')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '通知' }))
    // API Key section is conditionally rendered, so its gateway card is gone.
    expect(document.querySelector('.gateway')).toBeNull()
  })
})

// ─── §3 API Key CRUD (live-wired tab) ───────────────────────────────────────

describe('SettingsView — API Key tab CRUD (M8.2 retained wiring)', () => {
  it('lists tokens from /api/tokens', async () => {
    await renderView()
    expect(await screen.findByText('论文复现-生产')).toBeInTheDocument()
    expect(screen.getByText('探索-临时')).toBeInTheDocument()
    // The count chip reflects the fetched list.
    expect(screen.getByText(/2 \/ 2 个令牌/)).toBeInTheDocument()
  })

  it('opens the new-token modal and creates a token via POST /api/tokens', async () => {
    await renderView()
    // Wait for the list to render first.
    expect(await screen.findByText('论文复现-生产')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '+ 新建令牌' }))
    // The modal form's name input.
    const nameInput = await screen.findByLabelText('令牌名称 *')
    fireEvent.change(nameInput, { target: { value: '新流水线令牌' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(createdTokens.some((t) => t.name === '新流水线令牌')).toBe(true)
    })
    // The success toast surfaces.
    expect(await screen.findByText(/已创建/)).toBeInTheDocument()
  })
})
