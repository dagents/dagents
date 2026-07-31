'use client'

import { useCallback, useEffect, useState } from 'react'
import { PageShell } from '@/components/page-shell'
import '@/styles/directories.css'
import {
  type Directory,
  fetchDirectories,
  createDirectory,
  updateDirectory,
  deleteDirectory,
} from '@/lib/directories'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('zh-CN')
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const EMPTY_FORM = { path: '', name: '' }

export function DirectoriesView(): React.ReactElement {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [createForm, setCreateForm] = useState({ path: '', name: '' })
  const [editName, setEditName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<Directory | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await fetchDirectories()
      setDirectories(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDirectories([])
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

  function openCreate(): void {
    setCreateForm(EMPTY_FORM)
    setShowCreateForm(true)
  }

  function cancelCreate(): void {
    setShowCreateForm(false)
    setCreateForm(EMPTY_FORM)
  }

  async function handleCreate(): Promise<void> {
    const path = createForm.path.trim()
    if (!path) return
    setBusy(true)
    try {
      const name = createForm.name.trim() || basename(path)
      await createDirectory({ path, name })
      setToast({ msg: `目录「${name}」已创建`, kind: 'ok' })
      setShowCreateForm(false)
      setCreateForm(EMPTY_FORM)
      await load()
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  function startEdit(d: Directory): void {
    setEditingId(d.id)
    setEditName(d.name)
  }

  function cancelEdit(): void {
    setEditingId(null)
    setEditName('')
  }

  async function saveEdit(id: string): Promise<void> {
    const name = editName.trim()
    if (!name) return
    setBusy(true)
    try {
      await updateDirectory(id, { name })
      setToast({ msg: '目录已更新', kind: 'ok' })
      setEditingId(null)
      setEditName('')
      await load()
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
      await deleteDirectory(pendingDelete.id)
      setToast({ msg: `目录「${pendingDelete.name}」已删除`, kind: 'ok' })
      setPendingDelete(null)
      await load()
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell
      actions={
        <button type="button" className="btn btn-accent btn-sm" onClick={openCreate}>
          + 新建目录
        </button>
      }
    >
      {showCreateForm ? (
        <div className="directories-form">
          <div className="form-row">
            <label htmlFor="f-path">路径 *</label>
            <input
              id="f-path"
              className="input"
              type="text"
              placeholder="/path/to/project"
              value={createForm.path}
              onChange={(e) => setCreateForm((p) => ({ ...p, path: e.target.value }))}
            />
            <span className="hint">本地绝对路径，agent 工作目录</span>
          </div>
          <div className="form-row">
            <label htmlFor="f-name">名称</label>
            <input
              id="f-name"
              className="input"
              type="text"
              placeholder="留空使用路径 basename"
              value={createForm.name}
              onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
            />
            <span className="hint">可选，默认取路径最后一段</span>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelCreate} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-accent btn-sm"
              onClick={() => void handleCreate()}
              disabled={busy || !createForm.path.trim()}
            >
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="card-flat" style={{ padding: 'var(--space-4)', color: 'var(--danger)' }}>
          加载失败：{error}。点{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            刷新
          </button>{' '}
          重试。
        </div>
      ) : null}

      <div className="directories-list">
        {loading && directories.length === 0 ? (
          <div className="muted" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
            加载中…
          </div>
        ) : directories.length === 0 && !error ? (
          <div className="directories-empty">
            <div className="directories-empty-icon" aria-hidden="true">📁</div>
            <div className="directories-empty-title">还没有项目目录</div>
            <div className="directories-empty-desc">
              添加一个本地路径，作为 Agent 的工作目录。
            </div>
            <button
              type="button"
              className="btn btn-accent"
              onClick={openCreate}
            >
              + 新建目录
            </button>
          </div>
        ) : (
          directories.map((d, i) => (
            <div key={d.id} className="directory-card enter-rise" style={{ '--enter-i': i } as React.CSSProperties}>
              <div className="directory-info">
                {editingId === d.id ? (
                  <div className="directory-edit">
                    <input
                      className="input"
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                    <div className="card-actions">
                      <button
                        type="button"
                        className="btn btn-accent btn-sm"
                        onClick={() => void saveEdit(d.id)}
                        disabled={busy || !editName.trim()}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={cancelEdit}
                        disabled={busy}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="directory-name">{d.name}</div>
                    <div className="directory-path">{d.path}</div>
                    <div className="directory-meta">
                      <span>对话 {d.chatCount ?? 0}</span>
                      <span>创建于 {formatDate(d.createdAt)}</span>
                    </div>
                  </>
                )}
              </div>
              <div className="card-actions">
                {editingId !== d.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => startEdit(d)}
                      disabled={busy}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => setPendingDelete(d)}
                      disabled={busy}
                    >
                      删除
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      {pendingDelete ? (
        <div className="modal-backdrop open" onClick={(e) => e.target === e.currentTarget && setPendingDelete(null)}>
          <div className="modal" style={{ width: 420 }} role="alertdialog" aria-modal="true" aria-labelledby="del-title">
            <div className="modal-head">
              <div className="title" id="del-title">删除目录</div>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)', lineHeight: 1.6 }}>
                即将删除目录 <span className="mono" style={{ fontWeight: 600 }}>{pendingDelete.name}</span>。
              </p>
              <p className="muted mt-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
                目录删除后，关联的对话不会被删除，但不再映射到此路径。此操作不可撤销。
              </p>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPendingDelete(null)} disabled={busy}>
                取消
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => void confirmDelete()} disabled={busy}>
                {busy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.msg}</div> : null}
    </PageShell>
  )
}
