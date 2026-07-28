import type {
  PredictionClient,
  PredictionRequest,
  PredictionResult,
  PredictionClientOpts,
} from './prediction-client.js'
import { PredictionError } from './prediction-client.js'

/**
 * Client for the internal Workflow Engine API, reached through the gateway.
 *
 * The gateway exposes `/api/v1/workflows/<id>/run` which delegates to the
 * `@dagents/workflow` engine. This client implements the `PredictionClient`
 * interface so the scheduler can transparently use the workflow engine backend
 * without changes to fan-out / worker logic.
 *
 * Request shape: the workflow engine expects `{ input, chatId, state }`
 * instead of a free-form body. The client adapts the incoming
 * `PredictionRequest.body` (which is the same shape callers already build)
 * into the workflow payload.
 *
 * Response shape is normalized back into `PredictionResult`: `data.output`
 * becomes `output`. Duration and run-id follow the same conventions.
 */
export function createWorkflowPredictionClient(
  opts: PredictionClientOpts,
): PredictionClient {
  const gatewayUrl = opts.gatewayUrl.replace(/\/$/, '')

  return {
    predict: async (req: PredictionRequest, runId: string): Promise<PredictionResult> => {
      const urlPath = `/api/v1/workflows/${encodeURIComponent(req.flowId)}/run`

      const body = req.body as Record<string, unknown> | undefined
      const payload = {
        input: body?.input ?? body ?? {},
        chatId: body?.chatId ?? runId,
        state: body?.state ?? {},
      }

      const start = Date.now()
      let res: Response
      try {
        res = await fetch(`${gatewayUrl}${urlPath}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-run-id': runId,
            ...(opts.authorization ? { authorization: opts.authorization } : {}),
          },
          body: JSON.stringify(payload),
        })
      } catch (err) {
        throw new PredictionError(runId, 502, `workflow prediction transport failure: ${String(err)}`)
      }

      const durationMs = Date.now() - start

      if (!res.ok) {
        throw new PredictionError(runId, res.status, `workflow prediction failed: ${res.status}`)
      }

      const clone = res.clone()
      let output: unknown
      try {
        const json = await res.json()
        output = (json as { data?: { output?: unknown } }).data?.output ?? json
      } catch {
        output = { raw: await clone.text() }
      }

      return { runId, output, durationMs }
    },
  }
}
