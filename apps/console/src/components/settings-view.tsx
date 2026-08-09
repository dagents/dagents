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

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/page-shell'
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

/** The settings tabs, grouped as the design's sub-nav renders them. */
type TabId = 'keys' | 'runtimes' | 'models' | 'quota' | 'notify' | 'account' | 'danger'

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
  { id: 'models', label: '默认模型', group: '模型' },
  { id: 'quota', label: '预算与配额', a11y: '预算配额', group: '治理' },
  { id: 'notify', label: '通知', group: '治理' },
  { id: 'account', label: '账户与团队', a11y: '账户团队', group: '账户' },
  { id: 'danger', label: '危险区', group: '账户' },
] as const

interface TabGroup {
  label: TabGroupKey
  tabs: { id: TabId; label: string }[]
}

const TAB_GROUPS: TabGroup[] = (
  ['密钥', '模型', '治理', '账户'] as const
).map((g) => ({
  label: g,
  tabs: TABS.filter((t) => t.group === g).map((t) => ({ id: t.id, label: t.label })),
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
  const [tab, setTab] = useState<TabId>('keys')

  return (
    <PageShell>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分组" role="tablist">
          {TAB_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="settings-grp">{g.label}</div>
              {g.tabs.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  role="tab"
                  className="settings-tab"
                  aria-selected={tab === it.id}
                  aria-current={tab === it.id ? 'true' : undefined}
                  aria-label={TAB_A11Y[it.id]}
                  onClick={() => setTab(it.id)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div>
          {tab === 'keys' && <LlmProvidersTab />}
          {tab === 'runtimes' && <RuntimesTab />}
          {tab === 'models' && <DefaultModelsTab />}
          {tab === 'quota' && <QuotaTab />}
          {tab === 'notify' && <NotifyTab />}
          {tab === 'account' && <AccountTab />}
          {tab === 'danger' && <DangerTab />}
        </div>
      </div>
    </PageShell>
  )
}

// ─── LLM Provider tab ───────────────────────────────────────────────

function LlmProvidersTab(): React.ReactElement {
  const [providers, setProviders] = useState<LlmProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<LlmProviderStatus | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null)

  const [editing, setEditing] = useState<{ id: string | null; form: LlmProviderFormInput } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<LlmProvider | null>(null)
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)

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

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2400)
    return () => clearTimeout(t)
  }, [toast])

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
    if (!name || !baseUrl || !defaultModel) return
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
        setToast({ msg: `Provider「${name}」已创建`, kind: 'ok' })
      } else {
        const updatePayload: Partial<LlmProviderFormInput> = { ...form }
        if (!form.apiKey) {
          delete updatePayload.apiKey
        }
        await updateLlmProvider(editing.id, updatePayload)
        setToast({ msg: `Provider「${name}」已更新`, kind: 'ok' })
      }
      setEditing(null)
      await load()
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
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
      setToast({ msg: `Provider「${p.name}」已${nextStatus === 'disabled' ? '禁用' : '启用'}`, kind: 'ok' })
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(p: LlmProvider): Promise<void> {
    setTestingId(p.id)
    try {
      const result = await testLlmProvider(p.id)
      setToast({ msg: `连接成功，发现 ${result.models.length} 个模型`, kind: 'ok' })
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setTestingId(null)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    setBusy(true)
    try {
      await deleteLlmProvider(pendingDelete.id)
      setToast({ msg: `Provider「${pendingDelete.name}」已删除`, kind: 'ok' })
      setPendingDelete(null)
      await load()
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section active" aria-label={TAB_LABEL.keys}>
      <div className="row-between mb-4">
        <div>
          <div className="card-title" style={{ fontSize: 'var(--text-lg)' }}>{TAB_LABEL.keys}</div>
          <div className="muted mt-2" style={{ fontSize: 13 }}>
            管理 LLM 服务商配置，支持多 Provider 接入与统一鉴权
          </div>
        </div>
      </div>

      <div className="tokens-toolbar">
        <div className="search-mini">
          <input
            type="search"
            placeholder="搜索 Provider 名称、类型、Base URL、默认模型…"
            aria-label="搜索 Provider"
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
            {llmProviderStatusText(s)}
          </button>
        ))}
        <span className="tk-count">
          {filtered.length} / {providers.length} 个 Provider
        </span>
        <div className="grow" />
        <button type="button" className="btn btn-accent btn-sm" onClick={openCreate}>
          + 新建 Provider
        </button>
      </div>

      <div className="table-wrap">
        <table className="data" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '20%' }}>名称</th>
              <th style={{ width: '14%' }}>类型</th>
              <th style={{ width: '22%' }}>Base URL</th>
              <th style={{ width: '16%' }}>默认模型</th>
              <th style={{ width: '12%' }}>状态</th>
              <th style={{ textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="tc muted" style={{ padding: 'var(--space-12)' }}>
                  加载中…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={6} className="tc" style={{ padding: 'var(--space-12)', color: 'var(--danger)' }}>
                  加载失败：{error}
                  <div className="mt-2">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                      重试
                    </button>
                  </div>
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="tc muted" style={{ padding: 'var(--space-12)' }}>
                  {query || statusFilter ? '没有匹配的 Provider。' : '还没有 Provider。点击「新建 Provider」创建第一个。'}
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
                    <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{p.baseUrl}</span>
                  </td>
                  <td>
                    <span className="mono" style={{ fontSize: 12 }}>{p.defaultModel}</span>
                  </td>
                  <td>
                    <span className={`status ${p.status === 'active' ? 'running' : 'idle'}`}>
                      <span className="dot" />
                      {llmProviderStatusText(p.status)}
                    </span>
                  </td>
                  <td>
                    <div className="tk-actions">
                      <button
                        type="button"
                        className="mini-btn"
                        aria-label={p.status === 'active' ? '禁用' : '启用'}
                        title={p.status === 'active' ? '禁用' : '启用'}
                        disabled={busy}
                        onClick={() => void toggleStatus(p)}
                      >
                        {p.status === 'active' ? '∥' : '▶'}
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        aria-label="测试连接"
                        title="测试连接"
                        disabled={busy || testingId === p.id}
                        onClick={() => void testConnection(p)}
                      >
                        {testingId === p.id ? '⟳' : '↻'}
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        aria-label="编辑"
                        title="编辑"
                        disabled={busy}
                        onClick={() => openEdit(p)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="mini-btn danger"
                        aria-label="删除"
                        title="删除"
                        disabled={busy}
                        onClick={() => setPendingDelete(p)}
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="muted mt-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
        Provider 配置由网关统一管理，API Key 以掩码形式显示，原文不返回前端。所有 LLM 调用经网关统一鉴权与路由。
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

      {toast ? <div className={`toast ${toast.kind}`}>{toast.msg}</div> : null}
    </section>
  )
}

// ─── CLI 运行时 tab ──────────────────────────────────────────────────
//
// A reference table of all 18 CLI agent types the platform can dispatch to,
// with their default binary, wire protocol, and a one-line description. The
// browser cannot probe the host PATH, so there is no live "installed?"
// detection — the table is a configuration reference. Status defaults to
// "未配置" (placeholder); operators confirm availability by ensuring the
// binary is on PATH where the daemon runs. Styled to match the LLM Provider
// table (`.table-wrap` + `table.data`).

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

function RuntimesTab(): React.ReactElement {
  return (
    <section className="settings-section active" aria-label={TAB_LABEL.runtimes}>
      <div className="row-between mb-4">
        <div>
          <div className="card-title" style={{ fontSize: 'var(--text-lg)' }}>{TAB_LABEL.runtimes}</div>
          <div className="muted mt-2" style={{ fontSize: 13 }}>
            平台支持的全部 CLI agent 运行时。在 daemon 主机上确保对应二进制已安装并在 <code className="mono">PATH</code> 中可用。
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '18%' }}>名称</th>
              <th style={{ width: '16%' }}>二进制</th>
              <th style={{ width: '12%' }}>协议</th>
              <th style={{ width: '10%' }}>分组</th>
              <th style={{ width: '12%' }}>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {RUNTIME_ROWS.map((r) => (
              <tr key={r.kind}>
                <td>
                  <div className="tk-name">
                    <div className="nm">{r.label}</div>
                    <div className="meta">
                      <span className="mono" style={{ fontSize: 11 }}>{r.kind}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="mono" style={{ fontSize: 12 }}>{r.binary}</span>
                </td>
                <td>
                  <span className="tk-group">{PROTOCOL_LABEL[r.protocol] ?? r.protocol}</span>
                </td>
                <td>
                  <span className="chip chip-outline" style={{ fontSize: 11 }}>{r.group}</span>
                </td>
                <td>
                  {/* Browser cannot probe PATH — status is a static placeholder.
                      Operators verify via the daemon host shell. */}
                  <span className="status idle">
                    <span className="dot" />
                    未配置
                  </span>
                </td>
                <td>
                  <span className="muted" style={{ fontSize: 12 }}>{r.hint}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted mt-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
        状态列为占位值——浏览器无法探测主机 <code className="mono">PATH</code>。请到运行 daemon 的机器上执行
        <code className="mono"> which &lt;binary&gt;</code> 确认对应 CLI 已安装。新建 Agent 时选择对应类型可自动填入默认二进制路径。
      </p>
    </section>
  )
}

function LlmProviderModal(props: {
  form: LlmProviderFormInput
  isEdit: boolean
  busy: boolean
  onChange: (form: LlmProviderFormInput) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactElement {
  const { form, isEdit, busy, onChange, onCancel, onSave } = props
  const nameInvalid = form.name.trim().length === 0
  const baseUrlInvalid = form.baseUrl.trim().length === 0
  const defaultModelInvalid = form.defaultModel.trim().length === 0
  const apiKeyRequired = !isEdit && !form.apiKey

  function set<K extends keyof LlmProviderFormInput>(key: K, value: LlmProviderFormInput[K]): void {
    onChange({ ...form, [key]: value })
  }

  return (
    <div className="modal-backdrop open" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="lp-title">
        <div className="modal-head">
          <div className="title" id="lp-title">{isEdit ? '编辑 Provider' : '新建 Provider'}</div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!nameInvalid && !baseUrlInvalid && !defaultModelInvalid && !apiKeyRequired) onSave()
            }}
          >
            <div className="modal-grid">
              <div className={`field full ${nameInvalid ? 'invalid' : ''}`}>
                <label htmlFor="f-name">名称 *</label>
                <input
                  id="f-name"
                  className="input"
                  required
                  maxLength={60}
                  placeholder="如：OpenAI 官方"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  aria-invalid={nameInvalid}
                />
                <span className="field-error">名称不能为空。</span>
              </div>
              <div className="field">
                <label htmlFor="f-provider-type">Provider 类型</label>
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
              <div className={`field ${baseUrlInvalid ? 'invalid' : ''}`}>
                <label htmlFor="f-base-url">Base URL *</label>
                <input
                  id="f-base-url"
                  className="input"
                  required
                  placeholder="https://api.openai.com/v1"
                  value={form.baseUrl}
                  onChange={(e) => set('baseUrl', e.target.value)}
                  aria-invalid={baseUrlInvalid}
                />
                <span className="field-error">Base URL 不能为空。</span>
              </div>
              <div className={`field full ${apiKeyRequired ? 'invalid' : ''}`}>
                <label htmlFor="f-api-key">
                  API Key {isEdit ? <span className="hint">（留空表示不修改）</span> : ' *'}
                </label>
                <input
                  id="f-api-key"
                  className="input"
                  type="password"
                  placeholder={isEdit ? '••••••••（留空不修改）' : 'sk-...'}
                  value={form.apiKey ?? ''}
                  onChange={(e) => set('apiKey', e.target.value)}
                  aria-invalid={apiKeyRequired}
                />
                {apiKeyRequired && <span className="field-error">API Key 不能为空。</span>}
              </div>
              <div className={`field ${defaultModelInvalid ? 'invalid' : ''}`}>
                <label htmlFor="f-default-model">默认模型 *</label>
                <input
                  id="f-default-model"
                  className="input"
                  required
                  placeholder="gpt-4o-mini"
                  value={form.defaultModel}
                  onChange={(e) => set('defaultModel', e.target.value)}
                  aria-invalid={defaultModelInvalid}
                />
                <span className="field-error">默认模型不能为空。</span>
              </div>
              <div className="field">
                <label htmlFor="f-status">状态</label>
                <select
                  id="f-status"
                  className="select"
                  value={form.status ?? 'active'}
                  onChange={(e) => set('status', e.target.value as LlmProviderStatus)}
                >
                  <option value="active">启用</option>
                  <option value="disabled">禁用</option>
                </select>
              </div>
              <div className="field full">
                <label htmlFor="f-models">模型列表</label>
                <textarea
                  id="f-models"
                  className="textarea"
                  rows={2}
                  placeholder="可选，逗号分隔，如：gpt-4o, gpt-4o-mini, claude-3-opus"
                  value={Array.isArray(form.models) ? form.models.join(', ') : ''}
                  onChange={(e) => {
                    const models = e.target.value
                      .split(',')
                      .map((m) => m.trim())
                      .filter((m) => m.length > 0)
                    set('models', models)
                  }}
                />
                <span className="hint">留空则使用测试连接返回的模型列表</span>
              </div>
              <div className="field full">
                <label htmlFor="f-remark">备注</label>
                <textarea
                  id="f-remark"
                  className="textarea"
                  maxLength={200}
                  rows={2}
                  placeholder="可选，便于团队识别用途"
                  value={form.remark ?? ''}
                  onChange={(e) => set('remark', e.target.value)}
                />
              </div>
            </div>
          </form>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-accent btn-sm"
            onClick={onSave}
            disabled={busy || nameInvalid || baseUrlInvalid || defaultModelInvalid || apiKeyRequired}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteModal(props: {
  provider: LlmProvider
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.ReactElement {
  const { provider, busy, onCancel, onConfirm } = props
  return (
    <div className="modal-backdrop open" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ width: 420 }} role="alertdialog" aria-modal="true" aria-labelledby="del-title">
        <div className="modal-head">
          <div className="title" id="del-title">删除 Provider</div>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)', lineHeight: 1.6 }}>
            即将删除 Provider <span className="mono" style={{ fontWeight: 600 }}>{provider.name}</span>。
          </p>
          <p className="muted mt-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
            删除后该 Provider 配置立即失效，关联的调用会失败。此操作不可撤销。
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={onConfirm} disabled={busy}>
            {busy ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
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
  return (
    <section className="settings-section active" aria-label={TAB_LABEL.models}>
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>{TAB_LABEL.models}</div>
      <div className="card mb-6">
        <div className="card-head">
          <div className="card-title">按角色分派</div>
          <span className="chip chip-outline">编排器使用</span>
        </div>
        {MODEL_ROWS.map((r) => (
          <div className="model-row" key={r.role}>
            <div>
              <div className="nm">{r.role}</div>
              <div className="p">{r.p}</div>
            </div>
            <div className="pr">{r.model}</div>
            <div className="pr">{r.price}</div>
            <div>
              <span className="chip chip-teal">默认</span>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-head">
          <div className="card-title">回退链</div>
          <span className="hint">主模型失败时按序回退（待接入）</span>
        </div>
        {MODEL_FALLBACK.map((f) => (
          <div className="toggle-row" key={f.t}>
            <div className="info">
              <div className="t">{f.t}</div>
              <div className="d">{f.d}</div>
            </div>
            <span className="chip chip-outline">{f.chip}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** 预算与配额 — design §quota. 全平台预算 + 熔断规则. */
const QUOTA_FALLBACK = [
  { t: '单 run 成本超 $5 暂停', d: '超阈值自动暂停并通知 owner' },
  { t: 'workspace 月配额 90% 告警', d: '达到 90% 通知，100% 阻断新 run' },
  { t: '令牌限流自动切换', d: '429/5xx 时切换网关内其他令牌，3 次失败标记不健康' },
  { t: 'daemon 超时熔断', d: '静默 120s 触发双层 watchdog，回收任务重排' },
] as const

function QuotaTab(): React.ReactElement {
  return (
    <section className="settings-section active" aria-label={TAB_LABEL.quota}>
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>{TAB_LABEL.quota}</div>
      <div className="card mb-4">
        <div className="card-head">
          <div className="card-title">全平台预算</div>
          <span className="chip chip-outline">月度</span>
        </div>
        <div className="row-between mb-3">
          <span className="muted" style={{ fontSize: 13 }}>月预算</span>
          <span className="mono" style={{ fontSize: 14 }}>$135,000</span>
        </div>
        <div className="bar mb-2">
          <span style={{ width: '31%' }} />
        </div>
        <div className="row-between">
          <span className="meta" style={{ fontSize: 11 }}>已用 $41,820 (31%)</span>
          <span className="meta" style={{ fontSize: 11 }}>熔断阈值 90%</span>
        </div>
      </div>
      <div className="card mb-4">
        <div className="card-head">
          <div className="card-title">熔断规则</div>
        </div>
        {QUOTA_FALLBACK.map((r) => (
          <div className="toggle-row" key={r.t}>
            <div className="info">
              <div className="t">{r.t}</div>
              <div className="d">{r.d}</div>
            </div>
            <label className="switch">
              <input type="checkbox" checked disabled readOnly aria-disabled="true" />
              <span className="track" />
            </label>
          </div>
        ))}
        <p className="muted mt-3" style={{ fontSize: 12 }}>
          熔断由 scheduler 实现并下发策略（spec P1.7.T6，coverage analysis §2.1 ✅）。本 tab 待资源面板聚合 API（P1.11.T6）接入后回填实时数据与策略开关。
        </p>
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
  return (
    <section className="settings-section active" aria-label={TAB_LABEL.notify}>
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>{TAB_LABEL.notify}</div>
      <div className="card">
        {NOTIFY_EVENTS.map((r) => (
          <div className="toggle-row" key={r.t}>
            <div className="info">
              <div className="t">{r.t}</div>
              <div className="d">{r.d}</div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={!r.off} disabled readOnly aria-disabled="true" />
              <span className="track" />
            </label>
          </div>
        ))}
      </div>
      <div className="card mt-4">
        <div className="card-head">
          <div className="card-title">通知渠道</div>
        </div>
        {NOTIFY_CHANNELS.map((r) => (
          <div className="toggle-row" key={r.t}>
            <div className="info">
              <div className="t">{r.t}</div>
              <div className="d">{r.d}</div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={!r.off} disabled readOnly aria-disabled="true" />
              <span className="track" />
            </label>
          </div>
        ))}
        <p className="muted mt-3" style={{ fontSize: 12 }}>
          通知系统超出 MVP 范围（coverage analysis §2.3：通知系统推迟）。`notifications` 表（spec P1.2.T10）尚未落地；本 tab 在该里程碑后接入。
        </p>
      </div>
    </section>
  )
}

/** 账户与团队 — design §account. 个人 kv + 团队成员 (model-row). */
const ACCOUNT_KV = [
  ['姓名', '饶哲'],
  ['邮箱', 'rz@team.dev'],
  ['角色', 'owner'],
  ['SSO', '已绑定 · Google'],
  ['默认 workspace', '论文复现 · RL'],
] as const

const TEAM_MEMBERS: ReadonlyArray<{ nm: string; p: string; role: string; scope: string; tag?: string }> = [
  { nm: '饶哲', p: 'rz@team.dev', role: 'owner', scope: '全 workspace', tag: '你' },
  { nm: '林敏', p: 'lm@team.dev', role: 'admin', scope: '3 workspace' },
  { nm: '邓凯', p: 'dk@team.dev', role: 'editor', scope: '2 workspace' },
]

function AccountTab(): React.ReactElement {
  return (
    <section className="settings-section active" aria-label={TAB_LABEL.account}>
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>{TAB_LABEL.account}</div>
      <div className="card mb-4">
        <div className="card-head">
          <div className="card-title">个人</div>
        </div>
        <dl className="kv">
          {ACCOUNT_KV.map(([k, v]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
      <div className="card">
        <div className="card-head">
          <div className="card-title">团队 · 38 成员</div>
          <button type="button" className="btn btn-secondary btn-sm" disabled>邀请</button>
        </div>
        {TEAM_MEMBERS.map((m) => (
          <div className="model-row" key={m.nm}>
            <div>
              <div className="nm">{m.nm}</div>
              <div className="p">{m.p}</div>
            </div>
            <div className="pr">{m.role}</div>
            <div className="pr">{m.scope}</div>
            <div>
              {m.tag ? <span className="chip chip-outline">{m.tag}</span> : null}
            </div>
          </div>
        ))}
        <p className="muted mt-3" style={{ fontSize: 12 }}>
          MVP 用 workspace 软隔离 + 最小 RBAC（spec P1.2.T6）。强多租户账户/团队管理推迟（coverage analysis §2.3）；成员管理待 workspace_members 表（M5b.1）接入后回填。
        </p>
      </div>
    </section>
  )
}

/** 危险区 — design §danger. 暂停 / 轮换 / 删除 (toggle-row + danger buttons). */
const DANGER_ROWS = [
  {
    t: '暂停所有运行中的 run',
    d: '立即暂停全平台运行中 agent。可恢复。',
    cta: '暂停全部',
    variant: 'outline' as const,
  },
  {
    t: '轮换全部令牌',
    d: '在 new-api 标记所有令牌为待轮换并生成新 key，旧 key 立即吊销。不可逆。',
    cta: '轮换全部',
    variant: 'outline' as const,
  },
  {
    t: '删除 workspace 及全部数据',
    d: 'runs、对话、artifact、版本快照全部删除（软删除，30 天可恢复）。',
    cta: '删除',
    variant: 'danger' as const,
  },
]

function DangerTab(): React.ReactElement {
  return (
    <section className="settings-section active" aria-label={TAB_LABEL.danger}>
      <div className="danger-zone">
        <div className="card-title mb-2" style={{ color: 'var(--danger)' }}>{TAB_LABEL.danger}</div>
        {DANGER_ROWS.map((r) => (
          <div className="toggle-row" key={r.t}>
            <div className="info">
              <div className="t">{r.t}</div>
              <div className="d">{r.d}</div>
            </div>
            {r.variant === 'danger' ? (
              <button type="button" className="btn btn-danger btn-sm" disabled>{r.cta}</button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ color: 'var(--danger)', borderColor: 'var(--danger-soft)' }}
                disabled
              >
                {r.cta}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

export default SettingsView
