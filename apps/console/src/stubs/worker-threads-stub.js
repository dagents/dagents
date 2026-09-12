/**
 * 浏览器端 worker_threads 替身（2026-09-08）：canvas 页面图把
 * @dagents/workflow dist 拉进客户端 bundle（CANVAS_NODES 元数据链），
 * 其中 CustomFunction 的 user-code-exec 静态 import worker_threads ——
 * 该代码只在网关侧执行，浏览器里永远不会 new Worker。
 * Turbopack 走这里的 resolveAlias 替身；webpack（next build / 裸 dev）
 * 走 next.config 的 resolve.fallback 置空，两路等价。
 */
export default {}
export const Worker = undefined
