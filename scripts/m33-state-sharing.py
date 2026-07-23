#!/usr/bin/env python3
"""
M3.3 integration verification: programmatically build an agentflow that
writes cross-turn Flow State, then drive two turns against it to prove the
state is recovered from the shared PG `execution` table (not in-process).

The agentflow is intentionally minimal:
  startAgentflow (chatInput, startPersistState=true, declares `user_name` state key)
   -> llmAgentflow (LLM, no memory, system+user messages. Turn 1 stores the
      extracted name into `user_name` via llmUpdateState; Turn 2's user prompt
      is built from `$flow.state.user_name` so the model can ONLY answer if the
      previous turn's state was recovered from PG)
   -> directReplyAgentflow (last node, streams the LLM text back)

Turn 1 question: "My name is Alice"  -> state.user_name = "Alice"
Turn 2 prompt:   "The user's name is {{$flow.state.user_name}}. What is it?"
                 resolves to "The user's name is Alice. What is it?" ONLY if
                 startPersistState recovered the key from PG across turns.

Env:
  FLOWISE_BASE_URL  default http://localhost:3101
  FLOWISE_API_KEY   platform API key (Bearer)
  FLOWISE_CRED_NAME default newapi-openai
  FLOWFLOW_NAME     default M3.3 State Sharing Demo
  SESSION_ID        default m33-session-1
  SECOND_INSTANCE   optional: base URL of a 2nd Flowise instance to send turn 2
                    to (proves cross-instance state sharing via shared PG).
"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE = os.environ.get("FLOWISE_BASE_URL", "http://localhost:3101").rstrip("/")
API_KEY = os.environ.get("FLOWISE_API_KEY", "")
NEWAPI_BASE = os.environ.get("NEWAPI_BASE_URL", "http://localhost:13000/v1")
NEWAPI_TOKEN = os.environ.get("NEWAPI_TOKEN", "")
CRED_NAME = os.environ.get("FLOWISE_CRED_NAME", "newapi-openai")
FLOWFLOW_NAME = os.environ.get("FLOWFLOW_NAME", "M3.3 State Sharing Demo")
SESSION_ID = os.environ.get("SESSION_ID", "m33-session-1")
# Optional 2nd instance: if set, turn 2 is POSTed there instead of BASE. With a
# shared PG + MODE=queue, the same sessionId's execution rows are visible to both
# instances, so state recovery works cross-instance (M3.3 acceptance criterion 1).
SECOND_INSTANCE = os.environ.get("SECOND_INSTANCE", "").rstrip("/")
MODEL = os.environ.get("NEWAPI_MODEL", "glm-5.2")

if not API_KEY:
    print("FATAL: FLOWISE_API_KEY not set", file=sys.stderr)
    sys.exit(2)


def req(method, path, body=None, raw=False, base=None):
    url = (base or BASE) + path
    data = None
    headers = {"Authorization": f"Bearer {API_KEY}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            raw_body = resp.read().decode()
            if raw:
                return resp.status, raw_body
            return resp.status, (json.loads(raw_body) if raw_body else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, str(e)


def find_or_create_credential():
    """Ensure an openAIApi credential named CRED_NAME holds the current NEWAPI_TOKEN.

    Flowise's `openAIApi` credential stores a single `openAIApiKey` that
    ChatOpenAI sends verbatim as `Authorization: Bearer <key>`. PUT on an
    existing credential does not reliably overwrite the stored key (see
    scripts/flowise-m1-setup.py), so delete + create keeps the run
    reproducible. If NEWAPI_TOKEN is unset, fall back to reusing an existing
    credential of the same name (the verification does not need a fresh key).
    """
    status, body = req("GET", "/api/v1/credentials")
    if status != 200:
        print(f"list credentials failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    items = body if isinstance(body, list) else (body.get("data", body) if isinstance(body, dict) else [])
    existing_id = None
    for c in items:
        if c.get("name") == CRED_NAME:
            existing_id = c["id"]
            break
    if not NEWAPI_TOKEN:
        if existing_id:
            print(f"    reusing existing credential {existing_id} (NEWAPI_TOKEN unset)")
            return existing_id
        print("FATAL: NEWAPI_TOKEN not set and no existing credential to reuse", file=sys.stderr)
        sys.exit(2)
    if existing_id:
        req("DELETE", f"/api/v1/credentials/{existing_id}")
        print(f"    deleted stale credential {existing_id}")
    status, body = req("POST", "/api/v1/credentials", {
        "name": CRED_NAME,
        "credentialName": "openAIApi",
        "plainDataObj": {"openAIApiKey": NEWAPI_TOKEN},
    })
    if status != 200:
        print(f"create credential failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    return body["id"]


def build_flow_data(cred_id):
    """Build an AGENTFLOW flowData JSON: Start -> LLM -> DirectReply.

    Start declares a `user_name` Flow State key and has startPersistState=true
    (the M3.3 default-on change). The LLM node writes the user's name into that
    key via llmUpdateState, and DirectReply echoes the LLM text.
    """
    llm_out = "llmAgentflow_0-output-llmAgentflow-LLM"
    direct_out = "directReplyAgentflow_1-output-directReplyAgentflow-DirectReply"

    start = {
        "id": "startAgentflow_0", "type": "customNode",
        "position": {"x": 80, "y": 220}, "width": 300, "height": 530,
        "data": {
            "id": "startAgentflow_0", "label": "Start", "version": 1.4,
            "name": "startAgentflow", "type": "Start",
            "baseClasses": ["Start"], "category": "Agent Flows",
            "description": "Starting point of the agentflow",
            "hideInput": True,
            "inputParams": [
                {"label": "Input Type", "name": "startInputType", "type": "options",
                 "options": [{"label": "Chat Input", "name": "chatInput"}],
                 "default": "chatInput"},
                {"label": "Persist State", "name": "startPersistState", "type": "boolean",
                 "optional": True, "default": True},
            ],
            "inputs": {
                "startInputType": "chatInput",
                "startState": [{"key": "user_name", "value": ""}],
                "startPersistState": True,
            },
            "outputs": {}, "selected": False,
        },
    }

    llm = {
        "id": "llmAgentflow_0", "type": "customNode",
        "position": {"x": 460, "y": 200}, "width": 300, "height": 614,
        "data": {
            "id": "llmAgentflow_0", "label": "LLM", "version": 3,
            "name": "llmAgentflow", "type": "LLM",
            "baseClasses": ["LLM"], "category": "Agent Flows",
            "description": "Large language model node",
            "inputParams": [
                {"label": "Model", "name": "llmModel", "type": "asyncOptions",
                 "loadMethod": "listModels", "loadConfig": True},
                {"label": "Messages", "name": "llmMessages", "type": "array", "optional": True,
                 "acceptVariable": True, "array": [
                     {"label": "Role", "name": "role", "type": "options",
                      "options": [{"label": "System", "name": "system"},
                                  {"label": "User", "name": "user"}]},
                     {"label": "Content", "name": "content", "type": "string",
                      "acceptVariable": True, "rows": 4}]},
                {"label": "Enable Memory", "name": "llmEnableMemory", "type": "boolean",
                 "default": False, "optional": True},
                {"label": "Update Flow State", "name": "llmUpdateState", "type": "array",
                 "optional": True, "acceptVariable": True, "array": [
                     {"label": "Key", "name": "key", "type": "string"},
                     {"label": "Value", "name": "value", "type": "string",
                      "acceptVariable": True, "acceptNodeOutputAsVariable": True}]},
                {"label": "Return Response As", "name": "llmReturnResponseAs", "type": "options",
                 "options": [{"label": "User Message", "name": "userMessage"},
                             {"label": "Assistant Message", "name": "assistantMessage"}],
                 "default": "userMessage"},
            ],
            "inputs": {
                "llmModel": "chatOpenAI",
                "llmModelConfig": {
                    "modelName": MODEL,
                    "temperature": 0.1,
                    "streaming": False,
                    # ChatOpenAI reads `basepath` (not `baseUrl`) for its
                    # configuration.baseURL — see ChatOpenAI.ts init. A `baseUrl`
                    # key here is silently ignored and the model falls back to
                    # OpenAI's default endpoint, 401-ing against new-api.
                    "basepath": NEWAPI_BASE,
                    "llmModel": "chatOpenAI",
                    "FLOWISE_CREDENTIAL_ID": cred_id,
                },
                "llmMessages": [
                    {"role": "system",
                     "content": "You help test cross-turn Flow State. "
                                "If a stored name is provided in the user message, "
                                "answer using exactly that name when asked. "
                                "Reply in one short sentence."},
                    # Both variables are resolved in a single pass over this
                    # content string (resolveVariables scans every {{...}}).
                    # `{{ question }}` is the turn's question; `{{$flow.state.user_name}}`
                    # is the recovered Flow State — empty on turn 1, the value
                    # llmUpdateState persisted on turn 1 when read back on turn 2.
                    {"role": "user",
                     "content": "Stored name from state: {{$flow.state.user_name}}\n"
                                "Question: {{ question }}"},
                ],
                "llmEnableMemory": False,
                "llmReturnResponseAs": "assistantMessage",
                # Extract the user's name from the question into the `user_name`
                # state key every turn. On turn 1 the question introduces a name;
                # the LLM's own response confirms extraction. The persisted value
                # (not the LLM text) is what turn 2 reads back.
                "llmUpdateState": [
                    {"key": "user_name", "value": "{{ question }}"},
                ],
            },
            "inputAnchors": [],
            "outputs": {}, "selected": False,
        },
    }

    direct = {
        "id": "directReplyAgentflow_1", "type": "customNode",
        "position": {"x": 840, "y": 240}, "width": 300, "height": 250,
        "data": {
            "id": "directReplyAgentflow_1", "label": "Direct Reply", "version": 1.0,
            "name": "directReplyAgentflow", "type": "DirectReply",
            "baseClasses": ["DirectReply"], "category": "Agent Flows",
            "description": "Directly reply to the user with a message",
            "hideOutput": True,
            "inputParams": [
                {"label": "Message", "name": "directReplyMessage", "type": "string",
                 "rows": 4, "acceptVariable": True},
            ],
            "inputs": {
                # Reference the LLM node's output so the reply carries the model text.
                "directReplyMessage": "{{llmAgentflow_0.output.content}}",
            },
            "outputs": {}, "selected": False,
        },
    }

    edges = [
        {"source": "startAgentflow_0", "sourceHandle": None,
         "target": "llmAgentflow_0", "targetHandle": None,
         "type": "buttonedge", "id": "e-start-to-llm", "data": {"label": ""}},
        {"source": "llmAgentflow_0", "sourceHandle": llm_out,
         "target": "directReplyAgentflow_1", "targetHandle": None,
         "type": "buttonedge", "id": "e-llm-to-direct", "data": {"label": ""}},
    ]
    return json.dumps({"nodes": [start, llm, direct], "edges": edges,
                       "viewport": {"x": 0, "y": 0, "zoom": 0.7}})


def find_or_create_agentflow(flow_data):
    status, body = req("GET", "/api/v1/chatflows")
    if status != 200:
        print(f"list chatflows failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    items = body if isinstance(body, list) else []
    af_id = None
    for c in items:
        if c.get("name") == FLOWFLOW_NAME:
            af_id = c["id"]
            break
    if af_id:
        status, body = req("PUT", f"/api/v1/chatflows/{af_id}", {
            "name": FLOWFLOW_NAME, "type": "AGENTFLOW", "flowData": flow_data,
        })
    else:
        status, body = req("POST", "/api/v1/chatflows", {
            "name": FLOWFLOW_NAME, "type": "AGENTFLOW", "flowData": flow_data,
        })
    if status != 200:
        print(f"save agentflow failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    return body["id"]


def predict(af_id, question, base=None):
    """Non-streaming prediction with a pinned sessionId.

    `base` routes the request to a specific Flowise instance (default BASE).
    Used for the cross-instance check: turn 1 -> instance A, turn 2 -> instance B
    (SECOND_INSTANCE), both reading the same shared PG `execution` table.
    """
    body = {
        "question": question,
        "overrideConfig": {"sessionId": SESSION_ID},
    }
    return req("POST", f"/api/v1/prediction/{af_id}", body, base=base)


def main():
    print("[1/3] ensure OpenAI credential -> new-api")
    cred_id = find_or_create_credential()
    print(f"    credential id: {cred_id}")

    print("[2/3] build & save agentflow (Start -> LLM -> DirectReply, startPersistState=true)")
    flow_data = build_flow_data(cred_id)
    af_id = find_or_create_agentflow(flow_data)
    print(f"    agentflow id: {af_id}")
    print(f"    canvas URL: {BASE}/canvas/{af_id}")

    turn2_base = SECOND_INSTANCE or BASE
    print(f"[3/3] turn 1 -> {BASE}; turn 2 -> {turn2_base} (same sessionId={SESSION_ID})")
    print("    --- turn 1 ---")
    s, r = predict(af_id, "My name is Alice, nice to meet you.")
    text1 = r.get("text") if isinstance(r, dict) else str(r)
    print(f"    HTTP {s}  reply: {str(text1)[:200]}")
    if s != 200:
        print("    ABORT: turn 1 did not return 200; fix the flow before judging state recovery.")
        sys.exit(1)

    print("    --- turn 2 ---")
    # The question embeds $flow.state.user_name. Flowise resolves it BEFORE calling
    # the LLM, so the model receives "The user's name is Alice. What is it?" only
    # when startPersistState recovered `user_name` from the PG `execution` row
    # written by turn 1. If state was NOT recovered, the literal stays unresolved
    # (empty) and the model cannot answer "Alice".
    s, r = predict(af_id, "The user's name is {{$flow.state.user_name}}. What is it? Reply with just the name.",
                   base=(SECOND_INSTANCE or None))
    text2 = r.get("text") if isinstance(r, dict) else str(r)
    print(f"    HTTP {s}  reply: {str(text2)[:200]}")

    print()
    print(f"agentflow id: {af_id}")
    print(f"session id:   {SESSION_ID}")
    cross = " (cross-instance via shared PG)" if SECOND_INSTANCE else " (single instance)"
    if isinstance(text2, str) and "alice" in text2.lower():
        print(f"VERDICT: cross-turn state recovered{cross} — turn 2 recalled 'Alice' from turn 1")
    else:
        print(f"VERDICT: turn 2 did NOT recall the name{cross} — investigate state recovery")


if __name__ == "__main__":
    main()
