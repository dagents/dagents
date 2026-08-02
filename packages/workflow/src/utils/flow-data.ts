/**
 * FlowData runtime parser + validator.
 *
 * Mirrors React Flow's node/edge shape so flow_data JSON round-trips safely.
 * Kept in @dagents/workflow so both gateway and console can share one canonical
 * parser instead of re-declaring schemas.
 */

import { z } from 'zod'
import type { FlowData } from '../types/flow.js'

const flowDataNodeSchema = z.object({
  id: z.string(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  type: z.string().optional(),
  data: z
    .object({
      label: z.string().optional(),
    })
    .passthrough()
    .default({}),
})

const flowDataEdgeSchema = z
  .object({
    id: z.string().optional(),
    source: z.string(),
    target: z.string(),
    sourceHandle: z.string().nullish(),
    targetHandle: z.string().nullish(),
    type: z.string().optional(),
    label: z.string().optional(),
    data: z.object({ label: z.string().optional() }).optional(),
  })
  .transform((edge) => ({
    ...edge,
    id: edge.id ?? `${edge.source}-${edge.target}`,
  }))

export const flowDataSchema = z.object({
  nodes: z.array(flowDataNodeSchema).default([]),
  edges: z.array(flowDataEdgeSchema).default([]),
  viewport: z
    .object({ x: z.number(), y: z.number(), zoom: z.number() })
    .optional(),
})

/**
 * Parse a flow's `flowData` JSON string into the React Flow object.
 * Returns an empty DAG on missing/malformed/non-object input so callers can
 * degrade gracefully instead of throwing.
 */
export function parseFlowData(flowData: string | undefined | null): FlowData {
  if (!flowData) return { nodes: [], edges: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(flowData)
  } catch {
    return { nodes: [], edges: [] }
  }
  const result = flowDataSchema.safeParse(parsed)
  if (!result.success) return { nodes: [], edges: [] }
  return result.data
}
