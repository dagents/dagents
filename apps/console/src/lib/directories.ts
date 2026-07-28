export interface Directory {
  id: string
  path: string
  name: string
  settings: Record<string, unknown>
  chatCount?: number
  createdAt: string
  updatedAt: string
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${label} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success || body.data === undefined) {
    throw new Error(`${label} failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data
}

export async function fetchDirectories(signal?: AbortSignal): Promise<Directory[]> {
  const data = await unwrap<{ items: Directory[] }>(
    await fetch('/api/directories', { cache: 'no-store', signal }),
    'directory list',
  )
  return data.items
}

/**
 * Open the OS-native directory picker (gateway spawns osascript / zenity /
 * PowerShell) and resolve with the chosen absolute path, or null if the
 * user cancelled. The browser cannot read absolute paths itself, so this
 * proxies to the locally-running gateway which has filesystem access.
 */
export async function pickDirectory(): Promise<string | null> {
  const data = await unwrap<{ path: string | null }>(
    await fetch('/api/directories/pick', { cache: 'no-store' }),
    'directory pick',
  )
  return data.path
}

export async function fetchDirectory(id: string, signal?: AbortSignal): Promise<Directory> {
  const data = await unwrap<{ directory: Directory }>(
    await fetch(`/api/directories/${encodeURIComponent(id)}`, { cache: 'no-store', signal }),
    'directory detail',
  )
  return data.directory
}

export async function createDirectory(body: {
  path: string
  name?: string
  settings?: Record<string, unknown>
}): Promise<Directory> {
  const data = await unwrap<{ directory: Directory }>(
    await fetch('/api/directories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'create directory',
  )
  return data.directory
}

export async function updateDirectory(
  id: string,
  body: { name?: string; settings?: Record<string, unknown> },
): Promise<Directory> {
  const data = await unwrap<{ directory: Directory }>(
    await fetch(`/api/directories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'update directory',
  )
  return data.directory
}

export async function deleteDirectory(id: string): Promise<{ deleted: boolean; id: string }> {
  return unwrap<{ deleted: boolean; id: string }>(
    await fetch(`/api/directories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
    'delete directory',
  )
}
