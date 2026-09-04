#!/usr/bin/env node
/**
 * README 素材拍摄脚本（一次性，不属于测试套件）。
 *
 * 产出：
 *   - docs/assets/src/flows-home-en.png      新 IA 首页（Flows 工作台，英文界面）
 *   - docs/assets/src/flows-home-zh.png      同页中文界面
 *   - docs/assets/src/canvas-idle-en.png     演示流程画布（静态）
 *   - /tmp/dagents-demo-video/*.webm         画布旁观运行的录像（后续转 GIF）
 *
 * 前置：gateway :8080 + console :3000 + mock LLM :4010（provider demo-gif-mock 已激活）。
 * 运行：cd apps/console && node scripts/capture-demo.mjs
 */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { copyFileSync } from 'node:fs'

const GW = 'http://localhost:8080'
const CONSOLE = 'http://localhost:3000'
const FLOW_ID = process.env.DEMO_FLOW_ID
const RUN_INPUT =
  'An open-source tool that turns a git diff into a narrated release video, voiced by your own cloned voice.'
const OUT_DIR = new URL('../../docs/assets/src/', import.meta.url).pathname
const VIDEO_DIR = '/tmp/dagents-demo-video'

if (!FLOW_ID) {
  console.error('missing DEMO_FLOW_ID env')
  process.exit(1)
}
mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const browser = await chromium.launch()
const localeInit = (locale) => `
  try { localStorage.setItem('dagents.locale', ${JSON.stringify(locale)}) } catch {}
`

async function newPage({ locale = 'en', record = false, dsf = 2 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: dsf,
    ...(record ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } } } : {}),
  })
  await ctx.addInitScript(localeInit(locale))
  const page = await ctx.newPage()
  return { ctx, page }
}

// ── 1. 首页（Flows 工作台）──────────────────────────────────────────────
{
  const { ctx, page } = await newPage({ locale: 'en' })
  await page.goto(CONSOLE + '/', { waitUntil: 'networkidle' })
  await page.getByText('Product Discovery Sprint').first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(2500) // 等 HoverCard/动画收尾
  await page.screenshot({ path: OUT_DIR + 'flows-home-en.png' })
  await ctx.close()
  console.log('shot: flows-home-en.png')
}
{
  const { ctx, page } = await newPage({ locale: 'zh' })
  await page.goto(CONSOLE + '/', { waitUntil: 'networkidle' })
  await page.getByText('Product Discovery Sprint').first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: OUT_DIR + 'flows-home-zh.png' })
  await ctx.close()
  console.log('shot: flows-home-zh.png')
}

// ── 2. 画布静态图 ───────────────────────────────────────────────────────
{
  const { ctx, page } = await newPage({ locale: 'en', dsf: 2 })
  await page.goto(`${CONSOLE}/workflows/${FLOW_ID}/canvas`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.react-flow', { timeout: 30_000 })
  await page.waitForTimeout(4000) // react-flow 布局稳定
  await page.screenshot({ path: OUT_DIR + 'canvas-idle-en.png' })
  await ctx.close()
  console.log('shot: canvas-idle-en.png')
}

// ── 3. 运行录像（旁观 ?run=）───────────────────────────────────────────
{
  const { ctx, page } = await newPage({ locale: 'en', dsf: 1, record: true })
  // 先空载一次预热 dev 编译，录像窗口内不浪费秒数
  await page.goto(`${CONSOLE}/workflows/${FLOW_ID}/canvas`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.react-flow', { timeout: 30_000 })
  await page.waitForTimeout(1500)

  const resp = await fetch(`${GW}/api/v1/workflows/${FLOW_ID}/run?async=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: RUN_INPUT }),
  }).then((r) => r.json())
  const runId = resp?.data?.runId
  if (!runId) throw new Error('run trigger failed: ' + JSON.stringify(resp))
  console.log('run started:', runId)

  await page.goto(`${CONSOLE}/workflows/${FLOW_ID}/canvas?run=${runId}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForSelector('.react-flow', { timeout: 30_000 })
  // 旁观模式结果面板默认自动打开（setResultsOpen(true)）——不要点任何按钮，会把面板收起
  await page.waitForTimeout(2500)

  // 轮询到终态，再留 4 秒看全文
  const t0 = Date.now()
  for (;;) {
    const s = await fetch(`${GW}/api/v1/workflows/runs/${runId}/node-spans`)
      .then((r) => r.json())
      .then((j) => j?.data)
    const status = s?.runStatus
    if (status && status !== 'running') {
      console.log('run terminal:', status, `${((Date.now() - t0) / 1000).toFixed(1)}s`)
      break
    }
    if (Date.now() - t0 > 120_000) {
      console.log('WARN: poll timeout, stop recording anyway')
      break
    }
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(4500)
  await page.screenshot({ path: OUT_DIR + 'canvas-run-done.png' })
  console.log('shot: canvas-run-done.png')
  const video = page.video()
  await ctx.close()

  const vpath = video ? await video.path() : null
  if (vpath) {
    copyFileSync(vpath, VIDEO_DIR + '/canvas-run.webm')
    console.log('video:', VIDEO_DIR + '/canvas-run.webm')
  }
}

await browser.close()
console.log('done')
