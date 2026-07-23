/**
 * Settings page 6-tab UI (P1.10.T8 / M5a.4 → M8.2 形状对齐 design).
 *
 * Ported from design/settings.html: a sticky left sub-nav (6 tabs grouped
 * 密钥/模型/治理/账户) switches the visible `<section>`. The API Key tab is
 * the only one with live wiring — it CRUDs new-api tokens via the
 * `/api/tokens/*` proxy (browser → gateway → new-api + token_meta sync).
 *
 * M8.2 对齐 design/settings.html 全 690 行：其余 5 tab（默认模型 / 预算配额
 * / 通知 / 账户与团队 / 危险区）按 design 的 DOM 形状逐一回填 — model-row /
 * toggle-row / kv / danger-zone 原语 + design 的占位数据。数据接线延后但形状
 * 在（coverage analysis §2.2/2.3 明确推迟通知与账户/团队，默认模型→Flowise
 * 配置、熔断→scheduler、成本→资源面板聚合 API）。
 *
 * 各 tab 的占位数据来自 design 的静态 HTML / tokens-data.js，标注待接入
 * 里程碑，避免假交互；API Key tab 是唯一真 CRUD 的地方。
 *
 * Token table columns mirror the design: 名称 / Key / 分组 / 额度 / 过期 / 操作.
 * The key is new-api-masked (the raw key never reaches the browser); copy
 * is disabled for the masked form. Row actions: 启用/禁用 toggle, 编辑, 删除
 * (delete opens a confirm modal). New/edit open a modal form with the
 * new-api token fields + a local-only remark.
 *
 * Tab buttons use role="tab" so the fidelity test can `getByRole('tab')`;
 * `aria-current` is the design's active affordance.
 */

'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/page-shell'
import {
  createToken,
  deleteToken,
  getGatewayHealth,
  listTokens,
  updateToken,
  type GatewayHealth,
} from '@/lib/tokens-client'
import type { ApiToken, TokenFormInput, TokenStatus } from '@/lib/tokens'

/** The six settings tabs, grouped as the design's sub-nav renders them. */
type TabId = 'keys' | 'models' | 'quota' | 'notify' | 'account' | 'danger'

interface TabGroup {
  label: string
  tabs: { id: TabId; label: string }[]
}

const TAB_GROUPS: TabGroup[] = [
  { label: '密钥', tabs: [{ id: 'keys', label: 'API Key 管理' }] },
  { label: '模型', tabs: [{ id: 'models', label: '默认模型' }] },
  {
    label: '治理',
    tabs: [
      { id: 'quota', label: '预算与配额' },
      { id: 'notify', label: '通知' },
    ],
  },
  {
    label: '账户',
    tabs: [
      { id: 'account', label: '账户与团队' },
      { id: 'danger', label: '危险区' },
    ],
  },
]

/**
 * The accessible name each tab exposes via aria-label. The fidelity test
 * keys tabs by their short design name (API Key / 默认模型 / 预算配额 /
 * 通知 / 账户团队 / 危险区); the visible button text carries the longer
 * design label, so aria-label carries the short form.
 */
const TAB_A11Y: Record<TabId, string> = {
  keys: 'API Key',
  models: '默认模型',
  quota: '预算配额',
  notify: '通知',
  account: '账户团队',
  danger: '危险区',
}

const STATUS_CN: Record<TokenStatus, string> = {
  active: '启用',
  disabled: '禁用',
  expired: '已过期',
  exhausted: '已耗尽',
}

/** new-api quota-points unit: 1$ ≈ 500000 (docs/m0-newapi-setup.md §3). */
const POINTS_PER_DOLLAR = 500_000

function maskKey(key: string): string {
  if (!key) return ''
  // new-api already masks (e.g. `AAAA**********aaaa`); show as-is. If a full
  // key ever slipped through, mask the middle defensively.
  if (key.includes('*')) return key
  if (key.length <= 12) return key.slice(0, 4) + '••••' + key.slice(-4)
  return key.slice(0, 8) + '••••••••' + key.slice(-4)
}

