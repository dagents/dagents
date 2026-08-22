'use client'

/* eslint-disable @typescript-eslint/no-explicit-any -- adapter for @dagents/agentflow React Flow node/edge shapes that aren't exported as concrete types */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Agentflow } from '@dagents/agentflow'
import type { AgentFlowInstance, FlowData, HeaderRenderProps } from '@dagents/agentflow'
import { getNodeMeta, validateFlowTopology } from '@dagents/workflow'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
// flowise.css 是 vendor 画布的基础样式（节点 max-content 尺寸规则 + React Flow
// 定位/handle/edge 基类），canvas.css 只在其上做主题变量覆盖。此前 base 缺失，
// 节点量不出尺寸 → React Flow 永久 visibility:hidden → 边被静默丢弃，
// 画布表现为空白只剩工具栏。必须在 canvas.css 之前引入。
import '@dagents/agentflow/flowise.css'
import './canvas.css'

export interface FlowiseCanvasProps {
  flowId: string
  flowName?: string
  initialFlow: {
    nodes: any[]
    edges: any[]
    viewport?: any
  }
  onSave?: (data: any) => Promise<void>
  readOnly?: boolean
}

/**
 * 将后端存储的 flowData 转换为 Flowise Agentflow 期望的 FlowData 格式。
 *
 * 关键处理：补全 outputAnchors。从列表 API 读取的老数据可能缺少
 * outputAnchors 字段，这里根据 @dagents/workflow 注册表的 meta.outputs
 * 生成默认输出锚点，保证 Flowise 原生 AgentFlowNode 的 NodeOutputHandles
 * 能正确渲染连线端口。
 */
export function convertToFlowiseFormat(initialFlow: FlowiseCanvasProps['initialFlow']): FlowData {
  const nodes = initialFlow.nodes.map((node) => {
    const name = node.data?.name || node.name || 'startAgentflow'
    const meta = getNodeMeta(name)

    // 补全 outputAnchors：老数据可能缺这个字段
    // id 用 name（如 "true"/"false"），使其与边的 sourceHandle 匹配
    let outputAnchors = node.data?.outputAnchors
    if (!outputAnchors || !Array.isArray(outputAnchors)) {
      if (meta?.outputs && Array.isArray(meta.outputs) && meta.outputs.length > 0) {
        outputAnchors = meta.outputs.map((o: any) => {
          const oName = typeof o === 'string' ? o : o.name ?? 'output'
          return {
            id: oName,
            name: oName,
            label: typeof o === 'string' ? o : o.label ?? oName,
            type: typeof o === 'string' ? 'string' : o.type ?? 'string',
          }
        })
      } else {
        outputAnchors = [
          {
            id: 'output',
            name: 'output',
            label: 'Output',
            type: 'string',
          },
        ]
      }
    }

    // 确保节点 type 被正确设置为 Flowise 原生类型
    // 后端存储的 type 可能是 'default' 或 undefined，需统一映射
    const rawType = node.type ?? ''
    const flowiseType =
      rawType === 'stickyNote' || rawType === 'iteration'
        ? rawType
        : rawType === 'agentflowNode'
          ? rawType
          : 'agentflowNode'

    return {
      ...node,
      type: flowiseType,
      data: {
        ...node.data,
        id: node.id,
        name,
        // 显示名优先级：存量 label → meta.label（Start / LLM / Direct Reply 等
        // 注册表显示名）→ 内部 name。老数据只有 data.name，缺少 label 与
        // handle 字段，若直接回退成 'Start' 会让所有节点看起来一模一样。
        label: node.data?.label || node.label || meta?.label || name,
        outputAnchors,
        inputs: node.data?.inputs ?? {},
        hideInput: node.data?.hideInput ?? meta?.category === 'start',
        // 注入 version，避免 Flowise NodeWarningIndicator 显示 "Node outdated" 橙色感叹号
        version: node.data?.version ?? 1,
      },
    }
  })

  // NodeInputHandle 的 target handle id 约定为「目标节点自身 id」，
  // NodeOutputHandles 的 source handle id 约定为「输出锚点 id」。存量/AI 生成的
  // 边只有 source/target，缺 handle 字段 —— React Flow 匹配不到 handle 会静默
  // 丢弃这些边，因此这里按约定补全。type/data 也对齐 handleConnect 生成的
  // agentflowEdge 形状，保证加载的边与手工连线渲染一致。
  const sourceAnchorByNodeId = new Map(
    nodes.map((n) => [n.id, n.data.outputAnchors?.[0]?.id ?? 'output']),
  )
  const edges = initialFlow.edges.map((edge) => ({
    ...edge,
    sourceHandle: edge.sourceHandle ?? sourceAnchorByNodeId.get(edge.source) ?? 'output',
    targetHandle: edge.targetHandle ?? edge.target,
    type: edge.type ?? 'agentflowEdge',
    animated: edge.animated ?? false,
    data: edge.data ?? {
      sourceColor: '#10b981',
      targetColor: '#10b981',
      edgeLabel: undefined,
      isHumanInput: false,
    },
  }))

  return {
    nodes,
    edges,
    viewport: initialFlow.viewport || { x: 0, y: 0, zoom: 1 },
  }
}

