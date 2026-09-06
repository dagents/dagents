/**
 * 节点面板 —— 分类分组 + 搜索 + 两种添加方式：
 * 拖拽到画布（HTML5 dnd，dataTransfer 带 spec name）/ 点击加到视口。
 * 便签不在引擎注册表（CANVAS_NODES）里 —— 画布注释，单独成组补进面板。
 */

import { useMemo, useState } from 'react'
import { useI18n } from '@/i18n'
import { NodeIcon } from '../registry/icons'
import { specGroups, type NodeSpec } from '../registry/node-spec'

export const PALETTE_DND_TYPE = 'application/x-dagents-node'

/** 面板可添加项：引擎节点 spec，或画布专属（便签）。 */
export type PaletteAddable = NodeSpec | 'stickyNote'

export function Palette({
  onAdd,
}: {
  onAdd: (item: PaletteAddable) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const nodeGroups = specGroups()
      .map((g) => ({
        ...g,
        specs: g.specs.filter(
          (s) =>
            !q ||
            s.label.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q) ||
            (s.description ?? '').toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.specs.length > 0)
    const stickyHit = !q || t('便签').toLowerCase().includes(q) || 'sticky'.includes(q)
    return stickyHit ? [...nodeGroups, { key: 'canvas', label: t('画布'), specs: [] as NodeSpec[] }] : nodeGroups
    // t() 依赖语言 —— 语言切换需重算分组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  return (
    <div className={`fc-palette${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="fc-palette-fab"
        aria-label={open ? t('关闭节点面板') : t('添加节点')}
        title={open ? t('关闭节点面板') : t('添加节点（拖拽或点击加到画布）')}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '×' : '+'}
      </button>
      {open && (
        <div className="fc-palette-panel">
          <input
            className="fc-palette-search"
            type="search"
            placeholder={t('搜索节点…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="fc-palette-groups">
            {groups.map((g) => (
              <div key={g.key} className="fc-palette-group">
                <div className="fc-palette-group-title">{g.label}</div>
                {g.specs.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    className="fc-palette-item"
                    draggable
                    title={s.description ?? s.label}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PALETTE_DND_TYPE, s.name)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => onAdd(s)}
                  >
                    <span className="fc-palette-item-icon" style={{ color: s.color }}>
                      <NodeIcon icon={s.icon} size={15} />
                    </span>
                    <span className="fc-palette-item-label">{s.label}</span>
                  </button>
                ))}
                {g.key === 'canvas' && (
                  <button
                    type="button"
                    className="fc-palette-item"
                    draggable
                    title={t('画布注释，不参与执行')}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PALETTE_DND_TYPE, 'stickyNote')
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => onAdd('stickyNote')}
                  >
                    <span className="fc-palette-item-icon fc-palette-item-icon-sticky">
                      <NodeIcon icon="StickyNote" size={15} />
                    </span>
                    <span className="fc-palette-item-label">{t('便签')}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
