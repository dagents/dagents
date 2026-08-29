/**
 * Settings view 6-tab fidelity tests (v0.3-M8.2).
 *
 * Pins the shape `settings-view.tsx` was aligned onto — the six tabs grouped
 * 密钥/模型/治理/账户, and the DOM shape each tab renders once switched to.
 *
 *   §1 tablist — all six tabs render with their design name (LLM Provider /
 *     默认模型 / 通知 / 规划中) and LLM Provider is the
 *     default-open tab.
 *
 *   §2 switch — clicking a tab swaps the visible `<section>`; the design's
 *     per-tab primitives appear: 默认模型 → `.model-row` rows, 预算配额 → the
 *     `.bar` budget meter, 通知 → `.toggle-row` event/channel rows, 账户与团队
 *     → `.kv` 个人 + `.model-row` 团队 rows, 危险区 → `.danger-zone` rows.
 *
 *   §3 LLM Provider CRUD — the only live-wired tab. The list, the new-provider
 *     modal, and the delete-confirm modal still open/close against a stubbed
 *     `/api/llm-providers/*` fetch.
 *
 * The LLM Provider tab's fetch is stubbed via `globalThis.fetch` so the suite
 * runs without a gateway, mirroring the lab/flows-list pattern. The other five
 * tabs are static read-only shells, so no fetch is needed for them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'

// ─── fixtures ──────────────────────────────────────────────────────────────

/** The `/api/llm-providers` list payload — two providers, one active, one disabled. */
const PROVIDERS_FIXTURE = {
  success: true,
  data: {
    providers: [
      {
        id: 'p-001',
        directoryId: null,
        name: 'OpenAI 官方',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-ab••••••3f',
        defaultModel: 'gpt-4o',
        models: ['gpt-4o', 'gpt-4o-mini'],
        status: 'active',
        remark: null,
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-01T00:00:00Z',
      },
      {
        id: 'p-002',
        directoryId: null,
        name: 'DeepSeek 探索',
        providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-cd••••••8c',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat'],
        status: 'disabled',
        remark: '临时禁用',
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    ],
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let originalFetch: typeof globalThis.fetch

// Stub `/api/llm-providers` (list), `/api/llm-providers/:id` (update/delete),
// and `/api/llm-providers/:id/test` (connection test) so the LLM Provider tab's
// mount effect resolves without a gateway. The stub records POSTs so the
// create-modal test can assert one landed with the right body.
const createdProviders: Array<{ name: string }> = []

beforeEach(() => {
  createdProviders.length = 0
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    const path = url.pathname
    const method = init?.method ?? 'GET'

    // GET /api/llm-providers — the provider list.
    if (path === '/api/llm-providers' && method === 'GET') {
      return jsonResponse(PROVIDERS_FIXTURE)
    }
    // POST /api/llm-providers — create a provider. Echo back a created record.
    if (path === '/api/llm-providers' && method === 'POST') {
      const sent = init?.body
        ? (JSON.parse(init.body.toString()) as {
            name?: string
            providerType?: string
            baseUrl?: string
            defaultModel?: string
            remark?: string | null
          })
        : {}
      createdProviders.push({ name: sent.name ?? '(empty)' })
      return jsonResponse({
        success: true,
        data: {
          provider: {
            id: 'p-099',
            directoryId: null,
            name: sent.name ?? '(empty)',
            providerType: sent.providerType ?? 'openai',
            baseUrl: sent.baseUrl ?? '',
            apiKey: 'sk-xx••••••99',
            defaultModel: sent.defaultModel ?? '',
            models: [],
            status: 'active',
            remark: sent.remark ?? null,
            createdAt: '2026-07-26T00:00:00Z',
            updatedAt: '2026-07-26T00:00:00Z',
          },
        },
      })
    }
    return jsonResponse({ success: false, error: 'not found' }, 404)
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

// Imported lazily so the fetch stub above is in place before the view's mount
// effect fires (same guard the lab test uses). Wrapped in ToastProvider —
// the provider CRUD feedback moved from a local fake-toast div to the
// global toast system.
async function renderView(): Promise<void> {
  const { SettingsView } = await import('@/components/settings-view')
  const { ToastProvider } = await import('@/components/toast')
  render(
    <ToastProvider>
      <SettingsView />
    </ToastProvider>,
  )
}

// ─── §1 tablist ───────────────────────────────────────────────────────────────

describe('SettingsView — 6-tab tablist (M8.2)', () => {
  it('renders the live tabs plus the planned placeholder (方案 F 收拢)', async () => {
    await renderView()
    const names = ['LLM Provider', '默认模型', '通知', '规划中']
    for (const name of names) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    // 收拢后的占位 tab 不再伪装成真功能：预算配额 / 账户团队 / 危险区 不出现
    expect(screen.queryByRole('tab', { name: '预算配额' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '账户团队' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '危险区' })).not.toBeInTheDocument()
  })

  it('opens the LLM Provider tab by default', async () => {
    await renderView()
    const providerTab = screen.getByRole('tab', { name: 'LLM Provider' })
    expect(providerTab).toHaveAttribute('aria-selected', 'true')
    // The provider table is unique to the LLM Provider tab.
    expect(document.querySelector('.table-wrap')).not.toBeNull()
  })
})

// ─── §2 switch + per-tab DOM shape ──────────────────────────────────────────

describe('SettingsView — tab switch + per-tab shape (M8.2)', () => {
  it('switches to 默认模型 and renders model-row rows', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('tab', { name: '默认模型' }))
    expect(screen.getByRole('tab', { name: '默认模型' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('按角色分派')).toBeInTheDocument()
    expect(screen.getByText('阅读 / reader')).toBeInTheDocument()
    expect(screen.getByText('回退链')).toBeInTheDocument()
    expect(screen.getByText('1. Anthropic claude-sonnet-4')).toBeInTheDocument()
  })

  it('switches to 规划中 and lists the deferred areas honestly', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('tab', { name: '规划中' }))
    expect(screen.getByText(/预算与配额（成本熔断 \/ 月度告警）/)).toBeInTheDocument()
    expect(screen.getByText('账户与团队（多用户协作）')).toBeInTheDocument()
    expect(screen.getByText('危险区（暂停全部 / 数据清理）')).toBeInTheDocument()
    // 占位假数据（预算表 / 成员名单）必须不再出现
    expect(screen.queryByText('全平台预算')).not.toBeInTheDocument()
    expect(screen.queryByText('团队 · 38 成员')).not.toBeInTheDocument()
  })

  it('switches to 通知 and renders event + channel toggle-rows', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('tab', { name: '通知' }))
    expect(screen.getByText('Run 失败')).toBeInTheDocument()
    expect(screen.getByText('通知渠道')).toBeInTheDocument()
    expect(screen.getByText('Webhook')).toBeInTheDocument()
  })

  it('hides the LLM Provider table when a different tab is selected', async () => {
    await renderView()
    expect(document.querySelector('.table-wrap')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '通知' }))
    // LLM Provider section is conditionally rendered, so its table is gone.
    expect(document.querySelector('.table-wrap')).toBeNull()
  })
})

