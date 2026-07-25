'use client'

import type { DispatchTask } from '@/components/daemons-queue'
import { Icon } from '@/components/icon'

interface DaemonsTimelineProps {
  task: DispatchTask | null
}

export function DaemonsTimeline({ task }: DaemonsTimelineProps): React.ReactElement {
  return (
    <div className="daemons-timeline">
      <div className="daemons-col-header">
        <Icon name="flows" style={{ width: 14, height: 14 }} />
        <span>执行时间线</span>
      </div>
      {!task ? (
        <div className="daemons-empty">选择左侧任务查看详情</div>
      ) : (
        <div className="daemons-timeline-body">
          <div className="daemons-timeline-task-head">
            <span className="mono">{task.id.slice(0, 8)}</span>
            <span className={`daemons-task-status status-${task.status}`}>{task.status}</span>
          </div>
          <div className="daemons-timeline-steps">
            <div
              className={`daemons-timeline-step ${
                task.status === 'done' ? 'done' : task.status === 'running' ? 'running' : 'queued'
              }`}
            >
              <span className="daemons-timeline-step-dot" />
              <span className="daemons-timeline-step-label">任务创建</span>
              <span className="daemons-timeline-step-time">
                {new Date(task.created_at).toLocaleString()}
              </span>
            </div>
            <div
              className={`daemons-timeline-step ${
                task.status === 'running'
                  ? 'running'
                  : task.status === 'done' || task.status === 'failed'
                    ? 'done'
                    : 'queued'
              }`}
            >
              <span className="daemons-timeline-step-dot" />
              <span className="daemons-timeline-step-label">派发到 daemon</span>
            </div>
            <div
              className={`daemons-timeline-step ${
                task.status === 'done'
                  ? 'done'
                  : task.status === 'failed'
                    ? 'failed'
                    : 'queued'
              }`}
            >
              <span className="daemons-timeline-step-dot" />
              <span className="daemons-timeline-step-label">
                {task.status === 'failed' ? '执行失败' : '执行完成'}
              </span>
              {task.updated_at !== task.created_at && (
                <span className="daemons-timeline-step-time">
                  {new Date(task.updated_at).toLocaleString()}
                </span>
              )}
            </div>
          </div>
          <div className="daemons-timeline-logs">
            <div className="daemons-timeline-logs-head">日志</div>
            <pre className="daemons-timeline-logs-body">
{`[task ${task.id.slice(0, 8)}] type=${task.type} priority=${task.priority}
[task ${task.id.slice(0, 8)}] status=${task.status}
[task ${task.id.slice(0, 8)}] flow=${task.flow_id ?? 'none'}`}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
