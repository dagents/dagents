import { Hono } from 'hono'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { createLogger } from '@dagents/shared'
import {
  listDirectoriesWithCounts,
  getDirectoryById,
  createDirectory,
  updateDirectoryFields,
  deleteDirectory,
  normalizeDir,
  type DirectoryRow,
} from '../repositories/directories.repo.js'
import { ok, fail } from '../lib/http.js'
import { UUID_RE } from '../lib/http.js'

export const directoryRoutes = new Hono()

const log = createLogger({ svc: 'gateway:directories' })


/**
 * Spawn a native OS directory picker and resolve with the chosen absolute
 * path (or null if the user cancelled). Used by the console's chat composer
 * DirectorySelector — the browser cannot read absolute paths via
 * `showDirectoryPicker()` (web security boundary), but the gateway runs
 * locally on the user's machine, so it can shell out to the OS's native
 * dialog and return the real path.
 *
 * Per-platform:
 *   - darwin : `osascript -e 'choose folder'` → "alias macOS:Users:<name>:…"
 *   - linux  : `zenity --file-selection --directory` (GTK; widely available)
 *   - win32  : PowerShell + Windows.Forms.FolderBrowserDialog
 *
 * The picked path is validated to be absolute + exist on disk before return.
 */
function pickDirectoryNative(): Promise<string | null> {
  const os = platform()
  return new Promise((resolve) => {
    let cmd: string
    let args: string[]
    let parse: (stdout: string) => string | null

    if (os === 'darwin') {
      // Use `choose folder` from Standard Additions (no `tell application`
      // needed — avoids "permission violation" errors when the frontmost
      // app doesn't support Apple Events). `POSIX path of` converts the
      // HFS alias to a POSIX path directly, eliminating manual parsing.
      cmd = 'osascript'
      args = ['-e', 'POSIX path of (choose folder with prompt "选择项目目录")']
      parse = (out) => {
        const p = out.trim()
        return p || null
      }
    } else if (os === 'win32') {
      // PowerShell FolderBrowserDialog writes the selected path to stdout.
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Select project directory'
        $dlg.ShowNewFolderButton = $false
        if ($dlg.ShowDialog() -eq 'OK') { Write-Output $dlg.SelectedPath }
      `.replace(/\n/g, ' ')
      cmd = 'powershell'
      args = ['-NoProfile', '-NonInteractive', '-Command', ps]
      parse = (out) => {
        const p = out.trim()
        return p || null
      }
    } else {
      // Linux / other: zenity is the de-facto GTK dialog. If absent, fail
      // gracefully — the caller surfaces the error to the UI.
      cmd = 'zenity'
      args = ['--file-selection', '--directory', '--title=选择项目目录']
      parse = (out) => {
        const p = out.trim()
        return p || null
      }
    }

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      log.warn('native directory picker spawn failed', {
        os,
        cmd,
        error: String(err),
      })
      resolve(null)
    })
    child.on('close', (code) => {
      // Exit code 1 typically means user cancelled (osascript / zenity).
      if (code !== 0) {
        log.debug('native directory picker exited non-zero', {
          os,
          code,
          stderr: stderr.slice(0, 200),
        })
        resolve(null)
        return
      }
      const path = parse(stdout)
      resolve(path)
    })
  })
}

/** Validate that a path is absolute and exists. Used by /pick before
 *  returning the path to the client, so the client never sees a bogus path. */
async function pathExists(p: string): Promise<boolean> {
  try {
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(p)
    return stat.isDirectory()
  } catch {
    return false
  }
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

const createBodySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => !p.includes('..'), 'path must not contain ".." (path traversal blocked)')
    .refine((p) => !p.includes('\x00'), 'path must not contain null bytes'),
  name: z.string().min(1).max(256).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

const updateBodySchema = z.object({
  name: z.string().min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

directoryRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  let rows: DirectoryRow[]
  try {
    rows = await listDirectoriesWithCounts(q.limit)
  } catch (err) {
    log.error('directory list query failed', { error: String(err) })
    return fail(c, 502, 'directory list failed')
  }

  return ok(c, {
    items: rows.map((r) => normalizeDir(r)),
  })
})

/**
 * GET /pick — open the OS-native directory picker and return the chosen
 * absolute path. Resolves with `{ path: null }` when the user cancels.
 *
 * This bypasses the browser's absolute-path restriction by running the
 * picker on the gateway (which is a local process on the user's machine,
 * not a remote server). The console's DirectorySelector calls this and
 * then POSTs the returned path to create a directory record.
 *
 * No auth on this route beyond the gateway's standard session check — it
 * only returns a path string, never reads directory contents.
 */
directoryRoutes.get('/pick', async (c) => {
  let path: string | null
  try {
    path = await pickDirectoryNative()
  } catch (err) {
    log.warn('native directory picker threw', { error: String(err) })
    return fail(c, 502, 'directory picker failed', { detail: String(err) })
  }
  if (!path) {
    // User cancelled or picker unavailable. 200 with null path so the
    // client can distinguish "cancelled" from "picker broken".
    return ok(c, { path: null })
  }
  // Validate the path actually exists on disk before returning — guards
  // against any parser quirks across OS versions.
  const exists = await pathExists(path)
  if (!exists) {
    log.warn('picker returned non-existent path', { path })
    return fail(c, 500, 'picked path does not exist', { path })
  }
  return ok(c, { path })
})

directoryRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid directory id', { id })
  }

  let row: DirectoryRow | null
  try {
    row = await getDirectoryById(id)
  } catch (err) {
    log.error('directory detail query failed', { id, error: String(err) })
    return fail(c, 502, 'directory detail failed')
  }
  if (!row) {
    return fail(c, 404, 'directory not found', { id })
  }

  return ok(c, { directory: normalizeDir(row) })
})

directoryRoutes.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data
  const name = data.name ?? data.path.split('/').filter(Boolean).pop() ?? data.path

  let row: DirectoryRow | null
  try {
    row = await createDirectory({
      path: data.path,
      name,
      settingsJson: JSON.stringify(data.settings ?? {}),
    })
  } catch (err) {
    log.error('directory create failed', { error: String(err) })
    return fail(c, 502, 'directory create failed')
  }
  if (!row) {
    return fail(c, 502, 'directory create failed')
  }

  return ok(c, { directory: normalizeDir(row) })
})

directoryRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid directory id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = updateBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  const hasUpdates = data.name !== undefined || data.settings !== undefined

  if (!hasUpdates) {
    let existing: DirectoryRow | null
    try {
      existing = await getDirectoryById(id)
    } catch (err) {
      log.error('directory detail query failed', { id, error: String(err) })
      return fail(c, 502, 'directory update failed')
    }
    if (!existing) {
      return fail(c, 404, 'directory not found', { id })
    }
    return ok(c, { directory: normalizeDir(existing) })
  }

  let row: DirectoryRow | null
  try {
    row = await updateDirectoryFields(id, {
      name: data.name,
      settingsJson: data.settings !== undefined ? JSON.stringify(data.settings) : undefined,
    })
  } catch (err) {
    log.error('directory update failed', { id, error: String(err) })
    return fail(c, 502, 'directory update failed')
  }
  if (!row) {
    return fail(c, 404, 'directory not found', { id })
  }

  return ok(c, { directory: normalizeDir(row) })
})

directoryRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid directory id', { id })
  }

  let deletedId: string | null
  try {
    deletedId = await deleteDirectory(id)
  } catch (err) {
    log.error('directory delete failed', { id, error: String(err) })
    return fail(c, 502, 'directory delete failed')
  }
  if (!deletedId) {
    return fail(c, 404, 'directory not found', { id })
  }

  return ok(c, { deleted: true, id: deletedId })
})
