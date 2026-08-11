/**
 * agent-templates.ts — client fetchers for the Agent Template Library.
 *
 * Mirrors the chats.ts / agents-catalog.ts pattern: typed domain model +
 * `unwrap()` fetchers that throw on non-2xx or a failed envelope. The gallery
 * component imports these to load the static catalogue and to instantiate an
 * agent from a picked template.
 *
 * All requests hit the console's own `/api/agent-templates/*` proxy routes,
 * which forward to the gateway's `/api/v1/agent-templates/*` (no CORS, no
 * origin leak — same posture as the rest of the console's data layer).
 */

/** Template category — drives the gallery's filter tabs. */
export type AgentTemplateCategory = 'popular' | 'coding' | 'specialist'

/**
 * A pre-configured agent template. The first 7 fields (id → executable_path)
 * map 1:1 onto the `agents` table columns the instantiate endpoint writes; the
 * last 3 (description / icon / category) are gallery-display-only.
 */
export interface AgentTemplate {
  id: string
  name: string
  kind: string
  model: string
  instructions: string
  roles: string[]
  skills: string[]
  description: string
  /** Emoji shown as the card avatar. */
  icon: string
  executable_path: string
  category: AgentTemplateCategory
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/** Unwrap the standard `{ success, data }` envelope, throwing on failure. */
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

/** Fetch the full static template catalogue (all categories). */
export async function fetchAgentTemplates(signal?: AbortSignal): Promise<AgentTemplate[]> {
  const data = await unwrap<{ templates: AgentTemplate[] }>(
    await fetch('/api/agent-templates', { cache: 'no-store', signal }),
    'agent templates list',
  )
  return data.templates
}

/**
 * Instantiate an agent from a template.
 *
 * @param templateId The template id to instantiate.
 * @param overrides Optional overrides: `name` to rename the new agent (defaults
 *   to the template's name) and `daemon_id` to bind a daemon immediately
 *   (writes the matching `agent_daemons` bridge row under the shared id).
 * @returns `{ id }` — the new agent's id (for redirect to /agents/:id).
 */
export async function instantiateAgentTemplate(
  templateId: string,
  overrides?: { name?: string; daemon_id?: string },
): Promise<{ id: string }> {
  return unwrap<{ id: string }>(
    await fetch(
      `/api/agent-templates/${encodeURIComponent(templateId)}/instantiate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(overrides ?? {}),
      },
    ),
    'instantiate agent template',
  )
}
