// 启动态页占位脚本（M1）——只证明「tsc → dist/renderer/status.js + 经典 script 加载」
// 管线接通。M2 起改为消费 window.dagentsDesktop.onState 渲染真实编排状态
// （两服务进度 / 日志尾部 / 重试按钮 / Postgres 引导文案）。
const el = document.getElementById('status')
if (el) {
  const at = new Date().toLocaleTimeString('zh-CN')
  el.textContent = `启动态页占位（M1）· 渲染脚本已加载 ${at} —— M2 起显示服务编排进度与日志尾部。`
}
