#!/usr/bin/env python3
"""
M1.1–M1.3: Programmatically build a Flowise chatflow that wires a
ChatOpenAI node (pointed at the mil-agents new-api LLM gateway) into a
ReAct Agent with a Calculator tool, then verify a conversation + tool call.

Env:
  FLOWISE_BASE_URL  default http://localhost:3101
  FLOWISE_API_KEY   the platform API key (Bearer) created via /api/v1/apikey
  NEWAPI_BASE_URL   default http://localhost:13000/v1
  NEWAPI_TOKEN      sk-... token for new-api (used to seed the OpenAI credential)
  FLOWISE_CRED_NAME default newapi-openai
  CHATFLOW_NAME     default M1 Agent Demo
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
CHATFLOW_NAME = os.environ.get("CHATFLOW_NAME", "M1 Agent Demo")
MODEL = os.environ.get("NEWAPI_MODEL", "glm-5.2")

if not API_KEY:
    print("FATAL: FLOWISE_API_KEY not set", file=sys.stderr)
    sys.exit(2)
if not NEWAPI_TOKEN:
    print("FATAL: NEWAPI_TOKEN not set", file=sys.stderr)
    sys.exit(2)


def req(method, path, body=None):
    url = BASE + path
    data = None
    headers = {"Authorization": f"Bearer {API_KEY}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, str(e)


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
    # list credentials
    status, body = req("GET", "/api/v1/credentials")
    if status != 200:
        print(f"list credentials failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    items = body if isinstance(body, list) else body.get("data", body) if isinstance(body, dict) else []
    for c in items:
        if c.get("name") == CRED_NAME:
            old_id = c["id"]
            status, body = req("DELETE", f"/api/v1/credentials/{old_id}")
            if status != 200:
                print(f"delete stale credential {old_id} failed: {status} {body}", file=sys.stderr)
                sys.exit(1)
            print(f"    deleted stale credential {old_id} (recreating with current token)")
            break
    # create (always, after any deletion)
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
    chatopenai_out = "chatOpenAI_0-output-chatOpenAI-ChatOpenAI|BaseChatModel|BaseLanguageModel|Runnable"
    calc_out = "calculator_1-output-calculator-Calculator|Tool|StructuredTool|BaseLangChain"
    mem_out = "bufferMemory_0-output-bufferMemory-BufferMemory|BaseChatMemory|BaseMemory"
    agent_out = "reactAgentChat_0-output-reactAgentChat-AgentExecutor|BaseChain|Runnable"

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
            "id": "calculator_1", "type": "customNode",
            "position": {"x": 460, "y": 240}, "width": 300, "height": 143,
            "data": {
                "id": "calculator_1", "label": "Calculator", "version": 1,
                "name": "calculator", "type": "Calculator",
                "baseClasses": ["Calculator", "Tool", "StructuredTool", "BaseLangChain"],
                "category": "Tools", "description": "Perform calculations on response",
                "inputParams": [], "inputAnchors": [], "inputs": {},
                "outputAnchors": [{"id": calc_out, "name": "calculator", "label": "Calculator",
                                   "type": "Calculator | Tool | StructuredTool | BaseLangChain"}],
                "outputs": {}, "selected": False,
            },
        },
        {
            "id": "bufferMemory_0", "type": "customNode",
            "position": {"x": 460, "y": 480}, "width": 300, "height": 253,
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
            "id": "reactAgentChat_0", "type": "customNode",
            "position": {"x": 820, "y": 220}, "width": 300, "height": 435,
            "data": {
                "id": "reactAgentChat_0", "label": "ReAct Agent for Chat Models", "version": 3,
                "name": "reactAgentChat", "type": "AgentExecutor",
                "baseClasses": ["AgentExecutor", "BaseChain", "Runnable"],
                "category": "Agents",
                "description": "ReAct agent for chat models: reason + act with tools",
                "inputParams": [
                    {"label": "Max Iterations", "name": "maxIterations", "type": "number",
                     "optional": True, "additionalParams": True,
                     "id": "reactAgentChat_0-input-maxIterations-number"},
                ],
                "inputAnchors": [
                    {"label": "Allowed Tools", "name": "tools", "type": "Tool", "list": True,
                     "id": "reactAgentChat_0-input-tools-Tool"},
                    {"label": "Chat Model", "name": "model", "type": "BaseChatModel",
                     "id": "reactAgentChat_0-input-model-BaseChatModel"},
                    {"label": "Memory", "name": "memory", "type": "BaseChatMemory",
                     "id": "reactAgentChat_0-input-memory-BaseChatMemory"},
                    {"label": "Input Moderation", "name": "inputModeration", "type": "Moderation",
                     "optional": True, "list": True,
                     "id": "reactAgentChat_0-input-inputModeration-Moderation"},
                ],
                "inputs": {
                    "tools": ["{{calculator_1.data.instance}}"],
                    "model": "{{chatOpenAI_0.data.instance}}",
                    "memory": "{{bufferMemory_0.data.instance}}",
                    "inputModeration": "",
                    "maxIterations": 5,
                },
                "outputAnchors": [{"id": agent_out, "name": "reactAgentChat",
                                   "label": "AgentExecutor",
                                   "type": "AgentExecutor | BaseChain | Runnable"}],
                "outputs": {}, "selected": False,
            },
        },
    ]
    edges = [
        {"source": "calculator_1", "sourceHandle": calc_out,
         "target": "reactAgentChat_0", "targetHandle": "reactAgentChat_0-input-tools-Tool",
         "type": "buttonedge", "id": "e-calculator-to-agent",
         "data": {"label": ""}},
        {"source": "chatOpenAI_0", "sourceHandle": chatopenai_out,
         "target": "reactAgentChat_0", "targetHandle": "reactAgentChat_0-input-model-BaseChatModel",
         "type": "buttonedge", "id": "e-chatopenai-to-agent", "data": {"label": ""}},
        {"source": "bufferMemory_0", "sourceHandle": mem_out,
         "target": "reactAgentChat_0", "targetHandle": "reactAgentChat_0-input-memory-BaseChatMemory",
         "type": "buttonedge", "id": "e-memory-to-agent", "data": {"label": ""}},
    ]
    return json.dumps({"nodes": nodes, "edges": edges, "viewport": {"x": 0, "y": 0, "zoom": 0.7}})


def find_or_create_chatflow(flow_data):
    status, body = req("GET", "/api/v1/chatflows")
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
        status, body = req("PUT", f"/api/v1/chatflows/{cf_id}", {
            "name": CHATFLOW_NAME, "type": "CHATFLOW", "flowData": flow_data,
        })
        if status != 200:
            print(f"update chatflow failed: {status} {body}", file=sys.stderr)
            sys.exit(1)
        return body["id"]
    status, body = req("POST", "/api/v1/chatflows", {
        "name": CHATFLOW_NAME, "type": "CHATFLOW", "flowData": flow_data,
    })
    if status != 200:
        print(f"create chatflow failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    return body["id"]


def predict(cf_id, question):
    # non-streaming prediction
    body = {"question": question, "history": [{"role": "user", "content": question}]}
    status, text = req("POST", f"/api/v1/prediction/{cf_id}", body)
    return status, text


def main():
    print(f"[1/4] ensure OpenAI credential '{CRED_NAME}' -> new-api ({NEWAPI_BASE})")
    cred_id = find_or_create_credential()
    print(f"    credential id: {cred_id}")

    print("[2/4] build & save chatflow (ChatOpenAI -> new-api + ReAct Agent + Calculator)")
    flow_data = build_flow_data(cred_id)
    cf_id = find_or_create_chatflow(flow_data)
    print(f"    chatflow id: {cf_id}")
    print(f"    chatflow URL: {BASE}/canvas/{cf_id}")

    # Probe a non-tool question first, then a tool question.
    print("[3/4] probe A: plain reply (no tool needed)")
    s, r = predict(cf_id, "Say hello in one short sentence.")
    print(f"    HTTP {s}")
    print(f"    body: {(r if isinstance(r,str) else json.dumps(r))[:400]}")

    print("[4/4] probe B: tool call (Calculator: 17 * 23)")
    s, r = predict(cf_id, "Use the calculator to compute 17 multiplied by 23. Tell me the exact result.")
    print(f"    HTTP {s}")
    print(f"    body: {(r if isinstance(r,str) else json.dumps(r))[:600]}")

    print("\nchatflow id:", cf_id)
    return cf_id


if __name__ == "__main__":
    main()
