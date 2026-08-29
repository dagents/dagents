'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FlowTemplateGallery } from '@/components/flow-template-gallery'
import { PageShell } from '@/components/page-shell'
import { useI18n } from '@/i18n'

/**
 * /templates —— 模板中心独立路由（PRD 评审 D3 拍板）。
 *
 * 模板中心本体是对话框（FlowTemplateGallery，Flows 工具栏「从模板创建」
 * 同款）；本页承载它作为一级导航目的地的落点：打开即展示，关闭回工作流
 * 主场。零拷贝 —— 入口与行为单一来源。
 */
export default function TemplatesPage(): React.ReactElement {
  const router = useRouter()
  const { t } = useI18n()
  // 挂载后开（SSR 安全），关闭 = 离开本页
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setOpen(true)
  }, [])

  return (
    <PageShell crumb={t('模板中心')}>
      <FlowTemplateGallery
        open={open}
        onClose={() => {
          setOpen(false)
          router.push('/')
        }}
      />
      <div className="empty-state" style={{ minHeight: '40vh' }}>
        <div className="empty-state-icon" aria-hidden="true">🗂</div>
        <div className="h">{t('模板中心')}</div>
        <div className="d">{t('内置模板 / 团队场景 / 我的模板 —— 选择一个开始')}</div>
      </div>
    </PageShell>
  )
}
