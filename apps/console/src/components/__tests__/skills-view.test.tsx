/**
 * SkillsView fidelity tests — the 技能库 page over the runtime registry.
 *
 * Pins the registry-not-database contract end to end on the client side:
 * the list renders summaries only (name/description/source, no bodies),
 * search + source chips filter client-side, and expanding a row lazily
 * fetches the full SKILL.md body from /api/skills/:name.
 *
 * `/api/skills*` is stubbed via `globalThis.fetch` (settings-test pattern)
 * so the suite runs without a gateway.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SkillsView } from '@/components/skills-view'

const CATALOG_FIXTURE = {
  success: true,
  data: {
    skills: [
      {
        name: 'agent-reach',
        description: 'Give your agent eyes on 17 platforms.',
        source: 'user-agents',
      },
      {
        name: 'gstack',
        description: 'Fast headless browser for QA testing.',
        source: 'user-agents',
      },
      {
        name: 'team-skill',
        description: 'A custom-root override.',
        source: 'custom',
      },
    ],
    roots: [
      { source: 'custom', dir: '/opt/team-skills', rank: 300 },
      { source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 },
    ],
  },
}

const DETAIL_FIXTURE = {
  success: true,
  data: {
    name: 'agent-reach',
    description: 'Give your agent eyes on 17 platforms.',
    source: 'user-agents',
    content: '# Agent Reach\n\nUse the routing table in SKILL.md.\n',
    dir: '/Users/tester/.agents/skills/agent-reach',
    metadata: { triggers: ['search'] },
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    if (url.pathname === '/api/skills') return jsonResponse(CATALOG_FIXTURE)
    if (url.pathname === '/api/skills/agent-reach') return jsonResponse(DETAIL_FIXTURE)
    return jsonResponse({ success: false, error: 'not found' }, 404)
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('SkillsView', () => {
  it('renders the catalog: summaries only, source badges, count, roots footer', async () => {
    render(<SkillsView />)

    await waitFor(() => {
      expect(screen.getByText('agent-reach')).toBeTruthy()
    })
    expect(screen.getByText('gstack')).toBeTruthy()
    expect(screen.getByText('team-skill')).toBeTruthy()
    // Source labels, not raw source keys (badges + the filter chips share text).
    expect(screen.getAllByText('本机 ~/.agents').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText('自定义目录').length).toBeGreaterThanOrEqual(2)
    // Count reflects the whole catalog before filtering.
    expect(screen.getByText('3 / 3 个技能')).toBeTruthy()
    // Discovery roots footer.
    expect(screen.getByText(/\/opt\/team-skills/)).toBeTruthy()
    expect(screen.getByText(/\/Users\/tester\/\.agents\/skills/)).toBeTruthy()
    // No body content leaks into the collapsed list.
    expect(screen.queryByText(/routing table/)).toBeNull()
  })

  it('filters by search query client-side', async () => {
    render(<SkillsView />)
    await waitFor(() => {
      expect(screen.getByText('gstack')).toBeTruthy()
    })

    fireEvent.change(screen.getByLabelText('搜索技能'), { target: { value: 'browser' } })
    expect(screen.getByText('gstack')).toBeTruthy()
    expect(screen.queryByText('agent-reach')).toBeNull()
    expect(screen.getByText('1 / 3 个技能')).toBeTruthy()
  })

  it('filters by source chip', async () => {
    render(<SkillsView />)
    await waitFor(() => {
      expect(screen.getByText('team-skill')).toBeTruthy()
    })

    // The chip is the BUTTON carrying the label (the row badge shares its text).
    const customChip = screen
      .getAllByText('自定义目录')
      .find((el) => el.tagName === 'BUTTON')
    expect(customChip).toBeDefined()
    fireEvent.click(customChip as HTMLElement)
    expect(screen.getByText('team-skill')).toBeTruthy()
    expect(screen.queryByText('gstack')).toBeNull()
    expect(screen.getByText('1 / 3 个技能')).toBeTruthy()
  })

  it('expands a row and lazily fetches the full body', async () => {
    render(<SkillsView />)
    await waitFor(() => {
      expect(screen.getByText('agent-reach')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('agent-reach'))
    await waitFor(() => {
      expect(screen.getByText(/Use the routing table/)).toBeTruthy()
    })
    // Resource dir (resourceBase) is shown alongside the body.
    expect(screen.getByText(/\/Users\/tester\/\.agents\/skills\/agent-reach/)).toBeTruthy()
    // The detail explains how to remove a single skill (filesystem is truth).
    expect(screen.getByText(/删除此技能 = 删除磁盘上的该目录/)).toBeTruthy()
  })

  it('auto-refreshes the catalog when an expanded row 404s (stale TTL entry)', async () => {
    let catalogCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
      if (url.pathname === '/api/skills') {
        catalogCalls++
        // First load: stale cache still lists ghost-skill. Refresh after 404: gone.
        return jsonResponse(
          catalogCalls === 1
            ? {
                success: true,
                data: {
                  skills: [{ name: 'ghost-skill', description: 'Stale entry.', source: 'custom' }],
                  roots: [
                    { source: 'custom', dir: '/opt/gone', rank: 400, removable: true },
                    { source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 },
                  ],
                },
              }
            : {
                success: true,
                data: {
                  skills: [],
                  roots: [{ source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 }],
                },
              },
        )
      }
      if (url.pathname === '/api/skills/ghost-skill') {
        return jsonResponse({ success: false, error: 'skill not found: ghost-skill' }, 404)
      }
      return jsonResponse({ success: false, error: 'not found' }, 404)
    }) as typeof globalThis.fetch

    render(<SkillsView />)
    await waitFor(() => {
      expect(screen.getByText('ghost-skill')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('ghost-skill'))
    // The 404 triggers a catalog refresh — the stale row disappears (the
    // transient "已自动刷新" message lives inside that row, so the observable
    // end state is: re-fetch happened + row gone + plain empty state).
    await waitFor(() => {
      expect(catalogCalls).toBe(2)
    })
    await waitFor(() => {
      expect(screen.queryByText('ghost-skill')).toBeNull()
    })
  })

  it('shows an empty-state pointing at the runtime roots when nothing is found', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ success: true, data: { skills: [], roots: [] } })) as typeof globalThis.fetch
    render(<SkillsView />)

    await waitFor(() => {
      expect(screen.getByText('没有发现技能')).toBeTruthy()
    })
    expect(screen.getByText(/~\/\.agents\/skills/)).toBeTruthy()
  })

  it('lets the user type a custom dir and load its skills directly', async () => {
    const ADDED_CATALOG = {
      success: true,
      data: {
        skills: [
          { name: 'agent-reach', description: 'Local only.', source: 'user-agents' },
          { name: 'my-skill', description: 'From the added dir.', source: 'custom' },
        ],
        roots: [
          { source: 'custom', dir: '/tmp/my-skills', rank: 400, removable: true },
          { source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 },
        ],
      },
    }
    const fetchCalls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
      fetchCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname === '/api/skills') {
        return jsonResponse({
          success: true,
          data: {
            skills: [{ name: 'agent-reach', description: 'Local only.', source: 'user-agents' }],
            roots: [{ source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 }],
          },
        })
      }
      if (url.pathname === '/api/skills/roots' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ dir: '/tmp/my-skills' })
        return jsonResponse(ADDED_CATALOG)
      }
      return jsonResponse({ success: false, error: 'not found' }, 404)
    }) as typeof globalThis.fetch

    render(<SkillsView />)
    await waitFor(() => {
      expect(screen.getByText('agent-reach')).toBeTruthy()
    })

    const customChip = screen
      .getAllByText('自定义目录')
      .find((el) => el.tagName === 'BUTTON')
    fireEvent.click(customChip as HTMLElement)

    // The dead end is now a direct input.
    await waitFor(() => {
      expect(screen.getByText('添加自定义技能目录')).toBeTruthy()
    })
    fireEvent.change(screen.getByLabelText('自定义技能目录路径'), {
      target: { value: '/tmp/my-skills' },
    })
    fireEvent.click(screen.getByRole('button', { name: '加载技能' }))

    // One round trip: the skill from the added dir shows up immediately.
    await waitFor(() => {
      expect(screen.getByText('my-skill')).toBeTruthy()
    })
    expect(fetchCalls).toContain('POST /api/skills/roots')
    expect(screen.queryByText('添加自定义技能目录')).toBeNull()
  })

  it('surfaces gateway validation errors inline when the dir is invalid', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
      if (url.pathname === '/api/skills') {
        return jsonResponse({
          success: true,
          data: {
            skills: [{ name: 'agent-reach', description: 'Local only.', source: 'user-agents' }],
            roots: [{ source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 }],
          },
        })
      }
      if (url.pathname === '/api/skills/roots' && init?.method === 'POST') {
        return jsonResponse({ success: false, error: '目录不存在或不可读：/nope' }, 400)
      }
      return jsonResponse({ success: false, error: 'not found' }, 404)
    }) as typeof globalThis.fetch

    render(<SkillsView />)
    await waitFor(() => {
      expect(screen.getByText('agent-reach')).toBeTruthy()
    })
    const customChip = screen
      .getAllByText('自定义目录')
      .find((el) => el.tagName === 'BUTTON')
    fireEvent.click(customChip as HTMLElement)

    fireEvent.change(screen.getByLabelText('自定义技能目录路径'), {
      target: { value: '/nope' },
    })
    fireEvent.click(screen.getByRole('button', { name: '加载技能' }))
    await waitFor(() => {
      expect(screen.getByText(/目录不存在或不可读/)).toBeTruthy()
    })
  })

  it('removes a removable custom root from the footer', async () => {
    const INITIAL = {
      success: true,
      data: {
        skills: [
          { name: 'agent-reach', description: 'Local only.', source: 'user-agents' },
          { name: 'team-skill', description: 'UI-managed.', source: 'custom' },
        ],
        roots: [
          { source: 'custom', dir: '/opt/team-skills', rank: 400, removable: true },
          { source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 },
        ],
      },
    }
    const AFTER_REMOVE = {
      success: true,
      data: {
        skills: [{ name: 'agent-reach', description: 'Local only.', source: 'user-agents' }],
        roots: [{ source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 }],
      },
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
      if (url.pathname === '/api/skills') return jsonResponse(INITIAL)
      if (url.pathname === '/api/skills/roots' && init?.method === 'DELETE') {
        expect(url.searchParams.get('dir')).toBe('/opt/team-skills')
        return jsonResponse(AFTER_REMOVE)
      }
      return jsonResponse({ success: false, error: 'not found' }, 404)
    }) as typeof globalThis.fetch

    render(<SkillsView />)
    await waitFor(() => {
      expect(screen.getByText('team-skill')).toBeTruthy()
    })

    const removeBtn = screen.getByRole('button', { name: /移除目录 \/opt\/team-skills/ })
    // Two-step confirm: first click arms (确认？), second click deletes.
    fireEvent.click(removeBtn)
    expect(screen.getByText('确认？')).toBeTruthy()
    fireEvent.click(removeBtn)
    await waitFor(() => {
      expect(screen.queryByText('team-skill')).toBeNull()
    })
    expect(screen.getByText('agent-reach')).toBeTruthy()
    // Removed root disappears from the footer too.
    expect(screen.queryByText(/\/opt\/team-skills/)).toBeNull()
  })

  it('keeps the plain empty-state (with root hint) when custom roots exist but scan nothing', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        success: true,
        data: {
          skills: [{ name: 'agent-reach', description: 'Local only.', source: 'user-agents' }],
          roots: [
            { source: 'custom', dir: '/opt/empty-team-skills', rank: 300 },
            { source: 'user-agents', dir: '/Users/tester/.agents/skills', rank: 500 },
          ],
        },
      })) as typeof globalThis.fetch
    render(<SkillsView />)
    await waitFor(() => {
      expect(screen.getByText('agent-reach')).toBeTruthy()
    })

    const customChip = screen
      .getAllByText('自定义目录')
      .find((el) => el.tagName === 'BUTTON')
    fireEvent.click(customChip as HTMLElement)

    expect(screen.getByText('没有匹配的技能')).toBeTruthy()
    // Path shows up both in the empty-state hint and the discovery footer.
    expect(screen.getAllByText(/\/opt\/empty-team-skills/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('添加自定义技能目录')).toBeNull()
  })
})
