/* tokens-data.js — sample new-api tokens for settings.html tab-keys
   Fields aligned to new-api token model:
     id, name, key (sk-newapi-...), group, used/total (quota points),
     expiredAt (ISO|null), models (csv|null), remark, isDefault,
     status (active|disabled), createdAt.
   effective status = disabled if status==='disabled'; expired if past
   expiredAt; otherwise active. */
(function () {
  window.OD_TOKENS = [
    { id:'tok_a1b2c3', name:'论文复现-生产', key:'sk-newapi-4f8a92c1d7e6b3a09f12', group:'prod',
      used:312000, total:500000, expiredAt:null,
      models:'claude-sonnet-4,gpt-4o', remark:'flow_repro_01 主令牌，绑定生产渠道组', isDefault:true,
      status:'active', createdAt:'2026-05-12T03:20:00Z' },
    { id:'tok_d4e5f6', name:'多模态对齐-实验', key:'sk-newapi-7c2b9e8410a5f3d6c1b8', group:'research',
      used:84000, total:300000, expiredAt:'2026-09-30T23:59:00Z',
      models:null, remark:'Lab 实验组共享，9 月底到期', isDefault:false,
      status:'active', createdAt:'2026-06-01T08:10:00Z' },
    { id:'tok_g7h8i9', name:'营销文案-外部', key:'sk-newapi-1a8f5d2c9b6e4037f8a1', group:'external',
      used:460000, total:500000, expiredAt:'2026-08-15T23:59:00Z',
      models:'gpt-4o-mini,gemini-2.5-flash', remark:'外部合作方使用，额度接近上限', isDefault:false,
      status:'active', createdAt:'2026-07-01T10:00:00Z' },
    { id:'tok_j1k2l3', name:'编排器-内部', key:'sk-newapi-9e3c7b1a6f4d0852e7c4', group:'default',
      used:0, total:null, expiredAt:null,
      models:null, remark:'orchestrator-01 默认调用令牌，无限额度', isDefault:false,
      status:'active', createdAt:'2026-04-20T12:00:00Z' },
    { id:'tok_m4n5o6', name:'开发沙箱', key:'sk-newapi-2b9e8f4a1c7d3056b8e2', group:'dev',
      used:128000, total:200000, expiredAt:'2026-08-01T23:59:00Z',
      models:'claude-sonnet-4,gpt-4o-mini,o1', remark:'本地调试用，额度较小', isDefault:false,
      status:'active', createdAt:'2026-06-15T14:30:00Z' },
    { id:'tok_p7q8r9', name:'旧版-待轮换', key:'sk-newapi-6d1a9c8f0e2b4753a1d7', group:'prod',
      used:0, total:200000, expiredAt:'2026-07-01T23:59:00Z',
      models:'gpt-4o', remark:'已过期，待删除轮换', isDefault:false,
      status:'active', createdAt:'2026-03-10T09:00:00Z' },
    { id:'tok_s1t2u3', name:'验证器专用', key:'sk-newapi-8f5d2b9c4a1e7063e8f0', group:'research',
      used:96000, total:300000, expiredAt:null,
      models:'o1,claude-opus-4', remark:'verifier 角色专用，仅推理模型', isDefault:false,
      status:'disabled', createdAt:'2026-05-28T11:20:00Z' },
    { id:'tok_v4w5x6', name:'Webhook-入站', key:'sk-newapi-3c8b6e0f4a9d1275b6c1', group:'external',
      used:21000, total:100000, expiredAt:'2026-12-31T23:59:00Z',
      models:'gpt-4o-mini', remark:'外部系统 webhook 触发用', isDefault:false,
      status:'active', createdAt:'2026-06-20T16:45:00Z' },
  ];
})();
