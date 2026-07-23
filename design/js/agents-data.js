/* agents-data.js — sample agent records for agents.html + agent-detail.html
   Aligned to mil-agents v0.2 architecture (Agent / Agent Daemon / Run) and
   multica's detail-page field model (activity buckets / skills / instructions /
   visibility / concurrency / model / runtime / owner / created).
   status: running | queued | idle | failed | paused (list-level)
   availability: online | unstable | offline (detail-level presence) */
(function () {
  // 30-day activity buckets — each {total, ok, fail}; total runs per day.
  function buckets(spec) {
    // spec: array of [total, fail] pairs for the last N days (oldest→newest).
    // We pad to 30 days with leading zeros so the sparkline aligns across agents.
    const out = [];
    const lead = 30 - spec.length;
    for (let i = 0; i < lead; i++) out.push({ total: 0, ok: 0, fail: 0 });
    spec.forEach(([total, fail]) => out.push({ total, ok: total - fail, fail }));
    return out;
  }

  const NOW = '2026-07-09T06:32:00Z'; // stable timestamp (no Date.now in data)

  window.OD_AGENTS = [
    {
      id: 'agent_01HFK', name: '论文阅读 · reader-04', kind: 'claude', roles: ['reader', 'analysis'],
      status: 'running', availability: 'online',
      region: 'ap-northeast', daemon: 'daemon-09', run: 'R-8821', flow: 'flow-batch-reproduce',
      load: 78, cost: '$184.20', progress: 64, elapsed: '4m12s',
      inputSchema: '{pdf_uri, focus?}', outputSchema: '{summary, claims[], refs[]}',
      summary: '阅读论文并抽取核心论点、方法、可复现实验清单。支持跨域批量。',
      instructions: '你是一名资深科研阅读 agent。任务：阅读给定论文，抽取 (1) 核心论点 (2) 方法论 (3) 可复现实验清单 (4) 引用网络。输出结构化 JSON。若论文为跨域，显式标注领域差异。',
      skills: ['arxiv-parse', 'pdf-extract', 'claim-graph', 'zh/en-bilingual'],
      visibility: 'workspace', concurrency: 4, model: 'claude-sonnet-4',
      runtime: 'claude-code · daemon-09', owner: '林敏',
      created: '2026-05-12T03:20:00Z', lastActiveDays: 0,
      activity: buckets([[3,0],[5,0],[2,0],[6,0],[4,1],[7,0],[8,0],[5,0],[3,0],[6,0],[4,0],[5,1],[7,0],[9,0],[6,0]]),
      logs: [
        { t: '14:31', l: 'ok', m: 'claim extraction done · 14 claims' },
        { t: '14:30', l: 'info', m: 'parse arxiv 2407.1842' },
        { t: '14:28', l: 'info', m: 'task claimed from queue' },
      ],
    },
    {
      id: 'agent_02KDM', name: '代码复现 · coder-12', kind: 'claude', roles: ['coding', 'verify'],
      status: 'running', availability: 'online',
      region: 'us-east-1', daemon: 'daemon-02', run: 'R-8822', flow: 'flow-batch-reproduce',
      load: 91, cost: '$412.80', progress: 38, elapsed: '6m48s',
      inputSchema: '{repo_uri, target_exp}', outputSchema: '{patch, results, log}',
      summary: '基于论文实验描述生成复现代码补丁，在沙箱内执行并比对指标。',
      instructions: '你是一名复现工程 agent。任务：读取论文实验章节，生成最小可复现 patch，沙箱执行并比对论文报告指标。失败时输出 diff + 失败原因，不臆测。',
      skills: ['python', 'pytorch', 'sandbox-exec', 'git-diff', 'metrics-cmp'],
      visibility: 'workspace', concurrency: 2, model: 'claude-sonnet-4',
      runtime: 'claude-code · daemon-02', owner: '邓凯',
      created: '2026-05-20T11:00:00Z', lastActiveDays: 0,
      activity: buckets([[2,0],[4,1],[6,1],[3,0],[8,2],[5,0],[7,1],[4,0],[3,0],[6,0],[9,1],[5,0],[4,0]]),
      logs: [
        { t: '14:32', l: 'warn', m: 'sandbox memory 88%' },
        { t: '14:30', l: 'ok', m: 'env ready · cuda 12.2' },
        { t: '14:25', l: 'info', m: 'clone repo' },
      ],
    },
    {
      id: 'agent_03XPL', name: '假设验证 · verifier-07', kind: 'codex', roles: ['verify'],
      status: 'running', availability: 'unstable',
      region: 'eu-west-1', daemon: 'daemon-14', run: 'R-8823', flow: 'flow-hypothesis-check',
      load: 54, cost: '$96.40', progress: 72, elapsed: '2m01s',
      inputSchema: '{hypothesis, evidence[]}', outputSchema: '{verdict, confidence, refs}',
      summary: '对生成的假设逐一查证证据链，输出可信度与反例。',
      instructions: '你是假设验证 agent。对每个假设：检索证据 → 标注支持/反对 → 输出置信度与反例。置信度 < 0.5 必须给出反例，不得只输出结论。',
      skills: ['evidence-retrieval', 'confidence-score', 'counterexample'],
      visibility: 'workspace', concurrency: 3, model: 'o1',
      runtime: 'codex · daemon-14', owner: '林敏',
      created: '2026-05-28T09:15:00Z', lastActiveDays: 0,
      activity: buckets([[1,0],[2,0],[1,0],[3,0],[2,1],[1,0],[2,0],[4,1],[1,0],[3,0],[2,0]]),
      logs: [
        { t: '14:31', l: 'ok', m: 'hypothesis H3 verified · 0.81' },
        { t: '14:29', l: 'info', m: 'retrieval 28 docs' },
      ],
    },
    {
      id: 'agent_04RDR', name: '编排器 · orchestrator-01', kind: 'prompt', roles: ['orchestrator'],
      status: 'running', availability: 'online',
      region: 'us-west-2', daemon: '—', run: 'R-8820', flow: 'flow-batch-reproduce',
      load: 33, cost: '$22.10', progress: 51, elapsed: '8m33s',
      inputSchema: '{batch_goal, papers[]}', outputSchema: '{plan, dispatch[]}',
      summary: 'Condition Agent：拆解批量目标为子任务，按能力标签分派给专家 agent。',
      instructions: '你是编排 agent。任务：把批量目标拆解为可并行的子任务，按 capability tags 分派给专家 agent，监控子 run 完成度。遇到预算超限或失败率 > 20% 暂停并上报。',
      skills: ['task-decompose', 'capability-match', 'budget-guard', 'fan-out'],
      visibility: 'public', concurrency: 1, model: 'claude-opus-4',
      runtime: 'flowise-native', owner: '饶哲',
      created: '2026-04-01T08:00:00Z', lastActiveDays: 0,
      activity: buckets([[5,0],[8,0],[6,0],[9,0],[7,0],[10,0],[8,0],[6,0],[9,0],[7,0],[8,0],[11,0],[9,0],[6,0],[7,0],[8,0]]),
      logs: [
        { t: '14:30', l: 'ok', m: 'dispatched 12 sub-runs' },
        { t: '14:20', l: 'info', m: 'plan generated' },
      ],
    },
    {
      id: 'agent_05LAB', name: '数据清洗 · etl-22', kind: 'codex', roles: ['coding'],
      status: 'queued', availability: 'offline',
      region: 'ap-southeast', daemon: 'daemon-21', run: '—', flow: '—',
      load: 0, cost: '$48.30', progress: 0, elapsed: '排队 2m',
      inputSchema: '{dataset_uri, schema}', outputSchema: '{clean_uri, stats}',
      summary: '对原始数据集做去重、缺失值、类型规范化的 ETL。',
      instructions: '你是 ETL agent。对数据集做去重、缺失值插补、类型规范化，输出清洗后 URI 与统计。不得修改原始数据。',
      skills: ['pandas', 'dedupe', 'type-coerce', 'missing-impute'],
      visibility: 'workspace', concurrency: 2, model: 'qwen2.5-coder',
      runtime: 'codex · daemon-21', owner: '邓凯',
      created: '2026-06-05T14:00:00Z', lastActiveDays: 3,
      activity: buckets([[2,0],[1,0],[3,0],[1,0],[2,0],[0,0],[0,0],[0,0]]),
      logs: [{ t: '14:25', l: 'info', m: 'queued behind R-8819' }],
    },
    {
      id: 'agent_06TRC', name: '追踪溯源 · tracer-03', kind: 'prompt', roles: ['reader', 'verify'],
      status: 'queued', availability: 'offline',
      region: 'us-east-1', daemon: '—', run: '—', flow: 'flow-hypothesis-check',
      load: 0, cost: '$15.20', progress: 0, elapsed: '排队 4m',
      inputSchema: '{claim, scope}', outputSchema: '{source_uri, verdict}',
      summary: '为单条论断溯源原始文献并给出支持/反对判断。',
      instructions: '你是溯源 agent。对单条 claim 检索原始文献，标注支持/反对/部分支持，输出 source_uri 与 verdict。找不到原始来源时输出 unknown，不得猜测。',
      skills: ['citation-trace', 'verdict', 'unknown-safe'],
      visibility: 'workspace', concurrency: 4, model: 'gpt-4o-mini',
      runtime: 'flowise-native', owner: '林敏',
      created: '2026-06-10T10:30:00Z', lastActiveDays: 2,
      activity: buckets([[1,0],[1,0],[2,0],[1,0],[0,0],[1,0]]),
      logs: [{ t: '14:22', l: 'info', m: 'queued' }],
    },
    {
      id: 'agent_07EDT', name: '摘要撰写 · writer-09', kind: 'prompt', roles: ['reader'],
      status: 'idle', availability: 'offline',
      region: 'ap-east-1', daemon: '—', run: '—', flow: '—',
      load: 0, cost: '$33.80', progress: 0, elapsed: '—',
      inputSchema: '{docs[], style}', outputSchema: '{markdown}',
      summary: '把多篇论文摘要整合成统一风格的综述段落。',
      instructions: '你是综述撰写 agent。把多篇论文摘要整合成统一风格段落，保留引用编号，不添加原文未提及的结论。',
      skills: ['multi-doc-merge', 'style-unify', 'citation-keep'],
      visibility: 'workspace', concurrency: 6, model: 'gpt-4o',
      runtime: 'flowise-native', owner: '饶哲',
      created: '2026-05-01T09:00:00Z', lastActiveDays: 8,
      activity: buckets([[2,0],[1,0],[3,0],[0,0],[0,0],[0,0],[0,0]]),
      logs: [{ t: '13:50', l: 'ok', m: 'last run completed' }],
    },
    {
      id: 'agent_08GPU', name: 'GPU 实验 · trainer-02', kind: 'remote', roles: ['coding', 'verify'],
      status: 'idle', availability: 'offline',
      region: 'us-west-2', daemon: 'gpu-box-1', run: '—', flow: '—',
      load: 0, cost: '$120.50', progress: 0, elapsed: '—',
      inputSchema: '{script_uri, epochs}', outputSchema: '{ckpt, metrics}',
      summary: '在带 GPU 的远程 daemon 上执行训练/评估脚本并回收指标。',
      instructions: '你是 GPU 实验 agent。在远程 daemon 执行训练脚本，回收 loss/metrics，输出 ckpt URI 与指标。OOM 时降 batch size 重试一次，仍失败则上报。',
      skills: ['cuda', 'pytorch-train', 'ckpt-save', 'oom-retry'],
      visibility: 'workspace', concurrency: 1, model: 'llama-3.1-70b',
      runtime: 'vllm · gpu-box-1', owner: '邓凯',
      created: '2026-03-15T12:00:00Z', lastActiveDays: 14,
      activity: buckets([[1,0],[0,0],[1,0],[0,0]]),
      logs: [{ t: '12:10', l: 'ok', m: 'cuda idle · 0% util' }],
    },
    {
      id: 'agent_09HIT', name: '人工审核 · hitl-gate', kind: 'prompt', roles: ['verify'],
      status: 'paused', availability: 'offline',
      region: 'eu-west-1', daemon: '—', run: 'R-8819', flow: 'flow-publish-gate',
      load: 0, cost: '$8.40', progress: 100, elapsed: '等待 14m',
      inputSchema: '{draft, policy}', outputSchema: '{approved, notes}',
      summary: 'Human Input 节点：在发布前等待人工确认，检查点持久化可跨重启恢复。',
      instructions: '你是 HITL 门控节点。等待人工审批，通过则放行，拒绝则回退。检查点持久化到 Redis，可跨重启恢复。',
      skills: ['hitl-checkpoint', 'redis-resume', 'approve/reject'],
      visibility: 'public', concurrency: 1, model: 'gpt-4o-mini',
      runtime: 'flowise-native', owner: '饶哲',
      created: '2026-06-18T16:00:00Z', lastActiveDays: 0,
      activity: buckets([[1,0],[1,0],[0,0],[1,0]]),
      logs: [
        { t: '14:20', l: 'ok', m: 'approval received' },
        { t: '14:06', l: 'info', m: 'paused · awaiting human' },
      ],
    },
    {
      id: 'agent_10SNT', name: '安全扫描 · scanner-05', kind: 'codex', roles: ['verify'],
      status: 'paused', availability: 'offline',
      region: 'us-east-1', daemon: 'daemon-02', run: 'R-8818', flow: 'flow-publish-gate',
      load: 0, cost: '$19.70', progress: 100, elapsed: '等待 6m',
      inputSchema: '{patch}', outputSchema: '{findings, severity}',
      summary: '对代码补丁做依赖与提示词注入扫描，命中则阻断流程。',
      instructions: '你是安全扫描 agent。对 patch 做依赖漏洞与提示词注入扫描，命中 critical 阻断流程并上报。不得自动放行 critical。',
      skills: ['dep-scan', 'prompt-injection-detect', 'severity-classify'],
      visibility: 'workspace', concurrency: 2, model: 'qwen2.5-coder',
      runtime: 'codex · daemon-02', owner: '林敏',
      created: '2026-06-22T11:00:00Z', lastActiveDays: 0,
      activity: buckets([[2,0],[1,0],[1,0],[0,0]]),
      logs: [{ t: '14:14', l: 'warn', m: '1 advisory found · paused' }],
    },
    {
      id: 'agent_11ERR', name: '网页抓取 · fetcher-18', kind: 'remote', roles: ['reader'],
      status: 'failed', availability: 'offline',
      region: 'sa-east-1', daemon: 'daemon-31', run: 'R-8815', flow: 'flow-batch-reproduce',
      load: 0, cost: '$4.20', progress: 12, elapsed: '失败 18m 前',
      inputSchema: '{url}', outputSchema: '{html, status}',
      summary: '抓取给定 URL 并清洗为正文 HTML，带重试与限流。',
      instructions: '你是抓取 agent。抓取 URL 清洗为正文 HTML。超时重试 3 次，仍失败则上报错误码，不返回部分内容。',
      skills: ['http-fetch', 'readability', 'retry-3', 'rate-limit'],
      visibility: 'workspace', concurrency: 8, model: 'gpt-4o-mini',
      runtime: 'remote · daemon-31', owner: '邓凯',
      created: '2026-06-25T15:00:00Z', lastActiveDays: 0,
      activity: buckets([[4,0],[3,1],[2,1],[1,1],[0,0]]),
      logs: [
        { t: '14:14', l: 'err', m: 'timeout · 3 retries exhausted' },
        { t: '14:02', l: 'warn', m: 'slow response 8s' },
      ],
    },
    {
      id: 'agent_12EXP', name: '实验报告 · reporter-06', kind: 'claude', roles: ['reader', 'coding'],
      status: 'failed', availability: 'offline',
      region: 'ap-northeast', daemon: 'daemon-09', run: 'R-8810', flow: 'flow-batch-reproduce',
      load: 0, cost: '$67.90', progress: 88, elapsed: '失败 32m 前',
      inputSchema: '{runs[], template}', outputSchema: '{report_md}',
      summary: '聚合多个子 run 的结果生成结构化实验报告。',
      instructions: '你是报告 agent。聚合子 run 结果，按模板生成结构化实验报告。缺失子 run 输出时标注 N/A，不得编造数据。',
      skills: ['multi-run-agg', 'template-fill', 'na-safe'],
      visibility: 'workspace', concurrency: 2, model: 'claude-sonnet-4',
      runtime: 'claude-code · daemon-09', owner: '林敏',
      created: '2026-05-05T13:00:00Z', lastActiveDays: 0,
      activity: buckets([[3,0],[2,1],[4,1],[1,1],[0,0]]),
      logs: [
        { t: '13:42', l: 'err', m: 'render failed · missing R-8807 output' },
        { t: '13:30', l: 'info', m: 'gathered 11 runs' },
      ],
    },
  ];

  // helper: total runs in last 30 days for a row
  window.OD_AGENTS.forEach(a => {
    a.runCount = a.activity.reduce((s, b) => s + b.total, 0);
    a.failCount = a.activity.reduce((s, b) => s + b.fail, 0);
  });

  window.OD_NOW = NOW;
})();
