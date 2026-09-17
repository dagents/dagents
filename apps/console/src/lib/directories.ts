
import { apiFetch } from '@/lib/api'


export interface Directory {
  id: string
  path: string
  name: string
  settings: Record<string, unknown>
  chatCount?: number
  createdAt: string
  updatedAt: string
}


export async function fetchDirectories(signal?: AbortSignal): Promise<Directory[]> {
  const data = await apiFetch<{ items: Directory[] }>('/api/directories', { signal }, 'directory list')
  return data.items
}

/**
 * Open the OS-native directory picker (gateway spawns osascript / zenity /
 * PowerShell) and resolve with the chosen absolute path, or null if the
 * user cancelled. The browser cannot read absolute paths itself, so this
 * proxies to the locally-running gateway which has filesystem access.
 */
export async function pickDirectory(): Promise<string | null> {
  const data = await apiFetch<{ path: string | null }>('/api/directories/pick', undefined, 'directory pick')
  return data.path
}

export async function fetchDirectory(id: string, signal?: AbortSignal): Promise<Directory> {
  const data = await apiFetch<{ directory: Directory }>(`/api/directories/${encodeURIComponent(id)}`, { signal }, 'directory detail')
  return data.directory
}

export async function createDirectory(body: {
  path: string
  name?: string
  settings?: Record<string, unknown>
}): Promise<Directory> {
  const data = await apiFetch<{ directory: Directory }>('/api/directories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 'create directory')
  return data.directory
}

export async function updateDirectory(
  id: string,
  body: { name?: string; settings?: Record<string, unknown> },
): Promise<Directory> {
  const data = await apiFetch<{ directory: Directory }>(`/api/directories/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 'update directory')
  return data.directory
}

export async function deleteDirectory(id: string): Promise<{ deleted: boolean; id: string }> {
  return apiFetch<{ deleted: boolean; id: string }>(`/api/directories/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'delete directory')
}