/**
 * 拓扑问题清单 → toast 文案片段：展示前 limit 条原文（校验器消息含节点 id），
 * 超出部分折叠为「等 {n} 条」计数。
 */
function formatTopologyIssues(
  issues: ReadonlyArray<{ message: string }>,
  limit: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const shown = issues.slice(0, limit).map((issue) => issue.message).join('；')
  return issues.length > limit ? `${shown} …${t('等 {n} 条', { n: issues.length })}` : shown
}

export function FlowiseCanvas({
  flowId,
  flowName = 'Untitled',
  initialFlow,
  onSave,
  readOnly = false,
}: FlowiseCanvasProps): React.ReactElement {
  const agentflowRef = useRef<AgentFlowInstance>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const toast = useToast()
  const { t } = useI18n()

  const initialFlowData = useMemo(
    () => convertToFlowiseFormat(initialFlow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialFlow],
  )

  const handleSave = useCallback(
    async (flowData: FlowData) => {
      // 保存前拓扑干跑（docs/product-plan.md 方案 A4）：errors=不可执行 /
      // warnings=可疑，全部不阻断保存 —— 尊重草稿自由，把「执行时才爆炸」
      // 提前到「保存时就看见」。校验器是 @dagents/workflow 的 AD-2 单源
      // 实现，vendor 画布形状（data.name 优先、type 回退）直接喂即可。
      const topology = validateFlowTopology(flowData)
      // 保存成功后才提示 —— PUT 失败时说「已保存」会误导。
      // 全干净不提示：保存按钮已有「已保存 ✓」状态反馈，不重复。
      const notifyTopologyAfterSave = () => {
        if (!topology.ok) {
          toast.error(
            `${t('已保存，但该流程当前无法运行')}：${formatTopologyIssues(topology.errors, 3, t)}`,
            8000,
          )
        } else if (topology.warnings.length > 0) {
          toast.warning(
            `${t('已保存，流程有可疑之处')}：${formatTopologyIssues(topology.warnings, 2, t)}`,
            6000,
          )
        }
      }

      // 优先使用外部 onSave，否则走默认持久化逻辑（PUT /api/workflows/:id）
      if (onSave) {
        setSaveState('saving')
        try {
          await onSave(flowData)
          setSaveState('saved')
          notifyTopologyAfterSave()
          setTimeout(() => setSaveState('idle'), 2000)
        } catch {
          setSaveState('error')
          setTimeout(() => setSaveState('idle'), 3000)
        }
        return
      }

      setSaveState('saving')
      try {
        const res = await fetch(`/api/workflows/${flowId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flowData }),
        })
        if (!res.ok) {
          throw new Error(`保存失败: ${res.status}`)
        }
        setSaveState('saved')
        notifyTopologyAfterSave()
        setTimeout(() => setSaveState('idle'), 2000)
      } catch (err) {
        console.error('保存工作流失败:', err)
        setSaveState('error')
        setTimeout(() => setSaveState('idle'), 3000)
      }
    },
    [onSave, flowId, toast, t],
  )

  // 自定义 header：显示真实 flowName + 美观的 Save 按钮（带状态反馈）
  const renderHeader = useCallback(
    (props: HeaderRenderProps) => {
      const saveLabel =
        saveState === 'saving'
          ? '保存中…'
          : saveState === 'saved'
            ? '已保存 ✓'
            : saveState === 'error'
              ? '保存失败'
              : '保存'
      const saveClass = `canvas-save-btn canvas-save-btn--${saveState}`
      return (
        <div className='agentflow-header'>
          <span className='agentflow-title'>
            {flowName}
            {props.isDirty && ' *'}
          </span>
          <div className='agentflow-header-actions'>
            <button
              className={saveClass}
              onClick={props.onSave}
              disabled={readOnly || saveState === 'saving'}
            >
              {saveLabel}
            </button>
          </div>
        </div>
      )
    },
    [flowName, saveState, readOnly],
  )

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 520 }}>
      <Agentflow
        ref={agentflowRef}
        apiBaseUrl='/api/flowise'
        flowId={flowId}
        initialFlow={initialFlowData}
        onSave={handleSave}
        readOnly={readOnly}
        showDefaultHeader={false}
        renderHeader={renderHeader}
        showDefaultPalette={true}
        enableGenerator={true}
      />
    </div>
  )
}
