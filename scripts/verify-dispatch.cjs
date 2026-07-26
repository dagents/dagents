// Manual curl-equivalent verification of all dispatch endpoints (M2.2 验收).
// Runs against the locally-started dispatch server on :8081.
const B = 'http://localhost:8081/api/v1/dispatch'
const code = async (r) => `${r.status} ${r.ok ? 'OK' : ''}`

async function main() {
  // 1. register a daemon
  const reg = await fetch(`${B}/daemons/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ daemonLabel: 'curl-daemon', capabilities: [{ agentType: 'claude', tags: ['gpu'] }] }),
  })
  const regBody = await reg.json()
  console.log('1. register ->', reg.status, JSON.stringify(regBody))
  const daemonId = regBody.data.daemonId

  // 2. seed an agent_daemon via psql (FK target for invoke) — using docker exec
  const { execSync } = require('node:child_process')
  const adId = execSync(
    `docker exec dagents-postgres-1 psql -qAt -U dagents -d dagents -c "INSERT INTO agent_daemons (name, kind, daemon_id, executable_path) VALUES ('claude-code','claude','${daemonId}','claude') RETURNING id"`,
  ).toString().split(/\r?\n/)[0].trim()
  console.log('2. seed agent_daemon ->', adId)

  // 3. invoke x2
  const inv1 = await fetch(`${B}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentDaemonId: adId, runId: 'run-curl-1', prompt: 'hello', execOptions: { model: 'claude' } }),
  })
  const inv1Body = await inv1.json()
  const task1 = inv1Body.data.taskId
  console.log('3a. invoke ->', inv1.status, JSON.stringify(inv1Body))
  const inv2 = await fetch(`${B}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentDaemonId: adId, runId: 'run-curl-2', prompt: 'world', execOptions: {} }),
  })
  const task2 = (await inv2.json()).data.taskId
  console.log('3b. invoke ->', inv2.status, 'task2=', task2)

  // 4. claim (FIFO -> task1)
  const cl1 = await fetch(`${B}/daemons/${daemonId}/tasks/claim`, { method: 'POST' })
  console.log('4. claim#1 ->', cl1.status, JSON.stringify(await cl1.json()))
  // 5. claim -> task2
  const cl2 = await fetch(`${B}/daemons/${daemonId}/tasks/claim`, { method: 'POST' })
  console.log('5. claim#2 ->', cl2.status, JSON.stringify(await cl2.json()))
  // 6. claim -> null
  const cl3 = await fetch(`${B}/daemons/${daemonId}/tasks/claim`, { method: 'POST' })
  console.log('6. claim#3 (empty) ->', cl3.status, JSON.stringify(await cl3.json()))

  // 7. heartbeat
  const hb = await fetch(`${B}/daemons/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ daemonId, status: 'draining', activeTasks: 1 }),
  })
  console.log('7. heartbeat ->', await code(hb))

  // 8. start
  const st = await fetch(`${B}/tasks/${task1}/start`, { method: 'POST' })
  console.log('8. start ->', await code(st))
  // 9. progress
  const pg = await fetch(`${B}/tasks/${task1}/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary: 'working', step: 1, total: 3 }),
  })
  console.log('9. progress ->', await code(pg))
  // 10. messages (batch 2)
  const ms = await fetch(`${B}/tasks/${task1}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }] }),
  })
  console.log('10. messages ->', await code(ms))
  // 11. complete
  const cp = await fetch(`${B}/tasks/${task1}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ output: 'done', sessionId: 'sess-1', usage: { claude: { inputTokens: 10, outputTokens: 5 } }, durationMs: 1234 }),
  })
  console.log('11. complete ->', await code(cp))
  // 12. double-complete -> 409
  const cp2 = await fetch(`${B}/tasks/${task1}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ output: 'again', usage: {}, durationMs: 1 }),
  })
  console.log('12. double-complete ->', await code(cp2))
  // 13. fail task2
  const fl = await fetch(`${B}/tasks/${task2}/fail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'boom', failureReason: 'timeout' }),
  })
  console.log('13. fail ->', await code(fl))
  // 14. start unknown -> 404
  const st404 = await fetch(`${B}/tasks/00000000-0000-4000-8000-000000000000/start`, { method: 'POST' })
  console.log('14. start unknown ->', await code(st404))
  // 15. invalid invoke -> 400
  const bad = await fetch(`${B}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentDaemonId: 'not-a-uuid', runId: 'r', prompt: 'p' }),
  })
  console.log('15. invalid invoke ->', await code(bad))
  // 16. deregister
  const dl = await fetch(`${B}/daemons/${daemonId}`, { method: 'DELETE' })
  console.log('16. deregister ->', await code(dl))

  // DB state
  const tasks = execSync(`docker exec dagents-postgres-1 psql -U dagents -d dagents -c "SELECT id, status, session_id, duration_ms, result->>'output' AS out, failure_reason FROM dispatch_tasks ORDER BY created_at;"`).toString()
  console.log('\n=== dispatch_tasks ===\n' + tasks)
  const events = execSync(`docker exec dagents-postgres-1 psql -U dagents -d dagents -c "SELECT task_id, kind, seq, payload->>'summary' AS s, payload->>'content' AS c FROM dispatch_task_events ORDER BY seq;"`).toString()
  console.log('=== dispatch_task_events ===\n' + events)
}
main().catch((e) => { console.error('ERR', e); process.exit(1) })
