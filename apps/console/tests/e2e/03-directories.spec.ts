import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  createSeedContext,
  seedDirectory,
  seedChat,
  type SeedContext,
} from './helpers/seed'

/**
 * Directories module e2e — UC-DIR-01 ~ UC-DIR-05.
 *
 * Module: `/directories` (项目目录管理). `directories/page.tsx` renders
 * `<DirectoriesView />`, which talks to the console's thin proxy
 * `/api/directories` → gateway `/api/v1/directories` (Hono routes in
 * `apps/gateway/src/routes/directories.ts`). The gateway reads/writes the
 * `directories` table via `@mil/db` `runQuery`; `chats.directory_id` has
 * `ON DELETE CASCADE` so deleting a directory drops its chats.
 *
 * UC range & status (from gap-analysis §3):
 *   - UC-DIR-01  列出所有项目目录 ............... ✅ implemented
 *   - UC-DIR-02  添加新项目目录 ................... ✅ implemented
 *   - UC-DIR-03  编辑目录名称或 settings .......... ⚠️ partial  (name ✅, settings UI ❌)
 *   - UC-DIR-04  删除目录(级联) ................... ✅ implemented
 *   - UC-DIR-05  查看目录下对话列表 ............... ✅ implemented
 *
 * Status summary: 4 ✅, 1 ⚠️. Each implemented case asserts BOTH visible DOM
 * state (`page`) AND the HTTP contract (`request` fixture against the console
 * proxy, which forwards to the gateway). UC-DIR-03 splits into a real `test()`
 * for the working name-edit half and a `test.fixme()` for the missing settings
 * UI (quota / default-agent management) — the gateway `PATCH /:id` already
 * accepts `settings`, only the UI is absent.
 *
 * ## Prerequisites
 *
 * The dev stack must be up so the console proxy resolves upstream:
 *   - Postgres :15432  (compose remaps 5432→15432; `POSTGRES_URL` default in
 *                       helpers/seed.ts points here)
 *   - Redis    :16479
 *   - gateway  :8080   (owns `/api/v1/directories` + `/api/v1/chats`)
 * The `playwright.config.ts` webServer only owns the Next dev process
 * (baseURL, :3000 by default — override with `E2E_PORT`). `beforeAll` self-
 * seeds directories/chats via `@mil/db` `runQuery` (same layer gateway uses);
 * `afterAll` calls `ctx.dispose()` which deletes seeded rows in FK-safe order
 * (messages → chats → directories).
 *
 * ## Selector notes
 *
 * `DirectoriesView` (apps/console/src/components/directories-view.tsx) renders
 * `PageShell` (title 「项目目录」 → `<h1 class="page-title">`), a 「+ 新建目录」
 * action button, and `.directory-card` rows with `.directory-name` /
 * `.directory-path` / `.directory-meta` + 「编辑」/「删除」 buttons. The delete
 * confirm is a `role="alertdialog"` titled 「删除目录」 with a 「确认删除」
 * button. The chat sidebar (`chat-nav-sidebar.tsx`) groups chats by directory
 * under `.chat-nav-dir-group` (header button + `.chat-nav-dir-count`), used
 * for the UC-DIR-05 UI half. Locators prefer `getByRole`/`getByText`; stable
 * IDs (`#f-path`, `#f-name`) and `.directory-card` are used where ARIA is thin.
 */

// ── API response shapes (console proxy passes the gateway envelope through) ──

interface DirDTO {
  id: string
  path: string
  name: string
  settings: Record<string, unknown>
  chatCount: number
  createdAt: string
  updatedAt: string
}
interface DirListEnvelope {
  success: boolean
  data?: { items: DirDTO[] }
  error?: string
}
interface DirOneEnvelope {
  success: boolean
  data?: { directory: DirDTO }
  error?: string
}
interface DirDeleteEnvelope {
  success: boolean
  data?: { deleted: boolean; id: string }
  error?: string
}
interface ChatDTO {
  id: string
  directoryId: string
  title: string
  status: string
  messageCount: number
}
interface ChatListEnvelope {
  success: boolean
  data?: { items: ChatDTO[] }
  error?: string
}

