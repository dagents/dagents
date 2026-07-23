/* lab-data.js — sample Lab sessions + threaded messages for lab.html */
(function () {
  window.OD_LAB_SESSIONS = [
    { name:'RL 论文复现 · skip-connect 替代 attention', desc:'对比 skip-connection 与 baseline attention 在 PPO 上的收敛差异', status:'running', agents:4 },
    { name:'多模态对齐假设验证', desc:'验证 image-text 对齐损失是否对噪声标签鲁棒', status:'running', agents:3 },
    { name:'营销文案 A/B 假设生成', desc:'3 个 agent 为同一产品生成对立假设并自评', status:'paused', agents:3 },
    { name:'代码迁移 · TF→PyTorch', desc:'把 4 个 TF 模型迁移到 PyTorch 并对齐数值', status:'done', agents:2 },
    { name:'跨域论文综述', desc:'reader 抽取 32 篇跨域论文的共性方法', status:'done', agents:2 },
  ];

  window.OD_LAB_MESSAGES = [
    { role:'human', initial:'H', name:'你', roleTag:'人工介入', time:'14:20',
      body:'<p>复现 arxiv 2407.1842 的 PPO 实验。重点：attention 层能否被 skip-connection 替代而不掉点。</p>' },
    { role:'orchestrator', initial:'O', name:'orchestrator-01', roleTag:'@orchestrator', time:'14:20',
      body:'<p>已拆解为 3 个子任务并分派：</p><p>1) <code>@reader</code> 抽取论文中 attention 与 skip-connect 的实验描述<br/>2) <code>@coder</code> 在 baseline 上实现 skip-connect 变体<br/>3) <code>@verifier</code> 设计对照与显著性检验</p>',
      thinking:'用户要的是「能否替代」，需要对照实验而非单点复现。先读再改再验。' },
    { role:'reader', initial:'R', name:'reader-04', roleTag:'@reader · reader', time:'14:24',
      body:'<p>论文 §3.2 用 8 层 attention；附录 D 提到 skip-connect 作为消融但未报告完整曲线。核心论点：attention 主要贡献在深层。</p>',
      tool:{ name:'read_paper', input:'arxiv 2407.1842 §3.2, App.D', output:'{claims:[14], ablation_gap: "未报告"}' } },
    { role:'coder', initial:'C', name:'coder-12', roleTag:'@coder · coding', time:'14:31',
      body:'<p>已实现 <code>SkipConnectBlock</code> 替换 <code>AttentionLayer</code>，保持参数量一致。沙箱跑通前向。</p>',
      tool:{ name:'run_sandbox', input:'ppo_skip.py --epochs 3', output:'forward ok · loss=2.14 · 1.2s/step' } },
    { role:'verifier', initial:'V', name:'verifier-07', roleTag:'@verifier · verify', time:'14:32',
      body:'<p>提出对照矩阵：4 层 vs 8 层 × baseline vs skip。需要 4 组 run。建议先验 H1（等效）和 H3（收敛更快）。</p>',
      thinking:'论文只说深层更重要，没说替换后等效——这是 H1 的来源；收敛更快是我的推测 H3。' },
    { role:'orchestrator', initial:'O', name:'orchestrator-01', roleTag:'@orchestrator', time:'14:33',
      body:'<p>同意。批 4 组 run，并发 4。预算上限 $18。结果写入产物面板 H1/H3。</p>' },
    { role:'coder', initial:'C', name:'coder-12', roleTag:'@coder · coding', time:'14:40',
      body:'<p>4 组 run 完成。skip 在 4 层上掉点明显（−3.2 reward），8 层上接近持平（−0.4）。</p>',
      tool:{ name:'eval_compare', input:'4 runs · 128 episodes each', output:'skip_4: 41.2 | base_4: 44.4 | skip_8: 52.1 | base_8: 52.5' } },
    { role:'verifier', initial:'V', name:'verifier-07', roleTag:'@verifier · verify', time:'14:41',
      body:'<p>H1 部分支持：深层可替代，浅层不可。H3 反驳：skip 收敛反而慢约 8%。已更新置信度。</p>',
      thinking:'−0.4 在噪声范围内，需要更多 seed；但 −3.2 是显著的。保守结论。' },
    { role:'orchestrator', initial:'O', name:'orchestrator-01', roleTag:'@orchestrator', time:'14:42',
      body:'<p>结论收敛。建议：深层用 skip 减参，浅层保留 attention。是否要我生成最终报告与可复现 artifact？</p>' },
  ];
})();
