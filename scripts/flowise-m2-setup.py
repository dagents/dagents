#!/usr/bin/env python3
"""
M2.10: Programmatically build a Flowise chatflow that wires a ChatOpenAI node
(pointed at the dagents new-api LLM gateway) into a Tool Agent (function
calling) with a DispatchInvoke tool, then run the canvas end-to-end acceptance
probe through the dagents gateway.

This mirrors scripts/flowise-m1-setup.py (same urllib + Bearer API Key +
find_or_create structure, same ChatOpenAI→new-api + BufferMemory scaffolding)
and swaps the Calculator tool for the dagents DispatchInvoke tool node
(vendor/flowise/.../nodes/tools/DispatchInvoke). The DispatchInvoke tool POSTs
/api/v1/dispatch/invoke through the gateway and polls
GET /api/v1/dispatch/tasks/:id until the claimed claude daemon completes, so an
LLM can delegate "用 claude 列出目录" to a real claude-code daemon and read its
output back into the canvas.

Agent node: Tool Agent (function calling via model.bindTools), NOT the ReAct
Agent for Chat Models. The ReAct node's text parser passes a bare string as
the tool input, but DispatchInvoke is a StructuredTool with schema
`{ prompt: string }`, so StructuredTool.call rejects it with
"Received tool input did not match expected schema". Tool Agent uses native
OpenAI function calling: glm-5.2 emits a tool_calls[].function.arguments JSON
object that LangChain routes to the tool as `{ prompt }`, matching the schema.

Env:
  FLOWISE_BASE_URL  default http://localhost:3101
  FLOWISE_API_KEY   the platform API key (Bearer) created via /api/v1/apikey
  GATEWAY_BASE_URL  default http://localhost:8080   (acceptance probe target)
  NEWAPI_BASE_URL   default http://localhost:13000/v1
  NEWAPI_TOKEN      sk-... token for new-api (used to seed the OpenAI credential)
  FLOWISE_CRED_NAME default newapi-openai
  CHATFLOW_NAME     default M2 Dispatch Demo
  NEWAPI_MODEL      default glm-5.2
  AGENT_DAEMON_ID   UUID of the target agent_daemons row (FK). Default is the
                    single claude row present in the dagents DB.
  DISPATCH_TIMEOUT_MS  default 180000  (claude CLI is slow; > gateway 120s default)
  PROBE_QUESTION    default "用 claude 列出目录"  (the M2.10 acceptance question)
"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE = os.environ.get("FLOWISE_BASE_URL", "http://localhost:3101").rstrip("/")
GATEWAY = os.environ.get("GATEWAY_BASE_URL", "http://localhost:8080").rstrip("/")
API_KEY = os.environ.get("FLOWISE_API_KEY", "")
NEWAPI_BASE = os.environ.get("NEWAPI_BASE_URL", "http://localhost:13000/v1")
NEWAPI_TOKEN = os.environ.get("NEWAPI_TOKEN", "")
CRED_NAME = os.environ.get("FLOWISE_CRED_NAME", "newapi-openai-m2")
CHATFLOW_NAME = os.environ.get("CHATFLOW_NAME", "M2 Dispatch Demo")
MODEL = os.environ.get("NEWAPI_MODEL", "glm-5.2")
# Default is the single agent_daemons row (claude-code / claude) present in the
# dagents DB as of 2026-07-09. The plan's stale 0a791869… row no longer
# exists; the FK on dispatch_tasks.agent_daemon_id rejects anything else.
AGENT_DAEMON_ID = os.environ.get(
    "AGENT_DAEMON_ID", "6544020d-918a-43e5-a411-a17733b368e1"
)
DISPATCH_TIMEOUT_MS = int(os.environ.get("DISPATCH_TIMEOUT_MS", "180000"))
PROBE_QUESTION = os.environ.get("PROBE_QUESTION", "用 claude 列出目录")

# Chinese tool description steers glm-5.2 toward calling the tool when the user
# asks claude to do something (list a dir, write code, …). Mirrors how M1's
# Calculator description tells the LLM when to compute.
TOOL_DESCRIPTION = (
    "用 claude code 执行任务并返回输出。当用户要求用 claude 执行操作"
    "（如列出目录、读写文件、写代码）时调用此工具。"
)

if not API_KEY:
    print("FATAL: FLOWISE_API_KEY not set", file=sys.stderr)
    sys.exit(2)
if not NEWAPI_TOKEN:
    print("FATAL: NEWAPI_TOKEN not set", file=sys.stderr)
    sys.exit(2)


def req(method, url, body=None, timeout=120):
    """HTTP helper. `url` is a full URL (Flowise or gateway). Returns (status, parsed_or_text)."""
    data = None
    headers = {"Authorization": f"Bearer {API_KEY}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, str(e)


def fw(method, path, body=None, timeout=120):
    """Flowise-scoped request (prepends BASE)."""
    return req(method, BASE + path, body, timeout)


def find_or_create_credential():
    """Ensure a credential named CRED_NAME holds the current NEWAPI_TOKEN.

    Flowise's `openAIApi` credential stores a single `openAIApiKey` that
    ChatOpenAI sends verbatim as `Authorization: Bearer <key>`. PUT on an
    existing credential returns the `_FLOWISE_BLANK_` reveal placeholder and
    (empirically) does not overwrite the stored key, so a stale token survives
    a rerun and the agent silently 401s. The reliable path is delete + create:
    always recreate the credential with the current token so the run is
    reproducible regardless of what the DB previously held.
    """
    status, body = fw("GET", "/api/v1/credentials")
    if status != 200:
        print(f"list credentials failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    items = body if isinstance(body, list) else body.get("data", body) if isinstance(body, dict) else []
    for c in items:
        if c.get("name") == CRED_NAME:
            old_id = c["id"]
            status, body = fw("DELETE", f"/api/v1/credentials/{old_id}")
            if status != 200:
                print(f"delete stale credential {old_id} failed: {status} {body}", file=sys.stderr)
                sys.exit(1)
            print(f"    deleted stale credential {old_id} (recreating with current token)")
            break
    status, body = fw("POST", "/api/v1/credentials", {
        "name": CRED_NAME,
        "credentialName": "openAIApi",
        "plainDataObj": {"openAIApiKey": NEWAPI_TOKEN},
    })
    if status != 200:
        print(f"create credential failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    return body["id"]


def build_flow_data(cred_id):
    # Output-anchor ids/type strings mirror M1's Calculator tool shape
    # (`<node>-output-<name>-<Base>|Tool|StructuredTool|BaseLangChain`). The
    # agent's `tools` input anchor accepts type `Tool`; Flowise validates a
    # connection by splitting the source type on `|` and checking the target
    # type is present, so carrying `Tool` here is what makes the edge valid.
    chatopenai_out = "chatOpenAI_0-output-chatOpenAI-ChatOpenAI|BaseChatModel|BaseLanguageModel|Runnable"
    tool_out = "dispatchInvoke_0-output-dispatchInvoke-DispatchInvoke|Tool|StructuredTool|BaseLangChain"
    mem_out = "bufferMemory_0-output-bufferMemory-BufferMemory|BaseChatMemory|BaseMemory"
    agent_out = "toolAgent_0-output-toolAgent-AgentExecutor|BaseChain|Runnable"

    # Agent: Tool Agent (function-calling), NOT the text-based ReAct Agent for
    # Chat Models. The ReAct node uses `createReactAgent` which parses
    # `Action Input: <string>` from the LLM and passes that *string* to the
    # tool — but DispatchInvoke is a StructuredTool whose schema is
    # `{ prompt: string }`, so `StructuredTool.call` rejects the bare string
    # with "Received tool input did not match expected schema". Tool Agent
    # uses `model.bindTools(tools)` (native OpenAI function calling): glm-5.2
    # emits a `tool_calls[].function.arguments` JSON object that LangChain
    # routes to the tool as `{ prompt }`, matching the schema. (Verified:
    # glm-5.2 returns a well-formed tool_call for dispatch_invoke.)
    SYSTEM_MESSAGE = (
        "你是一个能调用 claude code 的助手。当用户要求用 claude 执行操作"
        "（如列出目录、读写文件、写代码）时，必须调用 dispatch_invoke 工具，"
        "把用户的完整需求作为 prompt 传给它，再把工具返回的输出转述给用户。"
    )

    nodes = [
        {
            "id": "chatOpenAI_0", "type": "customNode",
            "position": {"x": 80, "y": 60}, "width": 300, "height": 670,
            "data": {
                "id": "chatOpenAI_0", "label": "ChatOpenAI", "version": 6,
                "name": "chatOpenAI", "type": "ChatOpenAI",
                "baseClasses": ["ChatOpenAI", "BaseChatModel", "BaseLanguageModel", "Runnable"],
                "category": "Chat Models",
                "description": "Wrapper around OpenAI large language models that use the Chat endpoint",
                "credential": cred_id,
                "inputParams": [
                    {"label": "Connect Credential", "name": "credential", "type": "credential",
                     "credentialNames": ["openAIApi"], "id": "chatOpenAI_0-input-credential-credential"},
                    {"label": "Model Name", "name": "modelName", "type": "asyncOptions",
                     "loadMethod": "listModels", "default": MODEL, "id": "chatOpenAI_0-input-modelName-options"},
                    {"label": "Temperature", "name": "temperature", "type": "number", "step": 0.1,
                     "default": 0.7, "optional": True, "id": "chatOpenAI_0-input-temperature-number"},
                    {"label": "BasePath", "name": "basepath", "type": "string", "optional": True,
                     "additionalParams": True, "id": "chatOpenAI_0-input-basepath-string"},
                ],
                "inputAnchors": [{"label": "Cache", "name": "cache", "type": "BaseCache",
                                  "optional": True, "id": "chatOpenAI_0-input-cache-BaseCache"}],
                "inputs": {
                    "credentialId": cred_id,
                    "modelName": MODEL,
                    "temperature": 0.7,
                    "basepath": NEWAPI_BASE,
                },
                "outputAnchors": [{"id": chatopenai_out, "name": "chatOpenAI", "label": "ChatOpenAI",
                                   "type": "ChatOpenAI | BaseChatModel | BaseLanguageModel | Runnable"}],
                "outputs": {}, "selected": False,
            },
        },
        {
            "id": "dispatchInvoke_0", "type": "customNode",
            "position": {"x": 460, "y": 240}, "width": 300, "height": 360,
            "data": {
                "id": "dispatchInvoke_0", "label": "Dispatch Invoke", "version": 1.0,
                "name": "dispatchInvoke", "type": "DispatchInvoke",
                "baseClasses": ["DispatchInvoke", "Tool", "StructuredTool", "BaseLangChain"],
                "category": "Tools",
                "description": "Invoke a dagents dispatch task via the gateway and return its output",
                "inputParams": [
                    {"label": "Agent Daemon ID", "name": "agentDaemonId", "type": "string",
                     "description": "UUID of the target agent daemon that will run the task",
                     "acceptVariable": True, "id": "dispatchInvoke_0-input-agentDaemonId-string"},
                    {"label": "Gateway URL", "name": "gatewayUrl", "type": "string",
                     "default": "http://localhost:8080", "acceptVariable": True,
                     "optional": True, "additionalParams": True,
                     "id": "dispatchInvoke_0-input-gatewayUrl-string"},
                    {"label": "Poll Interval (ms)", "name": "pollIntervalMs", "type": "number",
                     "default": 1000, "step": 1, "optional": True, "additionalParams": True,
                     "id": "dispatchInvoke_0-input-pollIntervalMs-number"},
                    {"label": "Timeout (ms)", "name": "timeoutMs", "type": "number",
                     "default": 120000, "step": 1, "optional": True, "additionalParams": True,
                     "id": "dispatchInvoke_0-input-timeoutMs-number"},
                    {"label": "Name", "name": "name", "type": "string", "default": "dispatch_invoke",
                     "optional": True, "additionalParams": True,
                     "id": "dispatchInvoke_0-input-name-string"},
                    {"label": "Description", "name": "description", "type": "string", "rows": 4,
                     "default": "Invoke a dagents dispatch task and return its output",
                     "optional": True, "additionalParams": True,
                     "id": "dispatchInvoke_0-input-description-string"},
                ],
                "inputAnchors": [],
                "inputs": {
                    "agentDaemonId": AGENT_DAEMON_ID,
                    "gatewayUrl": "http://localhost:8080",
                    "pollIntervalMs": 1000,
                    "timeoutMs": DISPATCH_TIMEOUT_MS,
                    "name": "dispatch_invoke",
                    "description": TOOL_DESCRIPTION,
                },
                "outputAnchors": [{"id": tool_out, "name": "dispatchInvoke", "label": "Dispatch Invoke",
                                   "type": "DispatchInvoke | Tool | StructuredTool | BaseLangChain"}],
                "outputs": {}, "selected": False,
            },
        },
        {
            "id": "bufferMemory_0", "type": "customNode",
            "position": {"x": 460, "y": 560}, "width": 300, "height": 253,
            "data": {
                "id": "bufferMemory_0", "label": "Buffer Memory", "version": 2,
                "name": "bufferMemory", "type": "BufferMemory",
                "baseClasses": ["BufferMemory", "BaseChatMemory", "BaseMemory"],
                "category": "Memory", "description": "Retrieve chat messages stored in database",
                "inputParams": [
                    {"label": "Session Id", "name": "sessionId", "type": "string",
                     "default": "", "additionalParams": True, "optional": True,
                     "id": "bufferMemory_0-input-sessionId-string"},
                    {"label": "Memory Key", "name": "memoryKey", "type": "string",
                     "default": "chat_history", "additionalParams": True,
                     "id": "bufferMemory_0-input-memoryKey-string"},
                ],
                "inputAnchors": [], "inputs": {"sessionId": "", "memoryKey": "chat_history"},
                "outputAnchors": [{"id": mem_out, "name": "bufferMemory", "label": "BufferMemory",
                                   "type": "BufferMemory | BaseChatMemory | BaseMemory"}],
                "outputs": {}, "selected": False,
            },
        },
        {
            "id": "toolAgent_0", "type": "customNode",
            "position": {"x": 820, "y": 300}, "width": 300, "height": 470,
            "data": {
                "id": "toolAgent_0", "label": "Tool Agent", "version": 2.0,
                "name": "toolAgent", "type": "AgentExecutor",
                "baseClasses": ["AgentExecutor", "BaseChain", "Runnable"],
                "category": "Agents",
                "description": "Agent that uses Function Calling to pick the tools and args to call",
                "inputParams": [
                    {"label": "Tools", "name": "tools", "type": "Tool", "list": True,
                     "id": "toolAgent_0-input-tools-Tool"},
                    {"label": "Memory", "name": "memory", "type": "BaseChatMemory",
                     "id": "toolAgent_0-input-memory-BaseChatMemory"},
                    {"label": "Tool Calling Chat Model", "name": "model", "type": "BaseChatModel",
                     "description": "Only compatible with models that are capable of function calling",
                     "id": "toolAgent_0-input-model-BaseChatModel"},
                    {"label": "Chat Prompt Template", "name": "chatPromptTemplate", "type": "ChatPromptTemplate",
                     "optional": True, "id": "toolAgent_0-input-chatPromptTemplate-ChatPromptTemplate"},
                    {"label": "System Message", "name": "systemMessage", "type": "string", "rows": 4,
                     "default": "You are a helpful AI assistant.", "optional": True, "additionalParams": True,
                     "id": "toolAgent_0-input-systemMessage-string"},
                    {"label": "Input Moderation", "name": "inputModeration", "type": "Moderation",
                     "optional": True, "list": True,
                     "id": "toolAgent_0-input-inputModeration-Moderation"},
                    {"label": "Max Iterations", "name": "maxIterations", "type": "number",
                     "optional": True, "additionalParams": True,
                     "id": "toolAgent_0-input-maxIterations-number"},
                    {"label": "Enable Detailed Streaming", "name": "enableDetailedStreaming", "type": "boolean",
                     "default": False, "optional": True, "additionalParams": True,
                     "id": "toolAgent_0-input-enableDetailedStreaming-boolean"},
                ],
                "inputAnchors": [
                    {"label": "Tools", "name": "tools", "type": "Tool", "list": True,
                     "id": "toolAgent_0-input-tools-Tool"},
                    {"label": "Memory", "name": "memory", "type": "BaseChatMemory",
                     "id": "toolAgent_0-input-memory-BaseChatMemory"},
                    {"label": "Tool Calling Chat Model", "name": "model", "type": "BaseChatModel",
                     "id": "toolAgent_0-input-model-BaseChatModel"},
                    {"label": "Chat Prompt Template", "name": "chatPromptTemplate", "type": "ChatPromptTemplate",
                     "optional": True, "id": "toolAgent_0-input-chatPromptTemplate-ChatPromptTemplate"},
                    {"label": "Input Moderation", "name": "inputModeration", "type": "Moderation",
                     "optional": True, "list": True,
                     "id": "toolAgent_0-input-inputModeration-Moderation"},
                ],
                "inputs": {
                    "tools": ["{{dispatchInvoke_0.data.instance}}"],
                    "model": "{{chatOpenAI_0.data.instance}}",
                    "memory": "{{bufferMemory_0.data.instance}}",
                    "chatPromptTemplate": "",
                    "systemMessage": SYSTEM_MESSAGE,
                    "inputModeration": "",
                    "maxIterations": 5,
                    "enableDetailedStreaming": False,
                },
                "outputAnchors": [{"id": agent_out, "name": "toolAgent",
                                   "label": "AgentExecutor",
                                   "type": "AgentExecutor | BaseChain | Runnable"}],
                "outputs": {}, "selected": False,
            },
        },
    ]
    edges = [
        {"source": "dispatchInvoke_0", "sourceHandle": tool_out,
         "target": "toolAgent_0", "targetHandle": "toolAgent_0-input-tools-Tool",
         "type": "buttonedge", "id": "e-dispatch-to-agent",
         "data": {"label": ""}},
        {"source": "chatOpenAI_0", "sourceHandle": chatopenai_out,
         "target": "toolAgent_0", "targetHandle": "toolAgent_0-input-model-BaseChatModel",
         "type": "buttonedge", "id": "e-chatopenai-to-agent", "data": {"label": ""}},
        {"source": "bufferMemory_0", "sourceHandle": mem_out,
         "target": "toolAgent_0", "targetHandle": "toolAgent_0-input-memory-BaseChatMemory",
         "type": "buttonedge", "id": "e-memory-to-agent", "data": {"label": ""}},
    ]
    return json.dumps({"nodes": nodes, "edges": edges, "viewport": {"x": 0, "y": 0, "zoom": 0.7}})


def find_or_create_chatflow(flow_data):
    status, body = fw("GET", "/api/v1/chatflows")
    if status != 200:
        print(f"list chatflows failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    items = body if isinstance(body, list) else []
    cf_id = None
    for c in items:
        if c.get("name") == CHATFLOW_NAME:
            cf_id = c["id"]
            break
    if cf_id:
        status, body = fw("PUT", f"/api/v1/chatflows/{cf_id}", {
            "name": CHATFLOW_NAME, "type": "CHATFLOW", "flowData": flow_data,
        })
        if status != 200:
            print(f"update chatflow failed: {status} {body}", file=sys.stderr)
            sys.exit(1)
        return body["id"], "updated"
    status, body = fw("POST", "/api/v1/chatflows", {
        "name": CHATFLOW_NAME, "type": "CHATFLOW", "flowData": flow_data,
    })
    if status != 200:
        print(f"create chatflow failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    return body["id"], "created"


def predict_via_gateway(cf_id, question):
    """M2.10 acceptance probe: POST gateway /api/v1/flows/<id>/prediction.

    The gateway rewrites this to Flowise /api/v1/prediction/<id>, threads an
    x-run-id, and returns the agent's final text. A 200 with non-empty text
    that is NOT an error string is the e2e pass signal.
    """
    body = {"question": question, "history": [{"role": "user", "content": question}]}
    return req("POST", f"{GATEWAY}/api/v1/flows/{cf_id}/prediction", body, timeout=240)


def main():
    print(f"[1/3] ensure OpenAI credential '{CRED_NAME}' -> new-api ({NEWAPI_BASE})")
    cred_id = find_or_create_credential()
    print(f"    credential id: {cred_id}")

    print("[2/3] build & save chatflow (ChatOpenAI -> new-api + Tool Agent + DispatchInvoke)")
    print(f"    agentDaemonId: {AGENT_DAEMON_ID}")
    print(f"    gatewayUrl:    http://localhost:8080")
    print(f"    timeoutMs:     {DISPATCH_TIMEOUT_MS}")
    flow_data = build_flow_data(cred_id)
    cf_id, action = find_or_create_chatflow(flow_data)
    print(f"    chatflow {action}, id: {cf_id}")
    print(f"    chatflow URL: {BASE}/canvas/{cf_id}")

    print("[3/3] e2e acceptance probe via gateway")
    print(f"    POST {GATEWAY}/api/v1/flows/{cf_id}/prediction")
    print(f"    question: {PROBE_QUESTION}")
    s, r = predict_via_gateway(cf_id, PROBE_QUESTION)
    print(f"    HTTP {s}")
    body_str = r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)
    print(f"    body: {body_str[:1200]}")

    print("\nchatflow id:", cf_id)
    return cf_id


if __name__ == "__main__":
    main()
