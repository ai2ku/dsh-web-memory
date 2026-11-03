// dsh-web-memory 插件 · 前端（左侧独立页面 + 设置）
// 注册「记忆」左侧导航项（像插件市场），点击打开独立设置页。
// 参照 dshmarket（sidebar.panellist + main 双注册）和 dsh-qq-bridge（window.__ModuleLoader__）。
window.__ModuleLoader__.load({
  id: 'dsh-web-memory',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // 相对路径：DSH 部署在子路径时由 <base href> 自动补前缀
    const apiUrl = (p) => new URL('dsh-web-memory/' + p, document.baseURI).href;

    // ── 图标（记忆）──
    const Icon = ({ size = 16 }) => h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size } },
      h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M12 2a7 7 0 0 0-7 7c0 2.5 1.5 4.5 3 6v3h8v-3c1.5-1.5 3-3.5 3-6a7 7 0 0 0-7-7z' }),
        h('path', { d: 'M9 21h6' }),
      ));

    // ── 设置页主体 ──
    function Panel() {
      const [health, setHealth] = React.useState(null);
      const [err, setErr] = React.useState('');
      const [tab, setTab] = React.useState('overview');
      const [cfg, setCfg] = React.useState(null);
      const [cfgErr, setCfgErr] = React.useState('');
      const [cfgSaving, setCfgSaving] = React.useState(false);
      const [cfgSaved, setCfgSaved] = React.useState('');
      const [rebuildJob, setRebuildJob] = React.useState(null); // 重建任务状态（进行中/进度）
      const [rebuildErr, setRebuildErr] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        fetch(apiUrl('health'), { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => { if (alive) setHealth(d); })
          .catch((e) => { if (alive) setErr(String(e?.message || e)); });
        return () => { alive = false; };
      }, []);

      React.useEffect(() => {
        let alive = true;
        fetch(apiUrl('config'), { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => { if (alive) { if (d.ok) setCfg(d.config); else setCfgErr(String(d.error || '加载失败')); } })
          .catch((e) => { if (alive) setCfgErr(String(e?.message || e)); });
        return () => { alive = false; };
      }, []);

      // 重建进行中：每 3 秒查一次进度
      React.useEffect(() => {
        if (!rebuildJob || rebuildJob.status === 'finished' || rebuildJob.status === 'error') return;
        const timer = setInterval(() => {
          fetch(apiUrl('rebuild'), { headers: { accept: 'application/json' } })
            .then((r) => r.json())
            .then((d) => {
              if (!d.ok) { setRebuildJob((j) => j ? { ...j, status: 'error', error: String(d.error || '查询失败') } : j); return; }
              const j = d.job;
              if (!j) { setRebuildJob((old) => ({ ...old, status: 'finished', chunks: old?.chunks })); return; }
              if (j.finished_at) setRebuildJob({ ...j, status: 'finished' });
              else if (j.error) setRebuildJob({ ...j, status: 'error', error: j.error });
              else setRebuildJob(j);
            })
            .catch((e) => { setRebuildJob((j) => j ? { ...j, status: 'error', error: String(e?.message || e) } : j); });
        }, 3000);
        return () => clearInterval(timer);
      }, [rebuildJob]);

      const saveCfg = (patch) => {
        setCfgSaving(true); setCfgSaved('');
        fetch(apiUrl('config'), {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ config: patch }),
        })
          .then((r) => r.json())
          .then((d) => {
            setCfgSaving(false);
            if (d.ok) { setCfgSaved('已保存'); setCfg((c) => c ? { ...c, ...patch } : c); }
            else setCfgErr(String(d.error || '保存失败'));
          })
          .catch((e) => { setCfgSaving(false); setCfgErr(String(e?.message || e)); });
      };

      // 触发全量重建索引（容器后台任务），轮询进度
      const startRebuild = () => {
        if (!window.confirm('全量重建会清空向量索引并从存档重新生成，期间语义检索暂时降级为关键词检索。确定？')) return;
        setRebuildErr(''); setRebuildJob({ status: 'starting' });
        fetch(apiUrl('rebuild'), { method: 'POST', headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) { setRebuildErr(String(d.error || '重建失败')); setRebuildJob(null); return; }
            setRebuildJob(d.job || { status: 'running' });
          })
          .catch((e) => { setRebuildErr(String(e?.message || e)); setRebuildJob(null); });
      };

      // 立即索引（增量：只处理新消息，不清空）
      const [indexMsg, setIndexMsg] = React.useState('');
      const startIndex = () => {
        setIndexMsg('索引中…');
        fetch(apiUrl('index'), { method: 'POST', headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) { setIndexMsg('索引失败：' + String(d.error || '')); return; }
            const res = d.result || {};
            if (res.skipped) setIndexMsg(String(res.skipped));
            else if (res.error) setIndexMsg('索引出错：' + res.error);
            else setIndexMsg(`已索引，新增 ${res.chunks ?? 0} 块`);
          })
          .catch((e) => { setIndexMsg('索引失败：' + String(e?.message || e)); });
      };

      // 人格重新提炼：propose（从角色卡提炼出厂值）→ 确认 → confirm（写入 core）
      const [factory, setFactory] = React.useState(null);
      const [factoryErr, setFactoryErr] = React.useState('');
      const [proposing, setProposing] = React.useState(false);
      const [confirming, setConfirming] = React.useState(false);
      const [factoryMsg, setFactoryMsg] = React.useState('');
      const [roles, setRoles] = React.useState([]);
      const [selectedRole, setSelectedRole] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        fetch(apiUrl('persona/roles'), { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => { if (alive && d.ok) setRoles(d.roles || []); })
          .catch(() => {});
        return () => { alive = false; };
      }, []);
      const proposeFactory = () => {
        if (!window.confirm('重新提炼会调用模型读取角色卡「' + (selectedRole || '当前角色') + '」，生成新的出厂人格值（大五 / 后天性格 / 好恶 / 自我看法）。确认后需再点「确认入库」才生效。继续？')) return;
        setProposing(true); setFactoryErr(''); setFactoryMsg(''); setFactory(null);
        fetch(apiUrl('persona/propose'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ role: selectedRole || undefined }) })
          .then((r) => r.json())
          .then((d) => {
            setProposing(false);
            if (d.ok) setFactory(d.factory);
            else setFactoryErr(String(d.error || '提炼失败'));
          })
          .catch((e) => { setProposing(false); setFactoryErr(String(e?.message || e)); });
      };
      const confirmFactory = () => {
        if (!factory) return;
        setConfirming(true); setFactoryErr(''); setFactoryMsg('');
        fetch(apiUrl('persona/confirm'), {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ factory, role: selectedRole || undefined }),
        })
          .then((r) => r.json())
          .then((d) => {
            setConfirming(false);
            if (d.ok) { setFactoryMsg(`已确认入库，人格核心 ${d.coreLen ?? '—'} 字符`); setFactory(null); setHealth((h) => h ? { ...h, persona: { ...h.persona, coreLen: d.coreLen ?? h.persona?.coreLen } } : h); }
            else setFactoryErr(String(d.error || '确认失败'));
          })
          .catch((e) => { setConfirming(false); setFactoryErr(String(e?.message || e)); });
      };
      const fmtFactory = (f) => {
        if (!f) return '';
        const lines = [];
        if (f.traits) lines.push('大五：' + ['O', 'C', 'E', 'A', 'N'].map((k) => `${k}=${f.traits[k] ?? '?'}`).join(' '));
        if (f.character) lines.push('后天：' + Object.entries(f.character).map(([k, v]) => `${k}=${v}`).join(' '));
        if (Array.isArray(f.prefs) && f.prefs.length) lines.push('好恶：' + f.prefs.map((p) => `${p.text}(${p.valence === 'like' ? '喜欢' : '讨厌'})`).join('、'));
        if (Array.isArray(f.beliefs) && f.beliefs.length) lines.push('自我看法：' + f.beliefs.join('；'));
        return lines.join('\n');
      };

      const [mem, setMem] = React.useState(null);
      const [memErr, setMemErr] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        fetch(apiUrl('memory'), { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => { if (alive) { if (d.ok) setMem(d); else setMemErr(String(d.error || '加载失败')); } })
          .catch((e) => { if (alive) setMemErr(String(e?.message || e)); });
        return () => { alive = false; };
      }, []);

      const cardStyle = { background: 'var(--dsw-alias-bg-module, #fff)', borderRadius: 'var(--dsw-radius-xl, 12px)', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,.08)', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' };
      const fieldLabel = { display: 'block', margin: '12px 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #333)' };
      const inputStyle = { width: '100%', maxWidth: '100%', padding: '8px 10px', borderRadius: 'var(--dsw-radius-lg, 8px)', border: '1px solid var(--dsw-alias-border-l3, #ddd)', fontSize: '13px', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary, #333)', background: 'var(--dsw-alias-bg-module, #fff)' };
      const row = (label, val) => h('div', { style: { margin: '8px 0', display: 'flex', gap: '8px', alignItems: 'center', fontSize: '14px', width: '100%' } },
        h('span', { style: { minWidth: '110px', color: 'var(--dsw-alias-label-tertiary, #888)', flexShrink: 0 } }, label),
        h('span', { style: { flex: 1, minWidth: 0 } }, val),
      );
      const tabBtn = (id, label) => h('button', {
        onClick: () => setTab(id),
        style: {
          padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', border: 'none',
          fontSize: '13px', fontWeight: 500,
          background: tab === id ? 'var(--dsw-alias-state-business-primary, #4f8cff)' : 'var(--dsw-alias-bg-module, #f0f2f5)', color: tab === id ? '#fff' : 'var(--dsw-alias-label-secondary, #555)',
        },
      }, label);

      return h('div', { style: { padding: '24px', width: '100%', maxWidth: '100%', margin: '0 auto', boxSizing: 'border-box', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: '16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0' } },
          h('span', { style: { fontSize: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #222)' } }, '记忆与人格'),
          h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #999)' } }, '跨会话 / 跨设备记忆 + 人格'),
        ),
        h('div', { style: { display: 'flex', gap: '6px', marginBottom: '0' } },
          tabBtn('overview', '总览'), tabBtn('settings', '设置'), tabBtn('memory', '记忆库'), tabBtn('persona', '人格'), tabBtn('rag', '向量索引'),
        ),

        // 总览
        tab === 'overview' ? h('div', { style: { width: '100%' } },
          err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', marginBottom: '12px' } }, '状态获取失败：' + err) : null,
          health ? h('div', { style: cardStyle },
            h('h4', { style: { margin: '0 0 10px', fontSize: '15px' } }, '运行状态'),
            row('设备标识', h('code', { style: { fontSize: '12px' } }, String(health.device || '—'))),
            row('记忆 key', h('code', { style: { fontSize: '12px' } }, String(health.chatKey || '—'))),
            row('人格 key', h('code', { style: { fontSize: '12px' } }, String(health.personaKey || '—'))),
            row('记忆条数', String(health.memoryCount ?? '—')),
            row('服务', health.ragOk ? '✅ memory-rag 连接正常' : (health.ragChecked ? '⚠️ memory-rag 不可达' : '…')),
          ) : (err ? null : h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #888)' } }, '加载中…')),
          h('div', { style: cardStyle },
            h('h4', { style: { margin: '0 0 8px', fontSize: '15px' } }, '说明'),
            h('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #666)', lineHeight: '1.8', margin: '0' } },
              '适配 DSH 原生 Web 会话：每条用户消息和 AI 回复都写进记忆存档（chat:root，跨设备共享，带 device 标注来源）。' +
              '人格系统持续判读你的话，性格/情绪/关系随经历变化。' +
              '对话中你直接说「记住…」或用 remember 工具即可长期记忆。'),
          ),
        ) : null,

        // 设置（真实配置读写）
        tab === 'settings' ? h('div', { style: { width: '100%' } },
          cfgErr ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', marginBottom: '12px' } }, '配置加载/保存失败：' + cfgErr) : null,
          cfgSaved ? h('div', { style: { color: '#2a7d2a', marginBottom: '12px', fontSize: '13px' } }, cfgSaved) : null,
          cfg ? h('div', {},
            // ── 主人称呼 ──
            h('div', { style: cardStyle },
              h('h4', { style: { margin: '0 0 12px', fontSize: '15px' } }, '主人称呼'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '主人名称（存档/账本用，如「爸爸」）'),
                h('input', { value: cfg.ownerName || '', onChange: (e) => setCfg({ ...cfg, ownerName: e.target.value }), style: inputStyle, placeholder: '用户' }),
                h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #999)', display: 'block', marginTop: '3px' } }, '保存后需重启 DSH 生效'),
              ),
            ),
            // ── memory-rag ──
            h('div', { style: cardStyle },
              h('h4', { style: { margin: '0 0 12px', fontSize: '15px' } }, '记忆服务（memory-rag）'),
              h('label', { style: fieldLabel }, h('input', { type: 'checkbox', checked: !!cfg.memoryRag.enabled, onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, enabled: e.target.checked } }) }), ' 启用'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '服务地址'),
                h('input', { value: cfg.memoryRag.url || '', onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, url: e.target.value } }), style: inputStyle, placeholder: 'http://127.0.0.1:8093' }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, 'API Token'),
                h('input', { type: 'password', placeholder: cfg.memoryRag.hasToken ? ('已设置 ' + cfg.memoryRag.tokenHint + '（留空不变）') : '输入 token', value: cfg.memoryRag._token || '', onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, _token: e.target.value } }), style: inputStyle }),
              ),
              h('label', { style: fieldLabel }, h('input', { type: 'checkbox', checked: !!cfg.memoryRag.allowRemote, onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, allowRemote: e.target.checked } }) }), ' 允许远程访问'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '请求超时（毫秒）'),
                h('input', { type: 'number', min: '500', step: '500', value: cfg.memoryRag.timeoutMs ?? 3000, onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, timeoutMs: Number(e.target.value) } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '召回模式'),
                h('input', { value: cfg.memoryRag.recall?.mode || 'shadow', onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, recall: { ...cfg.memoryRag.recall, mode: e.target.value } } }), style: inputStyle, placeholder: 'shadow' }),
                h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #999)', display: 'block', marginTop: '3px' } }, 'shadow=后台预热（推荐）'),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '建议模式'),
                h('input', { value: cfg.memoryRag.suggest?.mode || 'on', onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, suggest: { ...cfg.memoryRag.suggest, mode: e.target.value } } }), style: inputStyle, placeholder: 'on' }),
                h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #999)', display: 'block', marginTop: '3px' } }, 'on/off，每次唤醒建议条数 perWake'),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '每次唤醒建议条数'),
                h('input', { type: 'number', min: '1', max: '10', value: cfg.memoryRag.suggest?.perWake ?? 3, onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, suggest: { ...cfg.memoryRag.suggest, perWake: Number(e.target.value) } } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '同一候选最多展示次数'),
                h('input', { type: 'number', min: '1', max: '10', value: cfg.memoryRag.suggest?.maxShows ?? 2, onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, suggest: { ...cfg.memoryRag.suggest, maxShows: Number(e.target.value) } } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '候选有效期（小时）'),
                h('input', { type: 'number', min: '1', value: cfg.memoryRag.suggest?.ttlHours ?? 72, onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, suggest: { ...cfg.memoryRag.suggest, ttlHours: Number(e.target.value) } } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '建议接口超时（毫秒）'),
                h('input', { type: 'number', min: '50', step: '50', value: cfg.memoryRag.suggest?.timeoutMs ?? 300, onChange: (e) => setCfg({ ...cfg, memoryRag: { ...cfg.memoryRag, suggest: { ...cfg.memoryRag.suggest, timeoutMs: Number(e.target.value) } } }), style: inputStyle }),
              ),
              h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #999)', margin: '8px 0 0' } }, '记忆/人格数据全存容器，改地址/token 后需重启容器生效。'),
            ),
            // ── 记忆衰减 ──
            h('div', { style: cardStyle },
              h('h4', { style: { margin: '0 0 12px', fontSize: '15px' } }, '记忆衰减'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '冻结阈值（低于此牢固度不再自动想起）'),
                h('input', { type: 'number', step: '0.05', min: '0', max: '1', value: cfg.decay.freezeBelow, onChange: (e) => setCfg({ ...cfg, decay: { ...cfg.decay, freezeBelow: Number(e.target.value) } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '重复想起冷却（毫秒）'),
                h('input', { type: 'number', step: '60000', value: cfg.decay.reviewCooldownMs, onChange: (e) => setCfg({ ...cfg, decay: { ...cfg.decay, reviewCooldownMs: Number(e.target.value) } }), style: inputStyle }),
              ),
            ),
            // ── 主动唤醒 ──
            h('div', { style: cardStyle },
              h('h4', { style: { margin: '0 0 12px', fontSize: '15px' } }, '主动唤醒（到期约定 / 忽然想起）'),
              h('label', { style: fieldLabel }, h('input', { type: 'checkbox', checked: !!cfg.lifeLoop.enabled, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, enabled: e.target.checked } }) }), ' 启用'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '每天唤醒上限'),
                h('input', { type: 'number', min: '1', max: '10', value: cfg.lifeLoop.recallPerDay, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, recallPerDay: Number(e.target.value) } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '同一条冷却（天）'),
                h('input', { type: 'number', min: '1', value: cfg.lifeLoop.cooldownDays, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, cooldownDays: Number(e.target.value) } }), style: inputStyle }),
              ),
              h('label', { style: fieldLabel }, h('input', { type: 'checkbox', checked: !!cfg.lifeLoop.promiseWake?.enabled, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, promiseWake: { ...cfg.lifeLoop.promiseWake, enabled: e.target.checked } } }) }), ' 到期约定唤醒'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '约定唤醒时间'),
                h('input', { value: cfg.lifeLoop.promiseWake?.at || '10:00', onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, promiseWake: { ...cfg.lifeLoop.promiseWake, at: e.target.value } } }), style: inputStyle, placeholder: '10:00' }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '约定每天上限'),
                h('input', { type: 'number', min: '1', value: cfg.lifeLoop.promiseWake?.maxPerDay ?? 5, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, promiseWake: { ...cfg.lifeLoop.promiseWake, maxPerDay: Number(e.target.value) } } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '安静时段（小时，如 3-8）'),
                h('input', { value: (cfg.lifeLoop.quiet || []).join('-'), onChange: (e) => { const parts = e.target.value.split('-').map(Number); setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, quiet: parts.filter(n => !isNaN(n)) } }); }, style: inputStyle, placeholder: '3-8' }),
              ),
              h('label', { style: fieldLabel }, h('input', { type: 'checkbox', checked: !!cfg.lifeLoop.associate?.enabled, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, associate: { ...cfg.lifeLoop.associate, enabled: e.target.checked } } }) }), ' 联想唤醒（忽然想起）'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '联想冷却（天）'),
                h('input', { type: 'number', min: '1', value: cfg.lifeLoop.associate?.cooldownDays ?? 7, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, associate: { ...cfg.lifeLoop.associate, cooldownDays: Number(e.target.value) } } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '联想最早记忆年龄（天）'),
                h('input', { type: 'number', min: '1', value: cfg.lifeLoop.associate?.minAgeDays ?? 2, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, associate: { ...cfg.lifeLoop.associate, minAgeDays: Number(e.target.value) } } }), style: inputStyle }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '联想接口超时（毫秒）'),
                h('input', { type: 'number', min: '100', step: '100', value: cfg.lifeLoop.associate?.timeoutMs ?? 1500, onChange: (e) => setCfg({ ...cfg, lifeLoop: { ...cfg.lifeLoop, associate: { ...cfg.lifeLoop.associate, timeoutMs: Number(e.target.value) } } }), style: inputStyle }),
              ),
            ),
            // ── 跨设备 ──
            h('div', { style: cardStyle },
              h('h4', { style: { margin: '0 0 12px', fontSize: '15px' } }, '跨设备共享'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '用户标识'),
                h('input', { value: cfg.crossDevice?.userId || '', onChange: (e) => setCfg({ ...cfg, crossDevice: { ...cfg.crossDevice, userId: e.target.value } }), style: inputStyle, placeholder: 'root' }),
              ),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '设备标识（留空用本机）'),
                h('input', { value: cfg.crossDevice?.deviceId || '', onChange: (e) => setCfg({ ...cfg, crossDevice: { ...cfg.crossDevice, deviceId: e.target.value } }), style: inputStyle, placeholder: '留空=hostname' }),
              ),
              h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #999)', margin: '8px 0 0' } }, 'chat:{userId} 跨端共享对话；persona:{userId} 人格；device:{deviceId} 设备能力。'),
            ),
            // ── 注入 ──
            h('div', { style: cardStyle },
              h('h4', { style: { margin: '0 0 12px', fontSize: '15px' } }, '人格注入'),
              h('div', { style: fieldLabel },
                h('span', { style: { display: 'block', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '注入上限（字符）'),
                h('input', { type: 'number', min: '100', step: '500', value: cfg.role?.maxInjectChars ?? 6000, onChange: (e) => setCfg({ ...cfg, role: { ...cfg.role, maxInjectChars: Number(e.target.value) } }), style: inputStyle }),
              ),
              h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #999)', margin: '8px 0 0' } }, '人格核心注入 systemPrompt 的最大字符数。'),
            ),
            // ── 保存 ──
            h('div', { style: { marginTop: '16px' } },
              h('button', {
                onClick: () => {
                  const patch = { ...cfg };
                  if (cfg.memoryRag._token && cfg.memoryRag._token.trim()) {
                    patch.memoryRag = { ...cfg.memoryRag, token: cfg.memoryRag._token };
                  } else {
                    patch.memoryRag = { ...cfg.memoryRag };
                    delete patch.memoryRag.token;
                  }
                  delete patch.memoryRag._token;
                  delete patch.memoryRag.tokenHint; delete patch.memoryRag.hasToken;
                  saveCfg(patch);
                },
                disabled: cfgSaving,
                style: { padding: '8px 20px', borderRadius: '8px', border: 'none', background: 'var(--dsw-alias-state-business-primary, #4f8cff)', color: '#fff', fontSize: '14px', cursor: cfgSaving ? 'wait' : 'pointer' },
              }, cfgSaving ? '保存中…' : '保存设置'),
            ),
          ) : h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #888)' } }, '加载配置…'),
        ) : null,

        // 记忆库（people 列表）
        tab === 'memory' ? h('div', { style: cardStyle },
          h('h4', { style: { margin: '0 0 10px', fontSize: '15px' } }, '记忆库'),
          row('记忆条数', String(health?.memoryCount ?? '—')),
          row('服务', health?.ragOk ? '✅ memory-rag 连接正常' : (health?.ragChecked ? '⚠️ memory-rag 不可达' : '…')),
          memErr ? h('p', { style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: '13px' } }, '加载失败：' + memErr) : null,
          mem ? h('div', { style: { marginTop: '12px' } },
            h('h5', { style: { margin: '0 0 8px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '人物（' + mem.people.length + '）'),
            mem.people.length ? mem.people.map((p) =>
              h('div', { key: p.userId, style: { padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: '13px' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('span', { style: { fontWeight: 500 } }, p.name || p.userId),
                  h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999)' } }, p.items + ' 条 · ' + p.messages + ' 条消息'),
                ),
                h('div', { style: { color: '#aaa', fontSize: '12px', marginTop: '2px' } }, '最后：' + String(p.lastSeenAt || '').slice(0, 16).replace('T', ' ')),
              ),
            ) : h('p', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '13px' } }, '暂无人物记录。'),
            h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #999)', marginTop: '10px' } },
              '记忆条目完整列表接入中（当前显示人物概览）。'),
          ) : h('p', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '13px' } }, '加载中…'),
        ) : null,

        // 人格（状态 + 核心文本）
        tab === 'persona' ? h('div', { style: cardStyle },
          h('h4', { style: { margin: '0 0 10px', fontSize: '15px' } }, '人格'),
          health?.persona ? h('div', {},
            row('已初始化', health.persona.initialized ? '✅ 是' : '❌ 否'),
            row('注入开关', health.persona.inject ? '✅ 开' : '⏸ 关'),
            row('人格核心长度', String(health.persona.coreLen ?? '—') + ' 字符'),
            mem?.personaText ? h('div', { style: { marginTop: '12px' } },
              h('h5', { style: { margin: '0 0 6px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '人格核心内容'),
              h('pre', { style: { background: '#f8f9fa', borderRadius: '8px', padding: '12px', fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflow: 'auto', margin: '0' } }, mem.personaText),
            ) : null,
          ) : h('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, '人格状态加载中…'),
          // ── 重新提炼人格 ──
          h('div', { style: { marginTop: '16px', borderTop: '1px solid var(--dsw-alias-border-l3, #eee)', paddingTop: '14px' } },
            h('h5', { style: { margin: '0 0 6px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '重新提炼人格（从角色卡重新生成出厂值）'),
            h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #999)', margin: '0 0 10px' } },
              '调用模型读指定角色卡，重新提炼大五 / 后天性格 / 好恶 / 自我看法。先「提炼」预览，再「确认入库」。'),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' } },
              h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #666)' } }, '角色：'),
              h('select', {
                value: selectedRole,
                onChange: (e) => setSelectedRole(e.target.value),
                disabled: proposing || confirming,
                style: { padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3, #ddd)', fontSize: '13px', background: 'var(--dsw-alias-bg-module, #fff)', color: 'var(--dsw-alias-label-primary, #333)', minWidth: '140px' },
              },
                h('option', { value: '' }, '（当前角色）'),
                roles.map((r) => h('option', { key: r, value: r }, r)),
              ),
            ),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { onClick: proposeFactory, disabled: proposing, style: { padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--dsw-alias-state-business-primary, #4f8cff)', background: 'var(--dsw-alias-state-business-primary, #4f8cff)', color: '#fff', cursor: proposing ? 'wait' : 'pointer', fontSize: '13px' } }, proposing ? '提炼中…' : '提炼'),
              factory ? h('button', { onClick: confirmFactory, disabled: confirming, style: { padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--dsw-alias-state-success-primary, #2a7d2a)', background: '#2a7d2a', color: '#fff', cursor: confirming ? 'wait' : 'pointer', fontSize: '13px' } }, confirming ? '入库中…' : '确认入库') : null,
              factory ? h('button', { onClick: () => setFactory(null), style: { padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3, #ddd)', background: 'var(--dsw-alias-bg-module, #fff)', color: 'var(--dsw-alias-label-secondary, #555)', cursor: 'pointer', fontSize: '13px' } }, '取消') : null,
            ),
            factoryErr ? h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #c00)', margin: '8px 0 0' } }, factoryErr) : null,
            factoryMsg ? h('p', { style: { fontSize: '12px', color: '#2a7d2a', margin: '8px 0 0' } }, factoryMsg) : null,
            factory ? h('pre', { style: { background: '#f8f9fa', borderRadius: '8px', padding: '12px', fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '220px', overflow: 'auto', margin: '10px 0 0' } }, fmtFactory(factory)) : null,
          ),
        ) : null,

        // 向量索引（状态 + 立即索引/全量重建）
        tab === 'rag' ? h('div', { style: cardStyle },
          h('h4', { style: { margin: '0 0 10px', fontSize: '15px' } }, '向量索引'),
          h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #999)', margin: '0 0 12px' } }, '语义检索用的索引（memory-rag，:8093）。原始存档不会被它改动；索引随时可以删掉重建。'),
          h('div', { style: { marginBottom: '12px' } },
            h('button', { onClick: startIndex, style: { padding: '6px 14px', borderRadius: '6px', border: '1px solid #ddd', background: '#fff', color: '#333', cursor: 'pointer', fontSize: '13px', marginRight: '8px' } }, '立即索引'),
            h('button', {
              onClick: startRebuild,
              disabled: rebuildJob && rebuildJob.status !== 'finished' && rebuildJob.status !== 'error',
              style: { padding: '6px 14px', borderRadius: '6px', border: '1px solid #e53935', background: rebuildJob && rebuildJob.status !== 'finished' && rebuildJob.status !== 'error' ? '#eee' : '#e53935', color: rebuildJob && rebuildJob.status !== 'finished' && rebuildJob.status !== 'error' ? 'var(--dsw-alias-label-tertiary, #999)' : '#fff', cursor: rebuildJob && rebuildJob.status !== 'finished' && rebuildJob.status !== 'error' ? 'not-allowed' : 'pointer', fontSize: '13px' },
            }, rebuildJob && rebuildJob.status !== 'finished' && rebuildJob.status !== 'error' ? '全量重建中…' : '全量重建'),
            indexMsg ? h('span', { style: { marginLeft: '8px', fontSize: '12px', color: indexMsg.startsWith('索引失败') || indexMsg.startsWith('索引出错') ? '#e53935' : 'var(--dsw-alias-state-business-primary, #4f8cff)' } }, indexMsg) : null,
            rebuildErr ? h('span', { style: { marginLeft: '8px', fontSize: '12px', color: '#e53935' } }, rebuildErr) : null,
          ),
          // 状态：来自 /health 的 rag（容器 health）
          (() => {
            const rag = health?.rag || {};
            if (health?.rag?.error) return h('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #c00)' } }, '状态读取失败：' + health.rag.error);
            if (rag.off === true) return h('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, '向量记忆已关闭：检索暂时只走关键词，索引和摘要都还在。');
            if (!rag || rag.ok === false) return h('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, rag?.error ? '读取失败：' + rag.error : '加载中…');
            const emb = rag.embedding || {};
            const out = [];
            out.push(row('服务', rag.ok ? '✅ 正常' : '❌ 异常'));
            if (emb.model_id) out.push(row('向量模型', String(emb.model_id) + (emb.dim ? `（${emb.dim} 维）` : '')));
            if (rag.mismatch) out.push(h('div', { style: { margin: '8px 0', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #c00)' } }, '索引口径和配置不一致：' + rag.mismatch + '。点『全量重建』修复。'));
            const store = rag.store || {};
            if (store.chunks != null) out.push(row('已索引', `${store.chunks} 块`));
            if (store.per_key) for (const [k, n] of Object.entries(store.per_key || {})) out.push(row(`  ${k}`, `${n} 块`));
            const lag = rag.lag_rows || {};
            const lagKeys = Object.keys(lag);
            if (lagKeys.length) {
              if (lagKeys.every((k) => !lag[k])) out.push(row('待索引', '无（都已入库）'));
              else { out.push(row('待索引', '')); for (const k of lagKeys) out.push(row(`  ${k}`, `${lag[k]} 条`)); }
            }
            if (rag.last_index) {
              const li = rag.last_index;
              const when = li.at ? new Date(li.at).toLocaleString('zh-CN', { hour12: false }) : '—';
              out.push(row('最近一次索引', `${when}，新增 ${li.chunks ?? 0} 块` + (li.error ? `，错误：${li.error}` : '')));
            }
            const job = rag.job;
            if (!job) out.push(row('重建任务', '没跑过'));
            else if (!job.finished_at) out.push(row('重建任务', `进行中（${new Date(job.started_at).toLocaleString('zh-CN', { hour12: false })} 开始）`));
            else if (job.error) out.push(row('重建任务', `失败：${job.error}`));
            else out.push(row('重建任务', `完成，新建 ${job.chunks ?? 0} 块`));
            // 提炼状态
            const dist = rag.distill;
            if (dist) {
              out.push(row('提炼', `摘要 ${dist.summaries ?? 0} 条：待提炼 ${dist.pending ?? 0}、失败 ${dist.failed ?? 0}（历史累计失败块）、跳过 ${dist.skipped ?? 0}、向量待补 ${dist.vec_pending ?? 0}`));
              out.push(row('提炼模型', `${dist.enabled ? '开' : '关'} · ${dist.model || '—'} · 密钥 ${dist.key ? '已配置' : '未配置'}`));
              if (dist.entities != null || dist.relations != null) out.push(row('关系图', `${dist.entities ?? 0} 个人/物/话题，${dist.relations ?? 0} 条关系`));
              const t = dist.today || {};
              const cost = Number(t.cost);
              out.push(row('提炼今日', `调用 ${t.calls ?? 0} 次（成功 ${t.ok ?? 0}、失败 ${t.failed ?? 0}），花费 ¥${Number.isFinite(cost) ? cost.toFixed(3) : '0.000'}，上限 ${dist.daily_limit ?? '—'} 次/天`));
              if (t.notes != null || t.notes_dropped != null) out.push(row('候选今日', `抽出 ${t.notes ?? 0} 条 · 校验丢弃 ${t.notes_dropped ?? 0} 条`));
              if (dist.last_error) out.push(row('最近错误', String(dist.last_error)));
              const n = dist.notes || {};
              if (n.total != null) out.push(row('记忆候选', `${n.total} 条（队列 ${n.queued ?? 0}、失败 ${n.failed ?? 0}）`));
            }
            // 遗忘请求
            const pf = rag.forget_requests || [];
            out.push(row('待处理遗忘请求', pf.length ? pf.join('、') : '无'));
            return h('div', {}, out);
          })(),
        ) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        const PANEL_ID = 'web-memory';

        // DSH slots 系统要求先 inject 声明注册意图，再 register 实际内容
        // （参照 dshmarket / dsh-fish-memory 模式）。inject 的 callback 是懒执行的。

        // 1. 注册侧边栏导航项（像插件市场：sidebar.panellist）
        slots.inject('sidebar.panellist', () => {
          slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 3, label: () => '记忆与人格' },
            (owner = {}) => h(Icon, { size: owner.size ?? 16 }),
          );
        });
        // 2. 注册主内容面板（点击后显示；main 是 keyed slot）
        slots.inject('main', () => {
          slots.register(
            { name: 'main', key: PANEL_ID },
            () => h(Panel),
          );
        });
        // 3. 也注册到设置（可选，设置里也能看到）
        slots.inject('settings.section', () => {
          slots.register(
            { name: 'settings.section', id: PANEL_ID, order: 55, label: '记忆与人格' },
            () => h(Panel),
          );
        });
      },
    };
  },
});
