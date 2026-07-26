/* flows-data.js — sample Agentflow V2 DAGs for agentflows.html
   Each flow has nodes (with x/y/w/h/type/status) and edges.
   Node types from v0.2 §4.2: Agent / LLM / Tool / HTTP / Condition /
   Condition Agent / Iteration / Loop / Human Input / Direct Reply /
   Custom Function / Execute Flow / Start / Retriever.
   Status: running | done | queued | failed | paused | idle */
(function () {
  const W = 150, H = 44, GAP_X = 70;
  function col(c) { return 20 + c * (W + GAP_X); }

  window.OD_FLOWS = [
    {
      id: 'flow_repro_01', name: '论文批量复现流水线', version: 'v2.3.1', hash: '7a3f9c',
      status: 'running', run: 'R-8821', nodes: 9,
      nodes: [
        { id:'n1', type:'Start', label:'开始', sub:'batch · 128 篇', x:col(0), y:200, w:120, h:H, status:'done', runId:'R-8821', duration:'0.1s', input:'{papers[], focus}', output:'dispatched', logs:[{t:'14:00',l:'ok',m:'batch started · 128 papers'}] },
        { id:'n2', type:'Iteration', label:'fan-out', sub:'for-each paper', x:col(1), y:200, w:120, h:H, status:'running', runId:'R-8821', duration:'4m+', input:'papers[]', output:'sub-runs[]', logs:[{t:'14:01',l:'info',m:'parallel fan-out · concurrency 12'}] },
        { id:'n3', type:'Agent', label:'reader-04', sub:'论文阅读', x:col(2), y:120, w:W, h:H, status:'running', runId:'R-8821', duration:'4m12s', agent:'agent_01HFK', budget:'$2/run', tokens:'18.4K', cost:'$1.20', timeout:'300s', input:'{pdf_uri, focus}', output:'{summary, claims[]}', logs:[{t:'14:31',l:'ok',m:'14 claims extracted'},{t:'14:28',l:'info',m:'parse arxiv 2407.1842'}] },
        { id:'n4', type:'Agent', label:'coder-12', sub:'代码复现', x:col(2), y:200, w:W, h:H, status:'running', runId:'R-8822', duration:'6m48s', agent:'agent_02KDM', budget:'$8/run', tokens:'42.1K', cost:'$4.80', timeout:'900s', input:'{repo, target_exp}', output:'{patch, results}', logs:[{t:'14:32',l:'warn',m:'sandbox mem 88%'},{t:'14:25',l:'info',m:'clone repo'}] },
        { id:'n5', type:'Agent', label:'fetcher-18', sub:'网页抓取', x:col(2), y:280, w:W, h:H, status:'failed', runId:'R-8815', duration:'超时', agent:'agent_11ERR', budget:'$0.5/run', tokens:'1.2K', cost:'$0.04', timeout:'60s', input:'{url}', output:'timeout', logs:[{t:'14:14',l:'err',m:'timeout · 3 retries'}] },
        { id:'n6', type:'Condition', label:'结果分支', sub:'success?', x:col(3), y:200, w:120, h:H, status:'idle', input:'{results}', output:'branch', logs:[] },
        { id:'n7', type:'Agent', label:'verifier-07', sub:'假设验证', x:col(4), y:120, w:W, h:H, status:'queued', runId:'—', agent:'agent_03XPL', budget:'$1.5/run', tokens:'—', cost:'—', timeout:'600s', input:'{hypothesis, evidence[]}', output:'—', logs:[{t:'14:25',l:'info',m:'queued'}] },
        { id:'n8', type:'Agent', label:'reporter-06', sub:'实验报告', x:col(4), y:280, w:W, h:H, status:'failed', runId:'R-8810', duration:'失败', agent:'agent_12EXP', budget:'$3/run', tokens:'31.0K', cost:'$2.10', timeout:'600s', input:'{runs[]}', output:'missing R-8807', logs:[{t:'13:42',l:'err',m:'render failed'}] },
        { id:'n9', type:'Direct Reply', label:'结束', sub:'归档 artifact', x:col(5), y:200, w:120, h:H, status:'idle', input:'{report}', output:'—', logs:[] },
      ],
      edges: [
        { from:'n1', to:'n2' },
        { from:'n2', to:'n3', label:'paper' },
        { from:'n2', to:'n4', label:'paper' },
        { from:'n2', to:'n5', label:'ref url' },
        { from:'n3', to:'n6' },
        { from:'n4', to:'n6' },
        { from:'n5', to:'n6', label:'on err' },
        { from:'n6', to:'n7', label:'ok' },
        { from:'n6', to:'n8', label:'fail' },
        { from:'n7', to:'n9' },
        { from:'n8', to:'n9' },
      ],
    },
    {
      id: 'flow_hypo_02', name: '假设生成与验证', version: 'v1.8.0', hash: '3b21e7',
      status: 'running', run: 'R-8823', nodes: 6,
      nodes: [
        { id:'h1', type:'Start', label:'开始', sub:'claim input', x:col(0), y:200, w:120, h:H, status:'done', runId:'R-8823', duration:'0.1s', input:'{claim}', output:'ok', logs:[{t:'14:20',l:'ok',m:'start'}] },
        { id:'h2', type:'Retriever', label:'证据检索', sub:'vector + web', x:col(1), y:200, w:W, h:H, status:'done', runId:'R-8823', duration:'2.1s', input:'{claim}', output:'28 docs', logs:[{t:'14:20',l:'ok',m:'28 docs retrieved'}] },
        { id:'h3', type:'Agent', label:'orchestrator-01', sub:'生成假设', x:col(2), y:200, w:W, h:H, status:'running', runId:'R-8823', duration:'1m40s', agent:'agent_04RDR', budget:'$1/run', tokens:'12.0K', cost:'$0.80', timeout:'300s', input:'{claim, docs}', output:'hypotheses[]', logs:[{t:'14:29',l:'info',m:'5 hypotheses drafted'}] },
        { id:'h4', type:'Iteration', label:'逐条验证', sub:'for-each H', x:col(3), y:200, w:120, h:H, status:'queued', input:'hypotheses[]', output:'verdicts[]', logs:[] },
        { id:'h5', type:'Agent', label:'verifier-07', sub:'证据查证', x:col(4), y:200, w:W, h:H, status:'queued', runId:'—', agent:'agent_03XPL', budget:'$1.5/run', tokens:'—', cost:'—', timeout:'600s', input:'{hypothesis}', output:'—', logs:[] },
        { id:'h6', type:'Direct Reply', label:'报告', sub:'置信度汇总', x:col(5), y:200, w:120, h:H, status:'idle', input:'{verdicts}', output:'—', logs:[] },
      ],
      edges: [
        { from:'h1', to:'h2' },
        { from:'h2', to:'h3' },
        { from:'h3', to:'h4' },
        { from:'h4', to:'h5', label:'H' },
        { from:'h5', to:'h6' },
      ],
    },
    {
      id: 'flow_gate_03', name: '发布门控（HITL）', version: 'v1.2.4', hash: 'c9014d',
      status: 'paused', run: 'R-8819', nodes: 6,
      nodes: [
        { id:'g1', type:'Start', label:'提交', sub:'draft PR', x:col(0), y:200, w:120, h:H, status:'done', runId:'R-8819', duration:'0.1s', input:'{patch}', output:'ok', logs:[{t:'14:00',l:'ok',m:'PR submitted'}] },
        { id:'g2', type:'Agent', label:'scanner-05', sub:'安全扫描', x:col(1), y:140, w:W, h:H, status:'paused', runId:'R-8818', duration:'1m02s', agent:'agent_10SNT', budget:'$0.5/run', tokens:'6.0K', cost:'$0.30', timeout:'300s', input:'{patch}', output:'1 advisory', logs:[{t:'14:14',l:'warn',m:'1 advisory · paused'}] },
        { id:'g3', type:'Agent', label:'tester-02', sub:'单测覆盖', x:col(1), y:260, w:W, h:H, status:'done', runId:'R-8817', duration:'3m20s', agent:'agent_02KDM', budget:'$2/run', tokens:'24.0K', cost:'$1.40', timeout:'900s', input:'{patch}', output:'coverage 88%', logs:[{t:'14:08',l:'ok',m:'coverage 88%'}] },
        { id:'g4', type:'Human Input', label:'人工审核', sub:'awaiting approval', x:col(2), y:200, w:W, h:H, status:'paused', runId:'R-8819', duration:'等待 14m', agent:'agent_09HIT', budget:'—', tokens:'—', cost:'—', timeout:'手动', input:'{draft, scan, tests}', output:'awaiting', logs:[{t:'14:06',l:'info',m:'paused · awaiting human'},{t:'14:20',l:'ok',m:'approval received'}] },
        { id:'g5', type:'Condition', label:'通过?', sub:'gate', x:col(3), y:200, w:120, h:H, status:'idle', input:'{approved}', output:'—', logs:[] },
        { id:'g6', type:'HTTP', label:'dispatch', sub:'→ 中央 dispatch', x:col(4), y:200, w:W, h:H, status:'idle', input:'{release}', output:'—', logs:[] },
      ],
      edges: [
        { from:'g1', to:'g2' },
        { from:'g1', to:'g3' },
        { from:'g2', to:'g4' },
        { from:'g3', to:'g4' },
        { from:'g4', to:'g5' },
        { from:'g5', to:'g6', label:'approved' },
      ],
    },
  ];
})();
