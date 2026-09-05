/**
 * Settings page 6-tab UI (P1.10.T8 / M5a.4 → M8.2 形状对齐 design).
 *
 * Ported from design/settings.html: a sticky left sub-nav (6 tabs grouped
 * 密钥/模型/治理/账户) switches the visible `<section>`. The LLM Provider
 * tab is the only one with live wiring — it CRUDs providers via the
 * `/api/llm-providers/*` proxy (browser → gateway → llm_providers table).
 *
 * M8.2 对齐 design/settings.html 全 690 行：其余 5 tab（默认模型 / 预算配额
 * / 通知 / 账户与团队 / 危险区）按 design 的 DOM 形状逐一回填 — model-row /
 * toggle-row / kv / danger-zone 原语 + design 的占位数据。数据接线延后但形状
 * 在（coverage analysis §2.2/2.3 明确推迟通知与账户/团队，默认模型→workflow
 * 配置、熔断→scheduler、成本→资源面板聚合 API）。
 *
 * Tab buttons use role="tab" so the fidelity test can `getByRole('tab')`;
 * `aria-current` is the design's active affordance.
 */

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { PageShell } from '@/components/page-shell'
import { Icon } from '@/components/icon'
import { useToast } from '@/components/toast'
import { NotificationSettings } from '@/components/notification-settings'
import { AuditLog } from '@/components/audit-log'
import { UsageTab } from '@/components/usage-tab'
import { AGENT_KINDS } from '@/lib/agents-catalog'
import {
  createLlmProvider,
  deleteLlmProvider,
  listLlmProviders,
  testLlmProvider,
  updateLlmProvider,
} from '@/lib/llm-providers-client'
import {
  llmProviderStatusText,
  type LlmProvider,
  type LlmProviderFormInput,
  type LlmProviderStatus,
} from '@/lib/llm-providers'
import { useI18n } from '@/i18n'
import '@/styles/settings.css'

/** The settings tabs, grouped as the design's sub-nav renders them. */
type TabId = 'keys' | 'runtimes' | 'models' | 'usage' | 'notify' | 'audit' | 'planned'

type TabGroupKey = '密钥' | '模型' | '治理' | '账户'

interface TabDef {
  id: TabId
  /** Visible label on the tab button AND section heading (long form). */
  label: string
  /**
   * Short form for the tab button's aria-label. The fidelity test keys tabs
   * by their short design name (API Key / 默认模型 / 预算配额 / 通知 /
   * 账户团队 / 危险区); the visible button text carries the longer design
   * label, so aria-label carries the short form. Defaults to `label` when
   * the short and long forms are identical.
   */
  a11y?: string
  /** Sub-nav group label. */
  group: TabGroupKey
  /**
   * Placeholder tab whose content is not wired to a backend (design shape
   * only). ST01: dimmed to 40% opacity + an 11px 「未接入」 suffix so it
   * doesn't carry the same visual weight as live tabs.
   */
  stub?: boolean
}

/**
 * Single source of truth for the six settings tabs. Both the sub-nav
 * grouping (TAB_GROUPS) and the per-tab accessible name (TAB_A11Y) derive
 * from this array, so the long visible label and the short aria-label
 * can never drift apart — adding or renaming a tab only touches this list.
 */
const TABS: readonly TabDef[] = [
  { id: 'keys', label: 'LLM Provider 管理', a11y: 'LLM Provider', group: '密钥' },
  { id: 'runtimes', label: 'CLI 运行时', a11y: 'CLI 运行时', group: '密钥' },
  { id: 'models', label: '默认模型', group: '模型', stub: true },
  { id: 'usage', label: '用量与成本', a11y: '用量与成本', group: '治理' },
  { id: 'notify', label: '通知', group: '治理' },
  { id: 'audit', label: '审计日志', a11y: '审计日志', group: '治理' },
  { id: 'planned', label: '规划中', group: '账户', stub: true },
] as const

interface TabGroup {
  label: TabGroupKey
  tabs: { id: TabId; label: string; stub?: boolean }[]
}

const TAB_GROUPS: TabGroup[] = (
  ['密钥', '模型', '治理', '账户'] as const
).map((g) => ({
  label: g,
  tabs: TABS.filter((t) => t.group === g).map((t) => ({ id: t.id, label: t.label, stub: t.stub })),
}))

const TAB_A11Y: Record<TabId, string> = TABS.reduce(
  (acc, t) => {
    acc[t.id] = t.a11y ?? t.label
    return acc
  },
  {} as Record<TabId, string>,
)

