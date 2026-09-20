import { PageShell } from '@/components/page-shell'
import { ShellTerminal } from '@/components/shell-terminal'

/**
 * Terminal route — 浏览器里的真终端（PTY → xterm.js）。
 *
 * 网关用 node-pty 起用户的 $SHELL，SSE 推原始终端字节流；本页只做渲染与
 * 输入回传。会话恢复/孤儿回收语义见 shell-terminal.tsx 头注。
 */
export default function TerminalPage(): React.ReactElement {
  return (
    <PageShell fullBleed>
      <ShellTerminal />
    </PageShell>
  )
}
