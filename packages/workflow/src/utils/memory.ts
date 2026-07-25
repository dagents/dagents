/**
 * Memory manager — stub for Plan A.
 *
 * Real LLM/Agent memory management (chat history, buffer window, summary)
 * is in Plan B. For now, this provides a simple in-memory store so nodes
 * that reference memory don't crash.
 */

export interface MemoryEntry {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

export class MemoryManager {
  private readonly entries: MemoryEntry[] = []

  add(role: MemoryEntry['role'], content: string): void {
    this.entries.push({ role, content, timestamp: new Date().toISOString() })
  }

  getHistory(): MemoryEntry[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries.length = 0
  }
}