/** Canonical long-form label per tab — used by section aria-label and heading. */
const TAB_LABEL: Record<TabId, string> = TABS.reduce(
  (acc, t) => {
    acc[t.id] = t.label
    return acc
  },
  {} as Record<TabId, string>,
)

const PROVIDER_TYPES = ['openai', 'anthropic', 'google', 'azure', 'deepseek', 'moonshot', 'qwen', 'ollama', 'custom'] as const

const EMPTY_FORM: LlmProviderFormInput = {
  name: '',
  providerType: 'openai',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
  models: [],
  status: 'active',
  remark: '',
}

export function SettingsView(): React.ReactElement {
  const { t } = useI18n()
  const [tab, setTab] = useState<TabId>('keys')

  return (
    <PageShell>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('设置分组')} role="tablist">
          {TAB_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="settings-grp">{t(g.label)}</div>
              {g.tabs.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  role="tab"
                  className={`settings-tab${it.stub ? ' settings-tab-stub' : ''}`}
                  aria-selected={tab === it.id}
                  aria-label={t(TAB_A11Y[it.id])}
                  onClick={() => setTab(it.id)}
                >
                  {t(it.label)}
                  {/* aria-hidden：后缀不进 accessible name（tab 名保持纯标签） */}
                  {it.stub ? (
                    <span className="settings-tab-stub-note" aria-hidden="true">{t('未接入')}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div>
          {tab === 'keys' && <LlmProvidersTab />}
          {tab === 'runtimes' && <RuntimesTab />}
          {tab === 'models' && <DefaultModelsTab />}
          {tab === 'usage' && <UsageTab label={TAB_LABEL.usage} />}
          {tab === 'notify' && <NotifyTab />}
          {tab === 'audit' && <AuditLog />}
          {tab === 'planned' && <PlannedTab />}
        </div>
      </div>
    </PageShell>
  )
}

// ─── LLM Provider tab ───────────────────────────────────────────────

function LlmProvidersTab(): React.ReactElement {
  const { t } = useI18n()
  const toast = useToast()
  const [providers, setProviders] = useState<LlmProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<LlmProviderStatus | null>(null)

  const [editing, setEditing] = useState<{ id: string | null; form: LlmProviderFormInput } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<LlmProvider | null>(null)
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  /** ST02：测试连接 inline 结果（✓/✗ + 语义色文字），按 provider 记住最近一次 */
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listLlmProviders()
      setProviders(list.providers)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return providers.filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false
      if (q && !(
        p.name.toLowerCase().includes(q) ||
        p.providerType.toLowerCase().includes(q) ||
        p.baseUrl.toLowerCase().includes(q) ||
        p.defaultModel.toLowerCase().includes(q)
      )) return false
      return true
    })
  }, [providers, query, statusFilter])

  function openCreate(): void {
    setEditing({ id: null, form: { ...EMPTY_FORM } })
  }

  function openEdit(p: LlmProvider): void {
    setEditing({
      id: p.id,
      form: {
        name: p.name,
        providerType: p.providerType,
        baseUrl: p.baseUrl,
        apiKey: '',
        defaultModel: p.defaultModel,
        models: p.models ?? [],
        status: p.status,
        remark: p.remark ?? '',
      },
    })
  }

  async function save(): Promise<void> {
    if (!editing) return
    const name = editing.form.name.trim()
    const baseUrl = editing.form.baseUrl.trim()
    const defaultModel = editing.form.defaultModel.trim()
    if (!name || !baseUrl || !defaultModel) {
      // Button-disabled bypass (e.g. Enter in a form field) must not be silent.
      toast.error(t('请完整填写名称、Base URL 与默认模型'))
      return
    }
    setBusy(true)
    try {
      const form: LlmProviderFormInput = {
        ...editing.form,
        name,
        baseUrl,
        defaultModel,
      }
      if (editing.id === null) {
        await createLlmProvider(form)
        toast.success(t('Provider「{name}」已创建', { name }))
      } else {
        const updatePayload: Partial<LlmProviderFormInput> = { ...form }
        if (!form.apiKey) {
          delete updatePayload.apiKey
        }
        await updateLlmProvider(editing.id, updatePayload)
        toast.success(t('Provider「{name}」已更新', { name }))
      }
      setEditing(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggleStatus(p: LlmProvider): Promise<void> {
    const nextStatus: LlmProviderStatus = p.status === 'active' ? 'disabled' : 'active'
    setBusy(true)
    try {
      await updateLlmProvider(p.id, { status: nextStatus })
      await load()
      toast.success(t(nextStatus === 'disabled' ? 'Provider「{name}」已禁用' : 'Provider「{name}」已启用', { name: p.name }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(p: LlmProvider): Promise<void> {
    setTestingId(p.id)
    try {
      const result = await testLlmProvider(p.id)
      // inline 结果而非 toast —— 结果要能留在行内被反复查看（PX-ST02）
      setTestResults((prev) => ({
        ...prev,
        [p.id]: { ok: true, msg: t('连接成功 · {n} 个模型', { n: result.models.length }) },
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTestResults((prev) => ({ ...prev, [p.id]: { ok: false, msg } }))
    } finally {
      setTestingId(null)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    setBusy(true)
    try {
      await deleteLlmProvider(pendingDelete.id)
      toast.success(t('Provider「{name}」已删除', { name: pendingDelete.name }))
      setPendingDelete(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section active" aria-label={t(TAB_LABEL.keys)}>
      <div className="row-between mb-4">
        <div>
          <div className="card-title" style={{ fontSize: 'var(--text-lg)' }}>{t(TAB_LABEL.keys)}</div>
          <div className="muted mt-2" style={{ fontSize: 'var(--text-sm)' }}>
            {t('管理 LLM 服务商配置，支持多 Provider 接入与统一鉴权')}
          </div>
        </div>
      </div>

      <div className="tokens-toolbar">
        <div className="list-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder={t('搜索 Provider 名称、类型、Base URL、默认模型…')}
            aria-label={t('搜索 Provider')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {(['active', 'disabled'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className="filter-chip"
            aria-pressed={statusFilter === s}
            onClick={() => setStatusFilter((prev) => (prev === s ? null : s))}
          >
            {t(llmProviderStatusText(s))}
          </button>
        ))}
        <span className="tk-count">
          {t('{n} / {total} 个 Provider', { n: filtered.length, total: providers.length })}
        </span>
        <div className="grow" />
        {/* 墨紫契约：主按钮 = 墨色（btn-primary），紫不上面板按钮底 */}
        <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>
          <Icon name="plus" style={{ width: 14, height: 14 }} />
          {t('+ 新建 Provider')}
        </button>
      </div>

      <div className="table-wrap">
        <table className="data" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '20%' }}>{t('名称')}</th>
              <th style={{ width: '14%' }}>{t('类型')}</th>
              <th style={{ width: '22%' }}>Base URL</th>
              <th style={{ width: '16%' }}>{t('默认模型')}</th>
              <th style={{ width: '12%' }}>{t('状态')}</th>
              <th style={{ textAlign: 'right' }}>{t('操作')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="tc muted" style={{ padding: 'var(--space-12)' }}>
                  {t('加载中…')}
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={6} className="tc" style={{ padding: 'var(--space-12)', color: 'var(--danger)' }}>
                  {t('加载失败：{error}', { error })}
                  <div className="mt-2">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                      {t('重试')}
                    </button>
                  </div>
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="tc muted" style={{ padding: 'var(--space-12)' }}>
                  {query || statusFilter ? t('没有匹配的 Provider。') : t('还没有 Provider。不配置也能跑：Flow 节点默认走本机 CLI（较慢、消耗订阅额度）。配置 HTTP Provider 可加速并统一计费。点击「+ 新建 Provider」开始配置。')}
                </td>
              </tr>
            ) : (
              filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="tk-name">
                      <div className="nm">{p.name}</div>
                      <div className="meta">
                        <span className="tk-key mono">{p.apiKey}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="tk-group">{p.providerType}</span>
                  </td>
                  <td>
                    <span className="mono" style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>{p.baseUrl}</span>
                  </td>
                  <td>
                    <span className="mono" style={{ fontSize: 'var(--text-xs)' }}>{p.defaultModel}</span>
                  </td>
                  <td>
                    <span className={`status ${p.status === 'active' ? 'running' : 'idle'}`}>
                      <span className="dot" />
                      {t(llmProviderStatusText(p.status))}
                    </span>
                  </td>
                  <td>
                    <div className="tk-actions">
                      <button
                        type="button"
                        className="mini-btn"
                        aria-label={t(p.status === 'active' ? '禁用' : '启用')}
                        title={t(p.status === 'active' ? '禁用' : '启用')}
                        disabled={busy}
                        onClick={() => void toggleStatus(p)}
                      >
                        <Icon name={p.status === 'active' ? 'pause' : 'play'} style={{ width: 12, height: 12 }} />
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        aria-label={t('测试连接')}
                        title={t('测试连接')}
                        disabled={busy || testingId === p.id}
                        onClick={() => void testConnection(p)}
                      >
                        <Icon
                          name={testingId === p.id ? 'loader' : 'refresh'}
                          className={testingId === p.id ? 'icon-spin' : undefined}
                          style={{ width: 12, height: 12 }}
                        />
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        aria-label={t('编辑')}
                        title={t('编辑')}
                        disabled={busy}
                        onClick={() => openEdit(p)}
                      >
                        <Icon name="pencil" style={{ width: 12, height: 12 }} />
                      </button>
                      <button
                        type="button"
                        className="mini-btn danger"
                        aria-label={t('删除')}
                        title={t('删除')}
                        disabled={busy}
                        onClick={() => setPendingDelete(p)}
                      >
                        <Icon name="close" style={{ width: 12, height: 12 }} />
                      </button>
                    </div>
                    {/* ST02：测试连接 inline 结果 —— 测试中 spinner，终态 ✓/✗ + 语义色文字 */}
                    {testingId === p.id ? (
                      <div className="tk-test-result">
                        <Icon name="loader" className="icon-spin" style={{ width: 12, height: 12 }} />
                        <span className="msg">{t('测试中…')}</span>
                      </div>
                    ) : testResults[p.id] ? (
                      <div
                        className={`tk-test-result ${testResults[p.id].ok ? 'ok' : 'err'}`}
                        title={testResults[p.id].msg}
                      >
                        <Icon
                          name={testResults[p.id].ok ? 'check' : 'close'}
                          style={{ width: 12, height: 12 }}
                        />
                        <span className="msg">{testResults[p.id].msg}</span>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="muted mt-3" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
        {t('Provider 配置由网关统一管理，API Key 以掩码形式显示，原文不返回前端。所有 LLM 调用经网关统一鉴权与路由。')}
      </p>

      {editing ? (
        <LlmProviderModal
          form={editing.form}
          isEdit={editing.id !== null}
          busy={busy}
          onChange={(form) => setEditing({ id: editing.id, form })}
          onCancel={() => setEditing(null)}
          onSave={() => void save()}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteModal
          provider={pendingDelete}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </section>
  )
}

// ─── CLI 运行时 tab ──────────────────────────────────────────────────
//
// A reference table of all 18 CLI agent types the platform can dispatch to,
// with their default binary, wire protocol, and a one-line description.
// The gateway's GET /api/v1/cli-runtimes scans PATH in real-time and reports
// which binaries are installed, so the status column reflects reality.

/** Protocol → short Chinese label for the runtimes table. */
const PROTOCOL_LABEL: Record<string, string> = {
  'stream-json': 'stream-json',
  ACP: 'ACP',
  'plain-text': 'plain-text',
  none: '—',
}

/** Display name + protocol for each runtime row, derived from AGENT_KINDS.
 *  CLI kinds only (prompt/remote have no binary and are omitted). */
const RUNTIME_ROWS = AGENT_KINDS.filter((m) => m.binary.length > 0)

interface RuntimeDetection {
  kind: string
  binary: string
  available: boolean
  path: string | null
}

function RuntimesTab(): React.ReactElement {
  const { t } = useI18n()
  const [detections, setDetections] = useState<Record<string, RuntimeDetection>>({})
  const [loading, setLoading] = useState(true)
  // Detection failure must not render as「未安装」.
  const [detectError, setDetectError] = useState<string | null>(null)

  const loadDetections = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const resp = await fetch('/api/cli-runtimes')
      const json = await resp.json()
      if (json.success) {
        const map: Record<string, RuntimeDetection> = {}
        for (const r of json.data.runtimes as RuntimeDetection[]) {
          map[r.kind] = r
        }
        setDetections(map)
        setDetectError(null)
      } else {
        setDetectError(`HTTP ${resp.status}`)
      }
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDetections()
  }, [loadDetections])

  const installedCount = Object.values(detections).filter((d) => d.available).length

  return (
    <section className="settings-section active" aria-label={t(TAB_LABEL.runtimes)}>
      <div className="row-between mb-4">
        <div>
          <div className="card-title" style={{ fontSize: 'var(--text-lg)' }}>{t(TAB_LABEL.runtimes)}</div>
          <div className="muted mt-2" style={{ fontSize: 'var(--text-sm)' }}>
            {t('平台支持的全部 CLI agent 运行时。Gateway 自动检测本机 ')}
            <code className="mono">PATH</code>
            {t('，已安装的可直接在对话中使用。')}
          </div>
        </div>
        <div className="row-between" style={{ gap: 'var(--space-3)' }}>
          {!loading && (
            <span className={`status ${installedCount > 0 ? 'running' : 'idle'}`}>
              <span className="dot" />
              {t('{n} 个已安装', { n: installedCount })}
            </span>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={loading}
            onClick={() => void loadDetections()}
          >
            <Icon name={loading ? 'loader' : 'refresh'} style={{ width: 12, height: 12 }} />
            {t('重新检测')}
          </button>
        </div>
      </div>

      {detectError ? (
        <div className="agents-error" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <span>{t('CLI 检测失败：{error} — 表内「未安装」状态不可信', { error: detectError })}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadDetections()}>
            {t('重试')}
          </button>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="data" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '18%' }}>{t('名称')}</th>
              <th style={{ width: '16%' }}>{t('二进制')}</th>
              <th style={{ width: '12%' }}>{t('协议')}</th>
              <th style={{ width: '10%' }}>{t('分组')}</th>
              <th style={{ width: '12%' }}>{t('状态')}</th>
              <th>{t('说明')}</th>
            </tr>
          </thead>
          <tbody>
            {RUNTIME_ROWS.map((r) => {
              const det = detections[r.kind]
              const available = det?.available ?? false
              return (
                <tr key={r.kind}>
                  <td>
                    <div className="tk-name">
                      <div className="nm">{t(r.label)}</div>
                      <div className="meta">
                        <span className="mono" style={{ fontSize: 'var(--text-2xs)' }}>{r.kind}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="mono" style={{ fontSize: 'var(--text-xs)' }}>{r.binary}</span>
                    {det?.path && (
                      <div className="meta mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted)', marginTop: 2 }}>
                        {det.path}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="tk-group">{PROTOCOL_LABEL[r.protocol] ?? r.protocol}</span>
                  </td>
                  <td>
                    <span className="chip chip-outline" style={{ fontSize: 'var(--text-2xs)' }}>{t(r.group)}</span>
                  </td>
                  <td>
                    {loading ? (
                      <span className="status idle">
                        <span className="dot" />
                        {t('检测中…')}
                      </span>
                    ) : available ? (
                      <span className="status running">
                        <span className="dot" />
                        {t('已安装')}
                      </span>
                    ) : (
                      <span className="status idle">
                        <span className="dot" />
                        {t('未安装')}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>{t(r.hint)}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="muted mt-3" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
        {t('状态由 Gateway 实时检测（')}
        <code className="mono">which &lt;binary&gt;</code>
        {t('）。已安装的 CLI 可直接在对话中选择对应 Agent 使用——无需手动启动 daemon。未安装的请参考各 CLI 官方文档安装。')}
      </p>
    </section>
  )
}

/** Eye glyph for the API-key show/hide toggle (icon.tsx has no eye; kept
 *  local to avoid growing the shared icon set for one consumer). */
const EYE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'

function LlmProviderModal(props: {
  form: LlmProviderFormInput
  isEdit: boolean
  busy: boolean
  onChange: (form: LlmProviderFormInput) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const { form, isEdit, busy, onChange, onCancel, onSave } = props
  const [touched, setTouched] = useState(false)
  /** ST02：密钥掩码显隐 —— 按钮绝对定位在输入框右缘内 8px，错误信息出现不位移 */
  const [showKey, setShowKey] = useState(false)
  const nameInvalid = form.name.trim().length === 0
  const baseUrlInvalid = form.baseUrl.trim().length === 0
  const defaultModelInvalid = form.defaultModel.trim().length === 0
  const apiKeyRequired = !isEdit && !form.apiKey

  function set<K extends keyof LlmProviderFormInput>(key: K, value: LlmProviderFormInput[K]): void {
    onChange({ ...form, [key]: value })
  }

  return createPortal(
    <div className="modal-backdrop open" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="lp-title">
        <div className="modal-head">
          <div className="title" id="lp-title">{isEdit ? t('编辑 Provider') : t('新建 Provider')}</div>
          <button type="button" className="icon-btn" aria-label={t('关闭')} onClick={onCancel}>
            <Icon name="close" style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <div className="modal-body">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setTouched(true)
              if (!nameInvalid && !baseUrlInvalid && !defaultModelInvalid && !apiKeyRequired) onSave()
            }}
          >
            <div className="modal-grid">
              <div className={`field full ${touched && nameInvalid ? 'invalid' : ''}`}>
                <label htmlFor="f-name">{t('名称 *')}</label>
                <input
                  id="f-name"
                  className="input"
                  required
                  maxLength={60}
                  placeholder={t('如：OpenAI 官方')}
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={touched && nameInvalid}
                />
                <span className="field-error">{t('名称不能为空。')}</span>
              </div>
              <div className="field">
                <label htmlFor="f-provider-type">{t('Provider 类型')}</label>
                <select
                  id="f-provider-type"
                  className="select"
                  value={form.providerType ?? 'openai'}
                  onChange={(e) => set('providerType', e.target.value)}
                >
                  {PROVIDER_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className={`field ${touched && baseUrlInvalid ? 'invalid' : ''}`}>
                <label htmlFor="f-base-url">{t('Base URL *')}</label>
                <input
                  id="f-base-url"
                  className="input"
                  required
                  placeholder="https://api.openai.com/v1"
                  value={form.baseUrl}
                  onChange={(e) => set('baseUrl', e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={touched && baseUrlInvalid}
                />
                <span className="field-error">{t('Base URL 不能为空。')}</span>
              </div>
              <div className={`field full api-key-field ${touched && apiKeyRequired ? 'invalid' : ''}`}>
                <label htmlFor="f-api-key">
                  API Key {isEdit ? <span className="hint">{t('（留空表示不修改）')}</span> : t(' *')}
                </label>
                <div className="api-key-input">
                  <input
                    id="f-api-key"
                    className="input"
                    type={showKey ? 'text' : 'password'}
                    placeholder={isEdit ? t('••••••••（留空不修改）') : 'sk-...'}
                    value={form.apiKey ?? ''}
                    onChange={(e) => set('apiKey', e.target.value)}
                    onBlur={() => setTouched(true)}
                    aria-invalid={touched && apiKeyRequired}
                  />
                  <button
                    type="button"
                    className="api-key-toggle"
                    aria-label={showKey ? t('隐藏密钥') : t('显示密钥')}
                    aria-pressed={showKey}
                    onClick={() => setShowKey((v) => !v)}
                  >
                    <span dangerouslySetInnerHTML={{ __html: EYE_SVG }} />
                    {showKey ? t('隐藏') : t('显示')}
                  </button>
                </div>
                {/* 与其他字段一致：错误 span 常驻 DOM，由 .invalid 控制显隐 ——
                    错误出现/消失零位移（PX-ST02） */}
                <span className="field-error">{t('API Key 不能为空。')}</span>
              </div>
              <div className={`field ${touched && defaultModelInvalid ? 'invalid' : ''}`}>
                <label htmlFor="f-default-model">{t('默认模型 *')}</label>
                <input
                  id="f-default-model"
                  className="input"
                  required
                  placeholder="gpt-4o-mini"
                  value={form.defaultModel}
                  onChange={(e) => set('defaultModel', e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={touched && defaultModelInvalid}
                />
                <span className="field-error">{t('默认模型不能为空。')}</span>
              </div>
              <div className="field">
                <label htmlFor="f-status">{t('状态')}</label>
                <select
                  id="f-status"
                  className="select"
                  value={form.status ?? 'active'}
                  onChange={(e) => set('status', e.target.value as LlmProviderStatus)}
                >
                  <option value="active">{t('启用')}</option>
                  <option value="disabled">{t('禁用')}</option>
                </select>
              </div>
              <div className="field full">
                <label htmlFor="f-models">{t('模型列表')}</label>
                <textarea
                  id="f-models"
                  className="textarea"
                  rows={2}
                  placeholder={t('可选，逗号分隔，如：gpt-4o, gpt-4o-mini, claude-3-opus')}
                  value={Array.isArray(form.models) ? form.models.join(', ') : ''}
                  onChange={(e) => {
                    const models = e.target.value
                      .split(',')
                      .map((m) => m.trim())
                      .filter((m) => m.length > 0)
                    set('models', models)
                  }}
                />
                <span className="hint">{t('留空则使用测试连接返回的模型列表')}</span>
              </div>
              <div className="field full">
                <label htmlFor="f-remark">{t('备注')}</label>
                <textarea
                  id="f-remark"
                  className="textarea"
                  maxLength={200}
                  rows={2}
                  placeholder={t('可选，便于团队识别用途')}
                  value={form.remark ?? ''}
                  onChange={(e) => set('remark', e.target.value)}
                />
              </div>
            </div>
          </form>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onSave}
            disabled={busy || nameInvalid || baseUrlInvalid || defaultModelInvalid || apiKeyRequired}
          >
            {busy ? t('保存中…') : t('保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function DeleteModal(props: {
  provider: LlmProvider
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const { provider, busy, onCancel, onConfirm } = props
  return createPortal(
    <div className="modal-backdrop open" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal" style={{ width: 420 }} role="alertdialog" aria-modal="true" aria-labelledby="del-title">
        <div className="modal-head">
          <div className="title" id="del-title">{t('删除 Provider')}</div>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)', lineHeight: 1.6 }}>
            {t('即将删除 Provider「{name}」。', { name: provider.name })}
          </p>
          <p className="muted mt-3" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
            {t('删除后该 Provider 配置立即失效，关联的调用会失败。此操作不可撤销。')}
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            {t('取消')}
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={onConfirm} disabled={busy}>
            {busy ? t('删除中…') : t('确认删除')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ─── Static read-only tabs (M8.2 形状对齐 design/settings.html) ────
//
// The five tabs below are faithful read-only shapes of design/settings.html's
// <section> bodies (model-row / toggle-row / kv / danger-zone primitives +
// the design's sample rows). Data wiring is deferred per the coverage
// analysis (默认模型→workflow config, 熔断→scheduler, 成本→资源面板聚合 API,
// 通知/账户/团队推迟到 MVP 后), but the DOM shape is in place so all six
// tabs are available and visually consistent with the design. The sample rows
// are the design's own placeholder values, not live data.

/**
 * 未接入提示条 — 占位 tab 顶部的统一提示。这些区块的 DOM 是 design 的形状
 * 回填（保留作设计参考），数据未接线，展示的数字/名单/开关均为占位。
 */
function StubNotice({ note }: { note: string }): React.ReactElement {
  const { t } = useI18n()
  return (
    <div
      className="muted"
      role="note"
      style={{
        fontSize: 'var(--text-sm)',
        lineHeight: 1.6,
        padding: '10px 14px',
        marginBottom: 16,
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      {t('⚠️ 未接入后端 — ')}{t(note)}
    </div>
  )
}

/** 默认模型 — design §models. 按角色分派 + 回退链 (model-row + toggle-row). */
const MODEL_ROWS = [
  { role: '阅读 / reader', p: '长上下文 · 便宜', model: 'claude-sonnet-4', price: '$3/M in' },
  { role: '编码 / coding', p: '工具调用强', model: 'claude-sonnet-4', price: '$3/M in' },
  { role: '验证 / verify', p: '推理深', model: 'o1', price: '$15/M in' },
  { role: '编排 / orchestrator', p: '分派与计划', model: 'claude-opus-4', price: '$15/M in' },
  { role: '抓取 / fetcher', p: '便宜快', model: 'gpt-4o-mini', price: '$0.15/M in' },
] as const

const MODEL_FALLBACK = [
  { t: '1. Anthropic claude-sonnet-4', d: '主模型 · 限流时自动切池内其他 key', chip: '主' },
  { t: '2. OpenAI gpt-4o', d: '跨渠道回退', chip: '回退' },
  { t: '3. 本地 llama-3.1-70b', d: '最终兜底 · 不消耗外部配额', chip: '兜底' },
] as const

function DefaultModelsTab(): React.ReactElement {
  const { t } = useI18n()
  return (
    <section className="settings-section active" aria-label={t(TAB_LABEL.models)}>
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>{t(TAB_LABEL.models)}</div>
      <StubNotice note="本页为设计占位数据，不反映真实配置" />
      <div className="card mb-6">
        <div className="card-head">
          <div className="card-title">{t('按角色分派')}</div>
          <span className="chip chip-outline">{t('编排器使用')}</span>
        </div>
        {MODEL_ROWS.map((r) => (
          <div className="model-row" key={r.role}>
            <div>
              <div className="nm">{t(r.role)}</div>
              <div className="p">{t(r.p)}</div>
            </div>
            <div className="pr">{r.model}</div>
            <div className="pr">{r.price}</div>
            <div>
              <span className="chip chip-teal">{t('默认')}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-head">
          <div className="card-title">{t('回退链')}</div>
          <span className="hint">{t('主模型失败时按序回退（待接入）')}</span>
        </div>
        {MODEL_FALLBACK.map((f) => (
          <div className="toggle-row" key={f.t}>
            <div className="info">
              <div className="t">{t(f.t)}</div>
              <div className="d">{t(f.d)}</div>
            </div>
            <span className="chip chip-outline">{t(f.chip)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** 通知 — design §notify. 通知事件 + 通知渠道 (toggle-row). */
const NOTIFY_EVENTS: ReadonlyArray<{ t: string; d: string; off: boolean }> = [
  { t: 'Run 失败', d: '任何 run 进入 failed 状态时通知', off: false },
  { t: '成本熔断', d: 'workspace 或全平台触达熔断阈值', off: false },
  { t: '令牌不健康', d: 'new-api 令牌限流、失效或过期', off: false },
  { t: 'Human Input 等待', d: 'HITL 节点等待人工审批时', off: false },
  { t: 'Daemon 离线', d: 'daemon 心跳丢失超 60s', off: true },
  { t: '每日成本摘要', d: '每天 09:00 推送昨日成本与 Top 5 run', off: false },
]

const NOTIFY_CHANNELS: ReadonlyArray<{ t: string; d: string; off: boolean }> = [
  { t: '站内', d: '顶栏铃铛', off: false },
  { t: '邮件', d: 'rz@team.dev', off: false },
  { t: 'Webhook', d: 'https://hooks.team.dev/od', off: true },
]

function NotifyTab(): React.ReactElement {
  const { t } = useI18n()
  return (
    <section className="settings-section active" aria-label={t(TAB_LABEL.notify)}>
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>{t(TAB_LABEL.notify)}</div>

      {/* Live task-completion notifications — desktop + sound. Fully wired
          (localStorage persistence + Web Audio + Notifications API). */}
      <NotificationSettings />

      {/* 下方通知事件/渠道列表是 design 的占位形状 — 开关均为禁用死开关。
          Banner 放在真实 NotificationSettings 卡片之后，只标记占位部分。 */}
      <StubNotice note="下方通知事件 / 渠道列表为设计占位数据，开关未接线（上方的任务通知已生效）" />
      <div className="card mt-4">
        <div className="card-head">
          <div className="card-title">{t('通知事件')}</div>
        </div>
        {NOTIFY_EVENTS.map((r) => (
          <div className="toggle-row" key={r.t}>
            <div className="info">
              <div className="t">{t(r.t)}</div>
              <div className="d">{t(r.d)}</div>
            </div>
            {/* 静态状态徽章（不是拨动开关）— 死开关的形态在诱导交互 */}
            <span className="chip chip-outline" title={t('占位 — 未接线')}>
              {r.off ? t('关闭 · 占位') : t('启用 · 占位')}
            </span>
          </div>
        ))}
      </div>
      <div className="card mt-4">
        <div className="card-head">
          <div className="card-title">{t('通知渠道')}</div>
        </div>
        {NOTIFY_CHANNELS.map((r) => (
          <div className="toggle-row" key={r.t}>
            <div className="info">
              <div className="t">{t(r.t)}</div>
              <div className="d">{t(r.d)}</div>
            </div>
            <span className="chip chip-outline" title={t('占位 — 未接线')}>
              {r.off ? t('关闭 · 占位') : t('启用 · 占位')}
            </span>
          </div>
        ))}
        <p className="muted mt-3" style={{ fontSize: 'var(--text-xs)' }}>
          {t('平台级通知事件与多渠道（邮件 / Webhook）由网关统一调度，`notifications` 表落地后接入；上方的桌面通知与提示音已即时生效。')}
        </p>
      </div>
    </section>
  )
}

/** 规划中 — 原「预算与配额 / 账户与团队 / 危险区」三个设计占位 tab 收拢处
 * （产品方案 F：占位假数据是开源产品的负资产；等真功能落地再回来开 tab）。 */
const PLANNED_AREAS = [
  '预算与配额（成本熔断 / 月度告警）',
  '账户与团队（多用户协作）',
  '危险区（暂停全部 / 数据清理）',
] as const

function PlannedTab(): React.ReactElement {
  const { t } = useI18n()
  return (
    <section className="settings-section active" aria-label={t('规划中')}>
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>{t('规划中')}</div>
      <div className="card">
        <p className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>
          {t('以下能力在产品规划中，尚未实现 —— 当前版本是单机单人模式（docs/product-plan.md Non-Goals）。')}
        </p>
        <ul style={{ margin: '10px 0 0 18px', fontSize: 'var(--text-sm)', lineHeight: 1.9 }}>
          {PLANNED_AREAS.map((a) => (
            <li key={a}>{t(a)}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export default SettingsView
