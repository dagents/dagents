import { defineConfig } from 'vitest/config'

/**
 * 测试环境钉 warn（2026-10-08 OQ-4 终裁后默认已是 enforce）：
 * http/customFunction 节点级与集成级测试的对象是节点机制（fetch/截断/
 * 试运行 skip/headers……），不是策略默认值——enforce 下未声明 fixture 会被
 * 域名守卫先拒，机制断言全部失焦。策略三档语义由 flow-permissions.test
 * 显式 env 控制（含「缺省 = enforce」钉子，其内部 delete env 不受本文件
 * 影响——resolve 现读 process.env），enforce 全链由 gateway
 * workflow-permissions.test（显式 enforce）与 e2e PG/WF 系列承担。
 */
process.env.DAGENTS_HTTP_DOMAIN_POLICY = 'warn'

export default defineConfig({
  test: {
    watch: false,
  },
})
