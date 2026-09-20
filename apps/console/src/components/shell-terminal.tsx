'use client'

/**
 * ShellTerminal — 浏览器里的真终端（PTY → xterm.js）：纯装配层。
 *
 * 编排（状态机/boot/IO 动作/多标签）在 lib/use-shell-session；决策语义在
 * lib/shell-session-plan；帧解析在 lib/shell-protocol；主题在 lib/shell-theme
 * —— 本文件只做布局与状态呈现。协议与语义背景见 docs/terminal-architecture.md。
 */

import { useShellSession } from '@/lib/use-shell-session'
import { ShellDirPicker } from '@/components/shell-dir-picker'
import { useI18n } from '@/i18n'
import '@xterm/xterm/css/xterm.css'
import '@/styles/terminal.css'

export function ShellTerminal(): React.ReactElement {
  const { t } = useI18n()
  const {
    phase,
    exitCode,
    booted,
    cwd,
    cwdLabel,
    dirId,
    directories,
    picking,
    tabs,
    activeTabId,
    containerRef,
    newSession,
    reconnect,
    openIn,
    browseDirectory,
    switchTo,
    closeTab,
    newTab,
  } = useShellSession()

  /** tab 标签：agent 会话用 agent 名（label）；shell 会话按目录锚取名或主目录。 */
  const tabLabel = (tabDirId: string | null, tabId: string, tabLabelField?: string): string => {
    if (tabLabelField) return tabLabelField
    if (tabDirId === null) return t('主目录')
    const dir = directories.find((d) => d.id === tabDirId)
    if (!dir) return tabId.slice(0, 6)
    const tail = dir.path.split('/').filter(Boolean).pop()
    return tail ?? dir.path
  }

  return (
    <div
      className="term-root"
      onClick={(e) => {
        // 点击面板任意空白处即聚焦输入（xterm 只接管自身区域）
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('term-screen-wrap')) {
          const ta = containerRef.current?.querySelector('.xterm-helper-textarea')
          if (ta instanceof HTMLTextAreaElement) ta.focus()
        }
      }}
    >
      <div className="term-header">
        <div className="term-status">
          <span
            className={`term-dot ${
              phase === 'live'
                ? 'term-dot-live'
                : phase === 'exited'
                  ? 'term-dot-exited'
                  : phase === 'error'
                    ? 'term-dot-error'
                    : 'term-dot-wait'
            }`}
          />
          <span className="term-status-label">
            {phase === 'connecting' && t('正在连接…')}
            {phase === 'live' && t('会话进行中')}
            {phase === 'exited' && t('会话已结束')}
            {phase === 'error' && t('连接断开')}
          </span>
          {cwdLabel && <span className="term-cwd" title={cwd ?? undefined}>{cwdLabel}</span>}
        </div>
        <div className="term-actions">
          <ShellDirPicker
            dirId={dirId}
            directories={directories}
            onPick={(id) => void openIn(id)}
            onBrowse={() => void browseDirectory()}
            picking={picking}
          />
          {phase === 'error' && (
            <button type="button" className="btn btn-ghost term-btn" onClick={reconnect}>
              {t('重连')}
            </button>
          )}
          <button type="button" className="btn btn-secondary term-btn" onClick={() => void newSession()}>
            {t('新开会话')}
          </button>
        </div>
      </div>

      {/* 多标签条（P2）：点击切换（同目录复用/异目录新 tab 由 openIn 决策在
          目录入口做）；× 删会话并移除 tab，最后一个关掉自动开新空 tab。 */}
      <div className="term-tabs" role="tablist" aria-label={t('终端标签')}>
        {tabs.map((tb) => {
          const active = tb.id === activeTabId
          return (
            <div
              key={tb.id}
              role="tab"
              aria-selected={active}
              className={`term-tab${active ? ' active' : ''}`}
              onClick={() => switchTo(tb.id)}
              title={tb.dirId ? (directories.find((d) => d.id === tb.dirId)?.path ?? '') : t('主目录')}
            >
              <span className="term-tab-label">{tabLabel(tb.dirId, tb.id, tb.label)}</span>
              {tabs.length > 1 ? (
                <button
                  type="button"
                  className="term-tab-close"
                  aria-label={t('关闭终端标签')}
                  title={t('关闭终端标签')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeTab(tb.id)
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          )
        })}
        <button
          type="button"
          className="term-tab-new"
          aria-label={t('新开终端标签')}
          title={t('新开终端标签（与当前标签同目录）')}
          onClick={newTab}
        >
          +
        </button>
      </div>

      <div className="term-screen-wrap">
        <div ref={containerRef} className="term-screen" />
        {!booted && phase !== 'exited' && phase !== 'error' && (
          <div className="term-boot">{t('正在启动 shell…')}</div>
        )}
        {(phase === 'exited' || phase === 'error') && (
          <div className="term-overlay">
            <div className="term-overlay-card">
              <p className="term-overlay-title">
                {phase === 'exited'
                  ? t('会话已结束') + (exitCode != null ? ` (exit ${exitCode})` : '')
                  : t('连接断开')}
              </p>
              <button
                type="button"
                className="btn btn-primary term-btn"
                onClick={() => void newSession()}
              >
                {t('新开会话')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
