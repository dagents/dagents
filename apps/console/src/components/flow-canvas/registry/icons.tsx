/**
 * 节点图标 —— CANVAS_NODES meta.icon 字符串到内联 SVG 的映射。
 * 替代 vendor 时代的 /api/flowise/api/v1/node-icon BFF（生成 SVG 字母块）。
 * 全部 16×16 stroke 风格，currentColor 跟随文本色。
 */

import type { JSX } from 'react'

type IconComponent = (props: { size?: number; className?: string }) => JSX.Element

function svg(paths: JSX.Element, displayName: string): IconComponent {
  const C = ({ size = 16, className }: { size?: number; className?: string }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths}
    </svg>
  )
  C.displayName = displayName
  return C
}

const ICONS: Record<string, IconComponent> = {
  Play: svg(
    <>
      <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none" />
    </>,
    'PlayIcon',
  ),
  Bot: svg(
    <>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4" />
      <circle cx="12" cy="3" r="1" />
      <circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1" fill="currentColor" stroke="none" />
      <path d="M9 17h6" />
      <path d="M2 13v3M22 13v3" />
    </>,
    'BotIcon',
  ),
  Brain: svg(
    <>
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 20 17.5v-11A2.5 2.5 0 0 0 17.5 4" />
    </>,
    'BrainIcon',
  ),
  Globe: svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>,
    'GlobeIcon',
  ),
  GitBranch: svg(
    <>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M6 12h9.8" />
    </>,
    'GitBranchIcon',
  ),
  Repeat: svg(
    <>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </>,
    'RepeatIcon',
  ),
  User: svg(
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </>,
    'UserIcon',
  ),
  MessageSquare: svg(
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </>,
    'MessageSquareIcon',
  ),
  Code: svg(
    <>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </>,
    'CodeIcon',
  ),
  StickyNote: svg(
    <>
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2z" />
      <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
    </>,
    'StickyNoteIcon',
  ),
}

export function NodeIcon({ icon, size = 16, className }: { icon: string; size?: number; className?: string }) {
  const C = ICONS[icon] ?? ICONS.Code!
  return <C size={size} className={className} />
}