function fmtQuotaPoints(points: number): string {
  if (points >= 1000) return `${(points / 1000).toFixed(0)}K`
  return String(points)
}

/**
 * Remaining quota for the row, in new-api quota-points. `ApiToken.remainQuota`
 * is new-api's `remain_quota` (the *remaining* budget), which is exactly what
 * we send back as `remain_quota` on edit — so a name-only edit doesn't change
 * the budget. Returns `null` for unlimited tokens (no remaining budget to edit).
 */
function remainFromToken(t: ApiToken): number | null {
  if (t.unlimitedQuota) return null
  return t.remainQuota ?? 0
}

function quotaPct(t: ApiToken): number {
  // Used / original grant. `totalQuota` is the derived grant (used + remain),
  // so this is the design's `used / total` bar — NOT used / (used+remain),
  // which would double-count `used` in the denominator and under-report.
  if (!t.totalQuota) return 0
  return Math.min(100, Math.round((t.usedQuota / t.totalQuota) * 100))
}

function expiryText(t: ApiToken): string {
  if (!t.expiredTime) return '永久'
  const d = new Date(t.expiredTime * 1000)
  const now = new Date()
  if (d < now) return '已过期'
  const days = Math.ceil((d.getTime() - now.getTime()) / 86_400_000)
  return days > 30 ? d.toLocaleDateString('zh-CN') : `${days} 天后`
}

const TOKEN_GROUPS = ['default', 'prod', 'dev', 'research', 'external'] as const

const EMPTY_FORM: TokenFormInput = {
  name: '',
  group: 'default',
  remainQuota: null,
  unlimitedQuota: false,
  expiredTime: null,
  models: null,
  meta: { remark: '', visibility: 'workspace' },
}

