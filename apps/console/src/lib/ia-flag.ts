/**
 * IA 开关（docs/prd-workflow-first.md）—— Workflow-First 信息架构的灰度切换。
 *
 * localStorage `dagents.ia.workflow-first`：
 *   'on'（默认）→ 新 IA：`/` = Flows 工作台、AppNavSidebar、FAB 全局副驾
 *   'off'       → 旧 IA：`/` = 聊天主页、ChatNavSidebar（P3 观察期内的回滚通道）
 *
 * 读取必须发生在挂载后（SSR/水合安全）：组件里用 useState(()=>false) +
 * useEffect 读取的既有模式，本模块只提供纯读/写函数。
 */

const KEY = 'dagents.ia.workflow-first'

export function isWorkflowFirstIA(): boolean {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem(KEY) !== 'off'
}

export function setWorkflowFirstIA(on: boolean): void {
  localStorage.setItem(KEY, on ? 'on' : 'off')
}
