#!/usr/bin/env python3
"""
M1.5: Wire Flowise's built-in Langfuse analytics provider onto the existing
M1 Agent Demo chatflow, run one conversation, and verify the trace (with token
usage + cost) lands in Langfuse at localhost:3001.

Flow:
  1. Provision Langfuse (signup/login if needed, create org + project + API key
     + a glm-5.2 model definition with a price so cost is computable). Idempotent:
     reuses an existing org/project/key when present, deletes-and-recreates only
     to guarantee the *current* key is wired into Flowise (the secret key is
     revealed once at creation, so listing cannot recover it).
  2. Create a `langfuseApi` credential in Flowise holding the public/secret key
     + endpoint. Delete-then-create (same pattern as the openAIApi credential in
     flowise-m1-setup.py: Flowise PUT does not overwrite stored secret fields).
  3. Set `chatflow.analytic` on the "M1 Agent Demo" chatflow to a JSON document
     enabling the langFuse provider and pointing it at the credential. This is
     the exact shape the AnalyseFlow UI saves (AnalyseFlow.jsx).
  4. POST one prediction against the chatflow.
  5. Poll the Langfuse traces API until a trace with totalCost > 0 appears, then
     print it as the acceptance evidence.

Env:
  FLOWISE_BASE_URL   default http://localhost:3101
  FLOWISE_API_KEY    Flowise platform API key (Bearer)
  CHATFLOW_NAME      default "M1 Agent Demo"  (must already exist — M1.1-1.3)
  LANGFUSE_BASE_URL  default http://localhost:3001
  LANGFUSE_EMAIL     default admin@milagents.local
  LANGFUSE_PASSWORD  default Admin1234!
  LANGFUSE_ORG_NAME  default "Mil-Agents"
  LANGFUSE_PROJECT_NAME  default "Mil-Agents Dev"
  LANGFUSE_KEY_NOTE  default "flowise-m1.5"
  LANGFUSE_MODEL_NAME    default glm-5.2   (must match the chatflow's model)
  LANGFUSE_FLOWISE_CRED_NAME  default langfuse-m1.5
  LANGFUSE_TRACE_TIMEOUT  default 60 (seconds to wait for a trace)

Exit codes: 0 ok, 1 step failure, 2 missing required env (FLOWISE_API_KEY).
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
FLOWISE_BASE = os.environ.get("FLOWISE_BASE_URL", "http://localhost:3101").rstrip("/")
FLOWISE_API_KEY = os.environ.get("FLOWISE_API_KEY", "")
CHATFLOW_NAME = os.environ.get("CHATFLOW_NAME", "M1 Agent Demo")

LANGFUSE_BASE = os.environ.get("LANGFUSE_BASE_URL", "http://localhost:3001").rstrip("/")
LF_EMAIL = os.environ.get("LANGFUSE_EMAIL", "admin@milagents.local")
LF_PASSWORD = os.environ.get("LANGFUSE_PASSWORD", "Admin1234!")
LF_ORG_NAME = os.environ.get("LANGFUSE_ORG_NAME", "Mil-Agents")
LF_PROJECT_NAME = os.environ.get("LANGFUSE_PROJECT_NAME", "Mil-Agents Dev")
LF_KEY_NOTE = os.environ.get("LANGFUSE_KEY_NOTE", "flowise-m1.5")
LF_MODEL_NAME = os.environ.get("LANGFUSE_MODEL_NAME", "glm-5.2")
LF_CRED_NAME = os.environ.get("LANGFUSE_FLOWISE_CRED_NAME", "langfuse-m1.5")
TRACE_TIMEOUT = int(os.environ.get("LANGFUSE_TRACE_TIMEOUT", "60"))

if not FLOWISE_API_KEY:
    print("FATAL: FLOWISE_API_KEY not set", file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
class CookieJar:
    """Minimal cookie jar good enough for next-auth session + csrf cookies."""

    def __init__(self):
        self.jar = {}

    def extract(self, headers):
        # headers may be an http.client.HTTPMessage (from a Response) or our
        # _RespHeaders adapter (from a redirect/error). Both support get_all.
        for hdr in headers.get_all("Set-Cookie") or []:
            pair = hdr.split(";", 1)[0]
            if "=" not in pair:
                continue
            k, v = pair.split("=", 1)
            self.jar[k.strip()] = v.strip()

    def header(self):
        return "; ".join(f"{k}={v}" for k, v in self.jar.items())


COOKIES = CookieJar()


class _CookieRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Capture Set-Cookie on each 3xx hop.

    urllib follows redirects transparently and hands back only the *final*
    response, so Set-Cookie headers on the intermediate 302 (exactly where
    next-auth sets the session token) would be lost without this. Extracting
    them here keeps the session cookie alive across the redirect chain.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        COOKIES.extract(_RespHeaders(headers))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _RespHeaders:
    """Adapter so CookieJar.extract can read a raw http.client.HTTPMessage."""

    def __init__(self, headers):
        self._headers = headers

    def get_all(self, name, default=None):
        return self._headers.get_all(name, default)


_OPENER = urllib.request.build_opener(_CookieRedirectHandler)


def http(method, url, body=None, headers=None, form=None):
    """Return (status, text). body=json-dict -> JSON; form=dict -> urlencoded."""
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    if COOKIES.jar:
        h["Cookie"] = COOKIES.header()
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with _OPENER.open(req, timeout=30) as resp:
            COOKIES.extract(_RespHeaders(resp.headers))
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        COOKIES.extract(_RespHeaders(e.headers))
        return e.code, e.read().decode()
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def trpc(proc, payload=None, method="POST"):
    """Call a Langfuse tRPC batch procedure. Returns the parsed JSON list."""
    url = f"{LANGFUSE_BASE}/api/trpc/{proc}?batch=1"
    if method == "GET":
        enc = urllib.parse.quote(json.dumps({"0": {"json": payload}}))
        status, text = http("GET", f"{url}&input={enc}")
    else:
        status, text = http(method, url, body={"0": {"json": payload}})
    if status >= 400:
        print(f"  trpc {proc} HTTP {status}: {text[:300]}", file=sys.stderr)
        sys.exit(1)
    return json.loads(text)


def trpc_result(proc, payload=None, method="POST"):
    """Return the `.json` result of a single tRPC batch entry, or raise on error."""
    arr = trpc(proc, payload, method)
    entry = arr[0]
    if "error" in entry:
        print(f"  trpc {proc} error: {entry['error'].get('json', {}).get('message', '')[:300]}",
              file=sys.stderr)
        sys.exit(1)
    return entry["result"]["data"]["json"]


# ---------------------------------------------------------------------------
# Step 1: Langfuse provisioning
# ---------------------------------------------------------------------------
def login_langfuse():
    """Log into Langfuse web UI (signup if the user does not exist yet).

    Signup returns 422 "User with email already exists" on reruns, which is not
    an error — it just means we already registered and should log in directly.
    """
    status, text = http("GET", f"{LANGFUSE_BASE}/api/auth/csrf")
    csrf = json.loads(text)["csrfToken"]
    if _credentials_login(csrf):
        session = json.loads(http("GET", f"{LANGFUSE_BASE}/api/auth/session")[1])
        if "user" in session:
            return session
    # Login failed: try signup, treating "already exists" (422) as not-an-error.
    status, text = http("POST", f"{LANGFUSE_BASE}/api/auth/signup",
                        body={"name": "Admin", "email": LF_EMAIL, "password": LF_PASSWORD})
    if status == 200:
        csrf = json.loads(http("GET", f"{LANGFUSE_BASE}/api/auth/csrf")[1])["csrfToken"]
        if _credentials_login(csrf):
            return json.loads(http("GET", f"{LANGFUSE_BASE}/api/auth/session")[1])
        print("  langfuse login failed after signup", file=sys.stderr)
        sys.exit(1)
    if status == 422 and "already exists" in text:
        # The account exists but the earlier login attempt raced or used a stale
        # csrf token; retry login with a fresh csrf.
        csrf = json.loads(http("GET", f"{LANGFUSE_BASE}/api/auth/csrf")[1])["csrfToken"]
        if _credentials_login(csrf):
            return json.loads(http("GET", f"{LANGFUSE_BASE}/api/auth/session")[1])
    print(f"  langfuse login/signup failed: HTTP {status} {text[:200]}", file=sys.stderr)
    sys.exit(1)


def _credentials_login(csrf):
    """One next-auth credentials login attempt. Returns True on success."""
    status, _ = http("POST", f"{LANGFUSE_BASE}/api/auth/callback/credentials",
                     form={"csrfToken": csrf, "email": LF_EMAIL, "password": LF_PASSWORD,
                           "redirect": "false"})
    if status >= 400:
        return False
    sess = json.loads(http("GET", f"{LANGFUSE_BASE}/api/auth/session")[1])
    return "user" in sess and sess["user"].get("email") == LF_EMAIL


def find_or_create_org(session):
    for org in session.get("user", {}).get("organizations", []) or []:
        if org.get("name") == LF_ORG_NAME:
            return org["id"]
    org = trpc_result("organizations.create", {"name": LF_ORG_NAME})
    return org["id"]


def find_or_create_project(org_id):
    # projects are returned on the session under each org; re-read session to see them
    sess = json.loads(http("GET", f"{LANGFUSE_BASE}/api/auth/session")[1])
    for org in sess.get("user", {}).get("organizations", []) or []:
        if org.get("id") == org_id:
            for proj in org.get("projects", []) or []:
                if proj.get("name") == LF_PROJECT_NAME:
                    return proj["id"]
    proj = trpc_result("projects.create", {"name": LF_PROJECT_NAME, "orgId": org_id})
    return proj["id"]


def ensure_model_price(project_id):
    """Create the model price definition if it does not already exist.

    The model name must match what the LLM reports (glm-5.2 in the M1 chatflow).
    Without a price row, Langfuse stores token counts but totalCost stays 0, so
    the acceptance gate (token + cost) would only be half-met.
    """
    models = trpc_result("models.all", {"projectId": project_id}, method="GET")
    existing = models.get("models", []) if isinstance(models, dict) else models
    for m in existing:
        if m.get("modelName") == LF_MODEL_NAME:
            return m["id"]
    created = trpc_result("models.create", {
        "projectId": project_id,
        "modelName": LF_MODEL_NAME,
        "matchPattern": f"(?i)^({LF_MODEL_NAME})$",
        "inputPrice": 0.000002,
        "outputPrice": 0.000008,
        "unit": "TOKENS",
        "tokenizerId": "openai",
        "tokenizerConfig": {"tokensPerMessage": 3, "tokensPerName": 1,
                            "tokenizerModel": "gpt-3.5-turbo"},
    })
    return created["id"]


def ensure_api_key(project_id):
    """Recreate the API key so the live secret key is known.

    The secret key is returned only at creation time; `apiKeys.byProjectId`
    lists the publicKey but masks the secret. To make the run reproducible we
    delete any existing key with our note, then create a fresh one. This is the
    same delete+create rationale as the openAIApi credential below.
    """
    keys = trpc_result("apiKeys.byProjectId", {"projectId": project_id}, method="GET")
    for k in keys:
        if k.get("note") == LF_KEY_NOTE:
            trpc_result("apiKeys.delete", {"id": k["id"], "projectId": project_id})
    key = trpc_result("apiKeys.create", {"projectId": project_id, "note": LF_KEY_NOTE})
    return key["publicKey"], key["secretKey"]


# ---------------------------------------------------------------------------
# Step 2: Flowise langfuseApi credential
# ---------------------------------------------------------------------------
def flowise_req(method, path, body=None):
    headers = {"Authorization": f"Bearer {FLOWISE_API_KEY}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(FLOWISE_BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def find_or_create_langfuse_credential(public_key, secret_key):
    """Delete any existing langfuseApi credential of this name, then create it.

    PUT on an existing credential does not overwrite the stored secret fields
    (same Flowise behavior documented for openAIApi in flowise-m1-setup.py),
    so a stale key would survive a rerun and traces would 401. Delete+create is
    the reliable path.
    """
    status, body = flowise_req("GET", "/api/v1/credentials")
    if status != 200:
        print(f"  list flowise credentials failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    items = body if isinstance(body, list) else body.get("data", body) if isinstance(body, dict) else []
    for c in items:
        if c.get("name") == LF_CRED_NAME:
            flowise_req("DELETE", f"/api/v1/credentials/{c['id']}")
            print(f"    deleted stale credential {c['id']}")
            break
    status, body = flowise_req("POST", "/api/v1/credentials", {
        "name": LF_CRED_NAME,
        "credentialName": "langfuseApi",
        "plainDataObj": {
            "langFusePublicKey": public_key,
            "langFuseSecretKey": secret_key,
            "langFuseEndpoint": LANGFUSE_BASE,
        },
    })
    if status != 200:
        print(f"  create langfuse credential failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    return body["id"]


# ---------------------------------------------------------------------------
# Step 3: attach the langFuse analytic provider to the chatflow
# ---------------------------------------------------------------------------
def find_chatflow():
    status, body = flowise_req("GET", "/api/v1/chatflows")
    if status != 200:
        print(f"  list chatflows failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    for c in body if isinstance(body, list) else []:
        if c.get("name") == CHATFLOW_NAME:
            return c["id"]
    print(f"  chatflow '{CHATFLOW_NAME}' not found — run scripts/flowise-m1-setup.py first",
          file=sys.stderr)
    sys.exit(1)


def attach_analytic(chatflow_id, cred_id):
    """Set chatflow.analytic to enable the langFuse provider.

    Shape mirrors AnalyseFlow.jsx onSave: each provider maps to an object with
    `status` (on/off) and `credentialId`. handler.ts:552 reads langFuseSecretKey /
    langFusePublicKey / langFuseEndpoint from that credential's decrypted data.
    """
    analytic = {"langFuse": {"status": True, "credentialId": cred_id}}
    status, body = flowise_req("PUT", f"/api/v1/chatflows/{chatflow_id}", {
        "analytic": json.dumps(analytic),
    })
    if status != 200:
        print(f"  attach analytic failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    return body


# ---------------------------------------------------------------------------
# Step 4 + 5: run a prediction and verify the trace
# ---------------------------------------------------------------------------
def run_prediction(chatflow_id):
    body = {"question": "Say hello in one short sentence.",
            "history": [{"role": "user", "content": "Say hello in one short sentence."}]}
    status, resp = flowise_req("POST", f"/api/v1/prediction/{chatflow_id}", body)
    return status, resp


def wait_for_trace(public_key, secret_key):
    """Poll Langfuse /api/public/traces until a trace with totalCost > 0 appears.

    The langfuse-langchain CallbackHandler flushes asynchronously (default batch
    flush), so the trace may not be queryable the instant the prediction returns.
    """
    auth = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
    deadline = time.time() + TRACE_TIMEOUT
    last = None
    while time.time() < deadline:
        status, text = http("GET", f"{LANGFUSE_BASE}/api/public/traces?limit=10",
                            headers={"Authorization": f"Basic {auth}"})
        if status == 200:
            data = json.loads(text).get("data", [])
            if data:
                last = data[0]
                if data[0].get("totalCost") not in (None, 0):
                    return data[0]
        time.sleep(2)
    return last


def main():
    print("[1/5] provision Langfuse (org/project/key/glm-5.2 price)")
    login_langfuse()
    sess = json.loads(http("GET", f"{LANGFUSE_BASE}/api/auth/session")[1])
    org_id = find_or_create_org(sess)
    proj_id = find_or_create_project(org_id)
    model_id = ensure_model_price(proj_id)
    public_key, secret_key = ensure_api_key(proj_id)
    print(f"    org: {org_id}")
    print(f"    project: {proj_id}")
    print(f"    model price: {model_id} ({LF_MODEL_NAME})")
    print(f"    api key (public): {public_key}")

    print(f"[2/5] create Flowise langfuseApi credential '{LF_CRED_NAME}'")
    cred_id = find_or_create_langfuse_credential(public_key, secret_key)
    print(f"    credential id: {cred_id}")

    print(f"[3/5] attach langFuse analytic to chatflow '{CHATFLOW_NAME}'")
    chatflow_id = find_chatflow()
    attach_analytic(chatflow_id, cred_id)
    print(f"    chatflow id: {chatflow_id}")

    print("[4/5] run one prediction")
    status, resp = run_prediction(chatflow_id)
    print(f"    HTTP {status}")
    print(f"    body: {(resp if isinstance(resp, str) else json.dumps(resp))[:300]}")
    if status != 200:
        sys.exit(1)

    print("[5/5] wait for Langfuse trace + token/cost")
    trace = wait_for_trace(public_key, secret_key)
    if not trace:
        print("  FAIL: no trace appeared in Langfuse", file=sys.stderr)
        sys.exit(1)
    print(f"    trace id: {trace.get('id')}")
    print(f"    name: {trace.get('name')}")
    print(f"    sessionId: {trace.get('sessionId')}")
    print(f"    totalCost: {trace.get('totalCost')}")
    print(f"    latency(s): {trace.get('latency')}")
    print(f"    trace URL: {LANGFUSE_BASE}{trace.get('htmlPath')}")

    cost = trace.get("totalCost")
    if cost in (None, 0):
        print("  FAIL: trace present but totalCost is 0 — model price not matched?",
              file=sys.stderr)
        sys.exit(1)
    print("\nACCEPTANCE: trace + token/cost visible in Langfuse ✓")


if __name__ == "__main__":
    main()