// ── Seeded IDs (created in beforeAll, cleaned up by ctx.dispose()) ──

let ctx: SeedContext
let listDirId: string
let chatsDirId: string
let chatIdsUnderChatsDir: string[]
let editDirId: string
let deleteDirId: string
let cascadeDirId: string
let cascadeChatId: string

// A short unique tag folded into every seeded name/path so this suite never
// collides with dev data or a parallel run. workers:1 keeps it deterministic.
const SUITE_TAG = randomUUID().slice(0, 8)

test.describe('Directories module (UC-DIR-01 ~ 05)', () => {
  test.beforeAll(async () => {
    ctx = await createSeedContext()

    // UC-DIR-01: a directory that must show up in the list.
    listDirId = await seedDirectory(ctx, {
      name: `E2E-List-${SUITE_TAG}`,
      path: `/e2e/list-${SUITE_TAG}`,
    })

    // UC-DIR-05: a directory with two chats, to verify the chats-by-directory
    // API + the sidebar grouping.
    chatsDirId = await seedDirectory(ctx, {
      name: `E2E-Chats-${SUITE_TAG}`,
      path: `/e2e/chats-${SUITE_TAG}`,
    })
    chatIdsUnderChatsDir = [
      await seedChat(ctx, { directoryId: chatsDirId, title: `E2E-Chat-A-${SUITE_TAG}` }),
      await seedChat(ctx, { directoryId: chatsDirId, title: `E2E-Chat-B-${SUITE_TAG}` }),
    ]

    // UC-DIR-03: a directory to rename (name edit = working half).
    editDirId = await seedDirectory(ctx, {
      name: `E2E-Edit-${SUITE_TAG}`,
      path: `/e2e/edit-${SUITE_TAG}`,
    })

    // UC-DIR-04 (UI): a directory to delete via the confirm modal.
    deleteDirId = await seedDirectory(ctx, {
      name: `E2E-Delete-${SUITE_TAG}`,
      path: `/e2e/delete-${SUITE_TAG}`,
    })

    // UC-DIR-04 (cascade): a directory + chat deleted via the API to prove
    // `chats.directory_id ON DELETE CASCADE` drops the child chat.
    cascadeDirId = await seedDirectory(ctx, {
      name: `E2E-Cascade-${SUITE_TAG}`,
      path: `/e2e/cascade-${SUITE_TAG}`,
    })
    cascadeChatId = await seedChat(ctx, {
      directoryId: cascadeDirId,
      title: `E2E-Cascade-Chat-${SUITE_TAG}`,
    })
  })

  test.afterAll(async () => {
    // dispose() deletes messages → chats → directories in FK-safe order.
    // Rows already removed by the UC-DIR-04 delete tests are no-ops here.
    await ctx?.dispose()
  })

  // ─── UC-DIR-01: 列出所有项目目录 ───────────────────────────────────────

  test('UC-DIR-01: list directories renders seeded directory + GET /api/directories contract', async ({
    page,
    request,
  }) => {
    await page.goto('/directories')

    // Page shell renders an <h1>项目目录</h1> — the page-load sentinel.
    await expect(page.getByRole('heading', { name: '项目目录' })).toBeVisible({ timeout: 10_000 })
    // The 「+ 新建目录」 action button is always present.
    await expect(page.getByRole('button', { name: /新建目录/ })).toBeVisible()

    // The seeded list directory's card is visible with its name + path.
    const listName = `E2E-List-${SUITE_TAG}`
    const card = page.locator('.directory-card').filter({ hasText: listName })
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('.directory-name')).toHaveText(listName)
    await expect(card.locator('.directory-path')).toHaveText(`/e2e/list-${SUITE_TAG}`)
    // The meta row surfaces the chat count subquery (0 for this dir).
    await expect(card.locator('.directory-meta')).toContainText(/对话\s*0/)

    // API contract: console proxy GET /api/directories → gateway list envelope.
    const res = await request.get('/api/directories')
    expect(res.ok(), `GET /api/directories should be 2xx, got ${res.status()}`).toBe(true)
    const body = (await res.json()) as DirListEnvelope
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data?.items)).toBe(true)
    const item = body.data?.items?.find((d) => d.id === listDirId)
    expect(item, 'seeded listDirId should be present in items').toBeTruthy()
    // Shape: every field the DirectoriesView consumes must exist.
    expect(item).toMatchObject({
      id: listDirId,
      path: `/e2e/list-${SUITE_TAG}`,
      name: listName,
    })
    expect(typeof item!.chatCount).toBe('number')
    expect(typeof item!.settings).toBe('object')
    expect(typeof item!.createdAt).toBe('string')
    expect(typeof item!.updatedAt).toBe('string')
  })

  // ─── UC-DIR-02: 添加新项目目录 ─────────────────────────────────────────

  test('UC-DIR-02: create directory via form + POST /api/directories contract', async ({
    page,
    request,
  }) => {
    // API contract first: POST returns the created directory envelope.
    const apiPath = `/e2e/api-create-${SUITE_TAG}`
    const apiName = `E2E-ApiCreate-${SUITE_TAG}`
    const postRes = await request.post('/api/directories', {
      data: { path: apiPath, name: apiName },
    })
    expect(postRes.ok(), `POST should be 2xx, got ${postRes.status()}`).toBe(true)
    const postBody = (await postRes.json()) as DirOneEnvelope
    expect(postBody.success).toBe(true)
    const created = postBody.data?.directory
    expect(created).toMatchObject({ path: apiPath, name: apiName })
    expect(created!.id).toBeTruthy()
    // name-defaults-from-path: omitting name should derive the basename.
    const defaultPath = `/e2e/default-name-${SUITE_TAG}`
    const defaultRes = await request.post('/api/directories', { data: { path: defaultPath } })
    expect(defaultRes.ok()).toBe(true)
    const defaultBody = (await defaultRes.json()) as DirOneEnvelope
    expect(defaultBody.data?.directory?.name).toBe(`default-name-${SUITE_TAG}`)
    // Track both for cleanup.
    ctx.directoryIds.push(created!.id, defaultBody.data!.directory.id)

    // UI: open the create form, fill path + name, submit, assert it appears.
    const uiPath = `/e2e/ui-create-${SUITE_TAG}`
    const uiName = `E2E-UiCreate-${SUITE_TAG}`
    await page.goto('/directories')
    await expect(page.getByRole('heading', { name: '项目目录' })).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /新建目录/ }).click()
    await expect(page.locator('#f-path')).toBeVisible()
    await page.locator('#f-path').fill(uiPath)
    await page.locator('#f-name').fill(uiName)
    await page.getByRole('button', { name: '创建' }).click()

    // The form closes and the new card appears in the reloaded list.
    const newCard = page.locator('.directory-card').filter({ hasText: uiName })
    await expect(newCard).toBeVisible({ timeout: 10_000 })
    await expect(newCard.locator('.directory-name')).toHaveText(uiName)
    await expect(newCard.locator('.directory-path')).toHaveText(uiPath)
    // Success toast (ephemeral, 2.4s) — assert quickly as a secondary signal.
    await expect(page.locator('.toast.ok')).toContainText(uiName)

    // Capture the UI-created id via the list API so afterAll cleans it up.
    const listRes = await request.get('/api/directories')
    const listBody = (await listRes.json()) as DirListEnvelope
    const uiCreated = listBody.data?.items?.find((d) => d.path === uiPath)
    expect(uiCreated, 'UI-created directory should appear in GET list').toBeTruthy()
    ctx.directoryIds.push(uiCreated!.id)
  })

  // ─── UC-DIR-03: 编辑目录名称 (working half) ────────────────────────────

  test('UC-DIR-03 (name): rename via edit form + PATCH /api/directories/:id contract', async ({
    page,
    request,
  }) => {
    // API contract first: PATCH { name } returns the updated directory.
    const apiName = `E2E-Edit-API-${SUITE_TAG}`
    const patchRes = await request.patch(`/api/directories/${editDirId}`, {
      data: { name: apiName },
    })
    expect(patchRes.ok(), `PATCH should be 2xx, got ${patchRes.status()}`).toBe(true)
    const patchBody = (await patchRes.json()) as DirOneEnvelope
    expect(patchBody.success).toBe(true)
    expect(patchBody.data?.directory).toMatchObject({ id: editDirId, name: apiName })

    // API contract: PATCH { settings } is accepted by the gateway even though
    // no UI manages it yet (the ⚠️ half covered by the fixme below). Verifying
    // the contract here documents what the UI *should* eventually send.
    const settingsRes = await request.patch(`/api/directories/${editDirId}`, {
      data: { settings: { quota: 100, defaultAgentId: null } },
    })
    expect(settingsRes.ok()).toBe(true)
    const settingsBody = (await settingsRes.json()) as DirOneEnvelope
    expect(settingsBody.data?.directory?.settings).toMatchObject({ quota: 100 })

    // UI: open the card's edit row, rename, save, assert the new name sticks.
    await page.goto('/directories')
    await expect(page.getByRole('heading', { name: '项目目录' })).toBeVisible({ timeout: 10_000 })
    // After the API PATCH above, the card shows apiName — find it by that.
    const card = page.locator('.directory-card').filter({ hasText: apiName })
    await expect(card).toBeVisible({ timeout: 10_000 })

    await card.getByRole('button', { name: '编辑' }).click()
    const editInput = card.locator('input[type="text"]').first()
    await expect(editInput).toBeVisible()
    const uiName = `E2E-Edit-UI-${SUITE_TAG}`
    await editInput.fill(uiName)
    await card.getByRole('button', { name: '保存' }).click()

    // The card re-renders with the new name; the edit row is gone.
    await expect(card.locator('.directory-name')).toHaveText(uiName, { timeout: 10_000 })
    await expect(page.locator('.toast.ok')).toContainText(/目录已更新/)
  })

  // ─── UC-DIR-03: 编辑 settings (missing UI — ⚠️ partial) ─────────────────

  test.fixme('UC-DIR-03 (settings): UI to manage quota / default agent is missing', async ({
    page,
  }) => {
    // Gap (gap-analysis §3, row UC-DIR-03): the gateway PATCH /:id supports
    // `settings` (quota / defaultAgentId / etc. — architecture §3.1), and the
    // contract half is verified in the name test above. BUT DirectoriesView
    // has no UI for managing settings: the edit row only exposes a name input
    // (directories-view.tsx `startEdit`/`saveEdit` only touch `editName`).
    //
    // When a settings editor lands (quota input + default-agent picker inside
    // the edit row, or a dedicated settings drawer), activate this test:
    //   1. open the edit row for `editDirId`
    //   2. set quota + pick a default agent
    //   3. save → assert PATCH fires with { settings: {...} }
    //   4. reload → assert the persisted settings render
    await page.goto('/directories')
    const card = page.locator('.directory-card').filter({ hasText: `E2E-Edit-UI-${SUITE_TAG}` })
    await card.getByRole('button', { name: '编辑' }).click()
    // Expect a settings field that does not exist today.
    await expect(card.locator('[data-field="quota"]')).toBeVisible()
  })

  // ─── UC-DIR-04: 删除目录(级联) ─────────────────────────────────────────

  test('UC-DIR-04: delete via confirm modal + DELETE /api/directories/:id contract + cascade', async ({
    page,
    request,
  }) => {
    // UI: open the delete modal, confirm, assert the card disappears.
    const deleteName = `E2E-Delete-${SUITE_TAG}`
    await page.goto('/directories')
    await expect(page.getByRole('heading', { name: '项目目录' })).toBeVisible({ timeout: 10_000 })
    const card = page.locator('.directory-card').filter({ hasText: deleteName })
    await expect(card).toBeVisible({ timeout: 10_000 })

    await card.getByRole('button', { name: '删除' }).click()
    // The confirm dialog is a role=alertdialog titled 「删除目录」.
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('删除目录')
    await expect(dialog).toContainText(deleteName)
    await page.getByRole('button', { name: '确认删除' }).click()

    // The card is gone and a success toast names the deleted directory.
    await expect(card).toHaveCount(0, { timeout: 10_000 })
    await expect(page.locator('.toast.ok')).toContainText(deleteName)

    // API contract: DELETE a separate directory and verify the envelope shape.
    const delRes = await request.delete(`/api/directories/${cascadeDirId}`)
    expect(delRes.ok(), `DELETE should be 2xx, got ${delRes.status()}`).toBe(true)
    const delBody = (await delRes.json()) as DirDeleteEnvelope
    expect(delBody.success).toBe(true)
    expect(delBody.data).toMatchObject({ deleted: true, id: cascadeDirId })

    // Cascade: chats.directory_id ON DELETE CASCADE must drop the child chat.
    // Verify via the chats API (filtering by the now-gone directory returns []).
    const chatsRes = await request.get(`/api/chats?directory_id=${cascadeDirId}`)
    expect(chatsRes.ok()).toBe(true)
    const chatsBody = (await chatsRes.json()) as ChatListEnvelope
    expect(chatsBody.data?.items ?? []).toEqual([])
    // Belt-and-braces: the chat row is gone at the DB layer too.
    const { records } = await ctx.db.runQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM chats WHERE id = $1::uuid`,
      [cascadeChatId],
    )
    expect(Number(records[0]?.count ?? 0)).toBe(0)
  })

  // ─── UC-DIR-05: 查看目录下对话列表 ─────────────────────────────────────

  test('UC-DIR-05: chats grouped by directory in sidebar + GET /api/chats?directory_id contract', async ({
    page,
    request,
  }) => {
    // API contract: GET /api/chats?directory_id=:id returns the seeded chats.
    const res = await request.get(`/api/chats?directory_id=${chatsDirId}`)
    expect(res.ok(), `GET /api/chats should be 2xx, got ${res.status()}`).toBe(true)
    const body = (await res.json()) as ChatListEnvelope
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data?.items)).toBe(true)
    const ids = new Set(body.data?.items?.map((c) => c.id))
    for (const chatId of chatIdsUnderChatsDir) {
      expect(ids.has(chatId), `chat ${chatId} should be listed under its directory`).toBe(true)
    }
    // Each item carries the directoryId binding (the “under this directory” shape).
    for (const item of body.data?.items ?? []) {
      expect(item.directoryId).toBe(chatsDirId)
      expect(typeof item.title).toBe('string')
    }

    // UI: the chat sidebar (chat-nav-sidebar.tsx) groups chats by directory.
    // Navigating to '/' renders ChatLayout with the sidebar; the seeded
    // directory's group header shows the directory name + chat count, and
    // expanding it lists the chat titles.
    await page.goto('/')
    const sidebar = page.locator('.chat-nav-sidebar')
    await expect(sidebar).toBeVisible({ timeout: 10_000 })

    const dirName = `E2E-Chats-${SUITE_TAG}`
    const group = sidebar.locator('.chat-nav-dir-group').filter({ hasText: dirName })
    await expect(group).toBeVisible({ timeout: 10_000 })
    // The header carries the live chat count for this directory.
    await expect(group.locator('.chat-nav-dir-count')).toHaveText(String(chatIdsUnderChatsDir.length))

    // The group may start collapsed (only the first directory auto-expands);
    // click the header to expand, then assert both chat titles render.
    await group.locator('.chat-nav-dir-header').click()
    for (const title of [`E2E-Chat-A-${SUITE_TAG}`, `E2E-Chat-B-${SUITE_TAG}`]) {
      await expect(group.locator('.chat-nav-chat-item').filter({ hasText: title })).toBeVisible({
        timeout: 10_000,
      })
    }
  })
})