export function SettingsView(): React.ReactElement {
  const [tab, setTab] = useState<TabId>('keys')

  return (
    <PageShell
      title="设置"
      subtitle="new-api 令牌 CRUD、网关健康探测、默认模型、预算配额与熔断、通知。令牌经 new-api 统一签发，上游渠道由网关维护。"
    >
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
          {tab === 'keys' && <ApiKeysTab />}
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

// ─── API Key tab ───────────────────────────────────────────────

function ApiKeysTab(): React.ReactElement {
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<TokenStatus | null>(null)
  const [health, setHealth] = useState<GatewayHealth | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null)

  const [editing, setEditing] = useState<{ id: number | null; form: TokenFormInput } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ApiToken | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [list, h] = await Promise.all([listTokens(), getGatewayHealth()])
      setTokens(list.tokens)
      setHealth(h)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Auto-dismiss the toast after a couple seconds.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2400)
    return () => clearTimeout(t)
  }, [toast])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tokens.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false
      if (q && !(t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))) return false
      return true
    })
  }, [tokens, query, statusFilter])

  function openCreate(): void {
    setEditing({ id: null, form: { ...EMPTY_FORM, meta: { remark: '', visibility: 'workspace' } } })
  }

  function openEdit(t: ApiToken): void {
    setEditing({
      id: t.id,
      form: {
        name: t.name,
        group: t.group,
        // Backfill the *remaining* budget (new-api's remain_quota), not the
        // original grant — sending the grant back as remain_quota would add
        // the used amount to the token's budget on every save.
        remainQuota: remainFromToken(t),
        unlimitedQuota: t.unlimitedQuota,
        expiredTime: t.expiredTime,
        // `models: null` → no `models` key sent → new-api keeps the existing
        // allowlist (the form doesn't surface the allowlist for editing yet).
        models: null,
        meta: { remark: t.remark ?? '', visibility: t.visibility ?? 'workspace' },
      },
    })
  }

  async function save(): Promise<void> {
    if (!editing) return
    const name = editing.form.name.trim()
    if (!name) return
    setBusy(true)
    try {
      const form: TokenFormInput = { ...editing.form, name, meta: editing.form.meta }
      if (editing.id === null) {
        await createToken(form)
        setToast({ msg: `令牌「${name}」已创建`, kind: 'ok' })
      } else {
        await updateToken(editing.id, form)
        setToast({ msg: `令牌「${name}」已更新`, kind: 'ok' })
      }
      setEditing(null)
      await load()
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  async function toggleStatus(t: ApiToken): Promise<void> {
    // new-api status: 1=enabled, 2=disabled. Flip it explicitly via PUT — the
    // gateway forwards `status` through to new-api's UpdateToken. Only the
    // status flips; quota / expiry / name are re-sent as-is (using the
    // remaining budget, not the grant, so the budget is preserved).
    const nextStatus: 1 | 2 = t.status === 'active' ? 2 : 1
    setBusy(true)
    try {
      await updateToken(t.id, {
        name: t.name,
        group: t.group,
        remainQuota: remainFromToken(t),
        unlimitedQuota: t.unlimitedQuota,
        expiredTime: t.expiredTime,
        models: null,
        status: nextStatus,
        meta: { remark: t.remark ?? '', visibility: t.visibility ?? 'workspace' },
      })
      await load()
      setToast({ msg: `令牌「${t.name}」已${nextStatus === 2 ? '禁用' : '启用'}`, kind: 'ok' })
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    setBusy(true)
    try {
      await deleteToken(pendingDelete.id)
      setToast({ msg: `令牌「${pendingDelete.name}」已删除`, kind: 'ok' })
      setPendingDelete(null)
      await load()
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section active" aria-label="API Key 管理">
      <div className="row-between mb-4">
        <div>
          <div className="card-title" style={{ fontSize: 'var(--text-lg)' }}>API Key 管理</div>
          <div className="muted mt-2" style={{ fontSize: 13 }}>
            通过 new-api 网关统一鉴权与计费，平台只管理令牌（token）的 CRUD
          </div>
        </div>
      </div>

      <GatewayCard health={health} tokenCount={tokens.length} />

      <div className="tokens-toolbar">
        <div className="search-mini">
          <input
            type="search"
            placeholder="搜索令牌名称或 key…"
            aria-label="搜索令牌"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {(['active', 'disabled', 'expired'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className="filter-chip"
            aria-pressed={statusFilter === s}
            onClick={() => setStatusFilter((prev) => (prev === s ? null : s))}
          >
            {STATUS_CN[s]}
          </button>
        ))}
        <span className="tk-count">
          {filtered.length} / {tokens.length} 个令牌
        </span>
        <div className="grow" />
        <button type="button" className="btn btn-accent btn-sm" onClick={openCreate}>
          + 新建令牌
        </button>
      </div>

      <div className="table-wrap">
        <table className="data" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '24%' }}>名称</th>
              <th style={{ width: '22%' }}>Key</th>
              <th>分组</th>
              <th>额度</th>
              <th>过期</th>
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
                  {query || statusFilter ? '没有匹配的令牌。' : '还没有令牌。点击「新建令牌」创建第一个。'}
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const pct = quotaPct(t)
                const qCls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''
                return (
                  <tr key={t.id}>
                    <td>
                      <div className="tk-name">
                        <div className="nm">
                          {t.name}
                          {t.isDefault ? <span className="badge-default">默认</span> : null}
                        </div>
                        <div className="meta">{t.unlimitedQuota ? '无限额度' : `${fmtQuotaPoints(t.totalQuota ?? 0)} 点`}</div>
                      </div>
                    </td>
                    <td>
                      <span className="tk-key mono">{maskKey(t.key)}</span>
                    </td>
                    <td>
                      <span className="tk-group">{t.group}</span>
                    </td>
                    <td>
                      <div className="tk-quota">
                        <div className={`bar ${qCls}`}>
                          <span style={{ width: `${pct}%` }} />
                        </div>
                        <div className="num">
                          {t.unlimitedQuota ? '∞' : `${fmtQuotaPoints(t.usedQuota)} / ${fmtQuotaPoints(t.totalQuota ?? 0)}`}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`status ${t.status === 'active' ? 'running' : t.status === 'expired' ? 'failed' : 'idle'}`}>
                        <span className="dot" />
                        {STATUS_CN[t.status]}
                      </span>
                      <div className="meta" style={{ fontSize: 10, marginTop: 2 }}>
                        {expiryText(t)}
                      </div>
                    </td>
                    <td>
                      <div className="tk-actions">
                        <button
                          type="button"
                          className="mini-btn"
                          aria-label={t.status === 'active' ? '禁用' : '启用'}
                          title={t.status === 'active' ? '禁用' : '启用'}
                          disabled={busy}
                          onClick={() => void toggleStatus(t)}
                        >
                          {t.status === 'active' ? '∥' : '▶'}
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          aria-label="编辑"
                          title="编辑"
                          disabled={busy}
                          onClick={() => openEdit(t)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="mini-btn danger"
                          aria-label="删除"
                          title="删除"
                          disabled={busy}
                          onClick={() => setPendingDelete(t)}
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="muted mt-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
        令牌由 new-api 签发并托管，平台本地不存原文。所有 LLM/工具调用经网关统一鉴权与计费，上游渠道（Anthropic / OpenAI / Google / 本地）由 new-api 的渠道管理维护。
      </p>

      {editing ? (
        <TokenModal
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
          token={pendingDelete}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.msg}</div> : null}
    </section>
  )
}

function GatewayCard({ health, tokenCount }: { health: GatewayHealth | null; tokenCount: number }): React.ReactElement {
  const reachable = health?.reachable === true
  return (
    <div className="gateway">
      <div className="gw-mark">N</div>
      <div>
        <div className="gw-title">new-api 网关</div>
        <div className="gw-sub">
          <span className={`s status ${reachable ? 'online' : 'offline'}`}>
            <span className="dot" />
            {reachable ? '已连接' : '未连接'}
          </span>
          <span className="s mono">{reachable && health?.svc ? `svc=${health.svc}` : '经网关代理'}</span>
        </div>
      </div>
      <div className="gw-meta">
        <div className="gw-stat">
          <div className="v">{tokenCount}</div>
          <div className="l">令牌</div>
        </div>
      </div>
    </div>
  )
}

function TokenModal(props: {
  form: TokenFormInput
  isEdit: boolean
  busy: boolean
  onChange: (form: TokenFormInput) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactElement {
  const { form, isEdit, busy, onChange, onCancel, onSave } = props
  const nameInvalid = form.name.trim().length === 0

  function set<K extends keyof TokenFormInput>(key: K, value: TokenFormInput[K]): void {
    onChange({ ...form, [key]: value })
  }

  // datetime-local → epoch seconds (or null). The form keeps expiredTime as
  // epoch seconds; the input renders a local-datetime string.
  const expiredLocal = form.expiredTime
    ? new Date(form.expiredTime * 1000).toISOString().slice(0, 16)
    : ''

  return (
    <div className="modal-backdrop open" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tm-title">
        <div className="modal-head">
          <div className="title" id="tm-title">{isEdit ? '编辑令牌' : '新建令牌'}</div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!nameInvalid) onSave()
            }}
          >
            <div className="modal-grid">
              <div className={`field full ${nameInvalid ? 'invalid' : ''}`}>
                <label htmlFor="f-name">令牌名称 *</label>
                <input
                  id="f-name"
                  className="input"
                  required
                  maxLength={40}
                  placeholder="如：论文复现-生产"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  aria-invalid={nameInvalid}
                />
                <span className="field-error">名称不能为空。</span>
              </div>
              <div className="field">
                <label htmlFor="f-group">分组</label>
                <select
                  id="f-group"
                  className="select"
                  value={form.group ?? 'default'}
                  onChange={(e) => set('group', e.target.value)}
                >
                  {TOKEN_GROUPS.map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
                <span className="hint">用于 new-api 按组限流与分摊</span>
              </div>
              <div className="field">
                <label htmlFor="f-quota">剩余额度（额度点）</label>
                <input
                  id="f-quota"
                  className="input"
                  type="number"
                  min={0}
                  step={100}
                  placeholder="500000"
                  disabled={form.unlimitedQuota}
                  value={form.remainQuota ?? ''}
                  onChange={(e) => set('remainQuota', e.target.value === '' ? null : Number(e.target.value))}
                />
                <span className="hint">
                  {isEdit
                    ? '令牌的剩余额度点；new-api 按此扣减。留空 = 不修改'
                    : `初始剩余额度点；1 点 ≈ $${(1 / POINTS_PER_DOLLAR).toFixed(4)}`}
                </span>
              </div>
              <div className="field">
                <label htmlFor="f-expired">过期时间</label>
                <input
                  id="f-expired"
                  className="input"
                  type="datetime-local"
                  value={expiredLocal}
                  onChange={(e) => {
                    const v = e.target.value
                    set('expiredTime', v ? Math.floor(new Date(v).getTime() / 1000) : null)
                  }}
                />
                <span className="hint">留空 = 永不过期</span>
              </div>
              <div className="field">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={form.unlimitedQuota ?? false}
                    onChange={(e) => set('unlimitedQuota', e.target.checked)}
                  />
                  <span className="track" />
                  <span className="switch-label">无限额度</span>
                </label>
              </div>
              <div className="field full">
                <label htmlFor="f-remark">备注</label>
                <textarea
                  id="f-remark"
                  className="textarea"
                  maxLength={120}
                  rows={2}
                  placeholder="可选，便于团队识别用途"
                  value={form.meta?.remark ?? ''}
                  onChange={(e) => set('meta', { ...(form.meta ?? { visibility: 'workspace' }), remark: e.target.value })}
                />
                <span className="hint">
                  仅本平台可见，不会同步到 new-api
                  {isEdit ? '（gateway 暂未回填，编辑时需重新填写）' : ''}
                </span>
              </div>
            </div>
          </form>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-accent btn-sm" onClick={onSave} disabled={busy || nameInvalid}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteModal(props: {
  token: ApiToken
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.ReactElement {
  const { token, busy, onCancel, onConfirm } = props
  return (
    <div className="modal-backdrop open" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ width: 420 }} role="alertdialog" aria-modal="true" aria-labelledby="del-title">
        <div className="modal-head">
          <div className="title" id="del-title">删除令牌</div>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)', lineHeight: 1.6 }}>
            即将在 new-api 上删除令牌 <span className="mono" style={{ fontWeight: 600 }}>{token.name}</span>。
          </p>
          <p className="muted mt-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
            删除后该 key 立即失效，正在进行的请求会被网关拒绝。此操作不可撤销。
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
// analysis (默认模型→Flowise config, 熔断→scheduler, 成本→资源面板聚合 API,
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
    <section className="settings-section active" aria-label="默认模型">
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>默认模型</div>
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
    <section className="settings-section active" aria-label="预算与配额">
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>预算与配额</div>
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
    <section className="settings-section active" aria-label="通知">
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>通知</div>
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
    <section className="settings-section active" aria-label="账户与团队">
      <div className="card-title mb-4" style={{ fontSize: 'var(--text-lg)' }}>账户与团队</div>
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
    <section className="settings-section active" aria-label="危险区">
      <div className="danger-zone">
        <div className="card-title mb-2" style={{ color: 'var(--danger)' }}>危险区</div>
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
