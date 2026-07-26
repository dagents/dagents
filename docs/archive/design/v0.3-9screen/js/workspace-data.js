/* workspace-data.js — sample projects + per-project chat threads */
(function () {
  window.OD_WS_PROJECTS = [
    { key:'rl', glyph:'R', name:'论文复现 · RL', meta:'flow_repro_01 · 24 成员', status:'running', unread:5, sub:'24 成员 · 关联 flow flow_repro_01 · 今日 18 条消息' },
    { key:'align', glyph:'A', name:'多模态对齐', meta:'flow_hypo_02 · 8 成员', status:'running', unread:2, sub:'8 成员 · 关联 flow_hypo_02 · 今日 6 条消息' },
    { key:'mkt', glyph:'M', name:'营销文案实验', meta:'无关联 flow · 4 成员', status:'idle', unread:0, sub:'4 成员 · 独立项目 · 昨日 3 条消息' },
    { key:'migrate', glyph:'T', name:'TF→PyTorch 迁移', meta:'flow_repro_01 · 6 成员', status:'idle', unread:0, sub:'6 成员 · 已完成 · 3 天前' },
    { key:'survey', glyph:'S', name:'跨域论文综述', meta:'flow_hypo_02 · 12 成员', status:'idle', unread:1, sub:'12 成员 · 已完成 · 1 周前' },
  ];

  window.OD_WS_THREADS = {
    rl: [
      { day:'今天', role:'human', initial:'RZ', name:'饶哲', time:'14:20', run:'R-8821',
        body:'<p>这批 128 篇 RL 论文按计划复现。重点跑 attention vs skip-connect 的对照。</p>' },
      { role:'bot', initial:'O', name:'orchestrator-01', time:'14:21', run:'R-8821',
        body:'<p>已派发。reader-04 抽取消融描述，coder-12 实现变体，verifier-07 设计对照。预算 $18。</p>' },
      { role:'bot', initial:'V', name:'verifier-07', time:'14:41', run:'R-8823',
        body:'<p>H1 部分支持：深层可替代（−0.4 reward），浅层不可（−3.2）。H3 反驳。已写入产物。</p>',
        attach:['results_skip.csv','results_baseline.csv'] },
      { day:'昨天', role:'human', initial:'LM', name:'林敏', time:'17:02',
        body:'<p>下一批换成 offline RL 的论文集，预算加到 $30。</p>' },
      { role:'bot', initial:'O', name:'orchestrator-01', time:'17:05', run:'R-8801',
        body:'<p>已更新 batch 配置。下一批 64 篇，预算 $30，预计 2h 完成。</p>' },
    ],
    align: [
      { day:'今天', role:'human', initial:'DK', name:'邓凯', time:'11:30', run:'R-8701',
        body:'<p>验证对齐损失对 10% 噪声标签的鲁棒性。</p>' },
      { role:'bot', initial:'V', name:'verifier-07', time:'11:48', run:'R-8702',
        body:'<p>10% 噪声下对齐损失下降 4%，baseline 下降 11%。鲁棒性假设成立。</p>' },
      { role:'human', initial:'RZ', name:'饶哲', time:'11:50',
        body:'<p>加一组 20% 噪声的对照。</p>' },
      { role:'bot', initial:'O', name:'orchestrator-01', time:'11:51',
        body:'<p>已派发，预计 30 分钟出结果。</p>' },
    ],
    mkt: [
      { day:'昨天', role:'human', initial:'RZ', name:'饶哲', time:'16:00',
        body:'<p>为新产品写 3 版对立假设的文案。</p>' },
      { role:'bot', initial:'O', name:'orchestrator-01', time:'16:01',
        body:'<p>3 版已生成，等待你的评审。</p>' },
    ],
    migrate: [
      { day:'3 天前', role:'bot', initial:'C', name:'coder-12', time:'10:20', run:'R-8600',
        body:'<p>4 个 TF 模型全部迁移完成，数值对齐误差 &lt; 1e-5。</p>',
        attach:['migration_report.md'] },
      { role:'human', initial:'RZ', name:'饶哲', time:'10:25',
        body:'<p>归档。</p>' },
    ],
    survey: [
      { day:'1 周前', role:'bot', initial:'R', name:'reader-04', time:'09:00', run:'R-8500',
        body:'<p>32 篇跨域论文综述完成，提取 7 类共性方法。</p>',
        attach:['survey_v1.md'] },
    ],
  };
})();