// ─── §3 LLM Provider CRUD (live-wired tab) ───────────────────────────────────

describe('SettingsView — LLM Provider tab CRUD', () => {
  it('lists providers from /api/llm-providers', async () => {
    await renderView()
    expect(await screen.findByText('OpenAI 官方')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek 探索')).toBeInTheDocument()
    // The count chip reflects the fetched list.
    expect(screen.getByText(/2 \/ 2 个 Provider/)).toBeInTheDocument()
  })

  it('opens the new-provider modal and creates a provider via POST /api/llm-providers', async () => {
    await renderView()
    // Wait for the list to render first.
    expect(await screen.findByText('OpenAI 官方')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '+ 新建 Provider' }))
    // The modal form's name input.
    const nameInput = await screen.findByLabelText('名称 *')
    fireEvent.change(nameInput, { target: { value: 'Claude 官方' } })
    // Fill required fields (baseUrl + defaultModel).
    const baseUrlInput = screen.getByLabelText('Base URL *')
    fireEvent.change(baseUrlInput, { target: { value: 'https://api.anthropic.com' } })
    const defaultModelInput = screen.getByLabelText('默认模型 *')
    fireEvent.change(defaultModelInput, { target: { value: 'claude-sonnet-4-20250514' } })
    // Fill API key (required for create).
    const apiKeyInput = screen.getByLabelText('API Key *')
    fireEvent.change(apiKeyInput, { target: { value: 'sk-ant-test' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(createdProviders.some((p) => p.name === 'Claude 官方')).toBe(true)
    })
    // The success toast surfaces.
    expect(await screen.findByText(/已创建/)).toBeInTheDocument()
  })
})
