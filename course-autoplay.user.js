// ==UserScript==
// @name         在线课程自动连播助手
// @namespace    anonymous
// @version      1.0.0
// @description  课程列表→播放→返回→下一门 自动连播；模拟点击驱动；自动处理防挂机弹窗；切后台不暂停
// @match        https://example.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

// 使用前请把上面的 @match 改成你的学习平台域名，例如：
// @match https://www.your-platform.com/*
// 如果视频播放器嵌在第三方域名的 iframe 里，还需要把该域名也加一条 @match。

(function () {
    'use strict';

    /* ================= 配置 ================= */
    const CFG = {
        DONE_RE: /(100%|已完成|已学完)/,                 // 列表条目"已完成"标记
        LEARN_BTN_RE: /^(开始|继续|重新|去|立即)?学习$/, // 学习按钮文字
        BACK_DELAY: [2500, 5000],                       // 播完→返回 随机延迟 ms
        CLICK_DELAY: [1200, 3000],                      // 点击课程前随机延迟 ms
        POLL: 2000,                                     // 主轮询间隔
        POPUP_KEYWORDS: ['确定', '继续学习', '继续播放', '知道了', '我知道了', '关闭', '继续', '确定学习'],
        QUIZ_RE: /(单选|多选|判断题|下列|正确答案|请作答|随堂|测验)/,
        MUTE: true,                                     // 默认静音（过浏览器自动播放策略）
    };

    const TOP = (window.top === window);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand = ([a, b]) => a + Math.random() * (b - a);
    const visible = x => x.offsetParent !== null || x.getClientRects().length > 0;

    /* ================= 状态存取（跨帧/跨页共享） ================= */
    const S = {
        get running() { return GM_getValue('k_running', false); },
        set running(v) { GM_setValue('k_running', v); },
        get doneSig() { return GM_getValue('k_doneSig', 0); },
        set doneSig(v) { GM_setValue('k_doneSig', v); },
    };

    /* ================= 模拟点击 ================= */
    function simClick(el, deep) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        const r = el.getBoundingClientRect();
        const opts = {
            bubbles: true, cancelable: true, view: window,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
        };
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch (e) {}
        el.click();
        // 有些卡片把跳转事件绑在外层容器上：deep=true 时沿父链补点（最多3层）
        if (deep) {
            let p = el.parentElement;
            for (let i = 0; i < 3 && p && p !== document.body; i++) { p.click(); p = p.parentElement; }
        }
        return true;
    }

    /* ================= 可见性劫持（切后台不暂停） ================= */
    let spoofUntil = 0;
    const touchSpoof = () => { spoofUntil = Date.now() + 90000; };
    try {
        const proto = Document.prototype;
        const realHidden = Object.getOwnPropertyDescriptor(proto, 'hidden');
        const realVis = Object.getOwnPropertyDescriptor(proto, 'visibilityState');
        Object.defineProperty(document, 'hidden', {
            configurable: true,
            get() { return Date.now() < spoofUntil ? false : realHidden.get.call(this); },
        });
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get() { return Date.now() < spoofUntil ? 'visible' : realVis.get.call(this); },
        });
    } catch (e) { console.warn('[连播助手] 可见性劫持失败', e); }

    /* ================= 倍速控制 ================= */
    let speedMode = GM_getValue('k_speed', 2); // 默认 2 倍速
    let lastSpeedUiTry = 0;

    function updateSpeedBtn(b) {
        if (!b) return;
        b.textContent = speedMode === 2 ? '⚡ 2倍速' : '1x 原速';
        b.style.background = speedMode === 2 ? '#fff8e1' : '#fff';
    }

    // 模拟点击播放器"倍速"菜单并选择 2 倍速（带 20 秒冷却，防止反复弹菜单）
    async function trySpeedUI() {
        if (Date.now() - lastSpeedUiTry < 20000) return;
        lastSpeedUiTry = Date.now();
        const btn = [...document.querySelectorAll('div, span, button')]
            .filter(visible)
            .find(x => (x.textContent || '').trim() === '倍速');
        if (!btn) return;
        simClick(btn);
        await sleep(600);
        const opt = [...document.querySelectorAll('div, span, li, p')]
            .filter(visible)
            .find(x => /^2(\.0)?(倍速?|x)$/i.test((x.textContent || '').trim()));
        if (opt) { simClick(opt); log('已通过菜单选择 2 倍速'); }
    }

    function applySpeed() {
        if (speedMode !== 2) {
            document.querySelectorAll('video').forEach(v => { try { v.playbackRate = 1; } catch (e) {} });
            return;
        }
        document.querySelectorAll('video').forEach(v => {
            try {
                if (v.duration > 0 && v.playbackRate !== 2) {
                    v.playbackRate = 2;
                    log('直接设置 playbackRate = 2');
                    trySpeedUI();
                }
            } catch (e) {}
        });
    }

    /* ================= 日志面板 ================= */
    let panel, statusEl, logEl, minBtn;
    function buildPanel() {
        if (!TOP || panel || !document.body) return;
        panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:10px 12px;font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#24292f;width:240px;user-select:none;';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center">
                <b>🎓 连播助手</b><span id="k-min" style="cursor:pointer;color:#0969da">➖</span>
            </div>
            <div id="k-body">
                <div id="k-status" style="color:#57606a;word-break:break-all;margin-top:4px">待机</div>
                <div style="margin-top:6px;display:flex;gap:6px">
                    <button id="k-run" style="flex:1;cursor:pointer;border:0;border-radius:6px;padding:4px 0;background:#1a7f37;color:#fff">▶ 启动</button>
                    <button id="k-mute" style="flex:1;cursor:pointer;border:1px solid #d0d7de;border-radius:6px;padding:4px 0;background:#fff">🔇 静音中</button>
                    <button id="k-speed" style="flex:1;cursor:pointer;border:1px solid #d0d7de;border-radius:6px;padding:4px 0;background:#fff8e1">⚡ 2倍速</button>
                </div>
                <div id="k-log" style="margin-top:6px;color:#8c959f;max-height:72px;overflow:hidden"></div>
            </div>`;
        document.body.appendChild(panel);
        statusEl = panel.querySelector('#k-status');
        logEl = panel.querySelector('#k-log');
        minBtn = panel.querySelector('#k-min');
        minBtn.onclick = () => {
            const body = panel.querySelector('#k-body');
            const min = body.style.display === 'none';
            body.style.display = min ? '' : 'none';
            minBtn.textContent = min ? '➖' : '➕';
        };
        panel.querySelector('#k-run').onclick = () => {
            S.running = !S.running;
            refreshBtn();
            log(S.running ? '已启动' : '已暂停');
        };
        panel.querySelector('#k-mute').onclick = (e) => {
            CFG.MUTE = !CFG.MUTE;
            e.target.textContent = CFG.MUTE ? '🔇 静音中' : '🔊 有声音';
            document.querySelectorAll('video').forEach(v => { v.muted = CFG.MUTE; });
        };
        panel.querySelector('#k-speed').onclick = (e) => {
            speedMode = speedMode === 2 ? 1 : 2;
            GM_setValue('k_speed', speedMode);
            updateSpeedBtn(e.target);
            applySpeed();
            log(speedMode === 2 ? '切换为 2 倍速' : '切换为原速');
        };
        updateSpeedBtn(panel.querySelector('#k-speed'));
        refreshBtn();
    }
    function refreshBtn() {
        if (!panel) return;
        const b = panel.querySelector('#k-run');
        b.textContent = S.running ? '⏸ 暂停' : '▶ 启动';
        b.style.background = S.running ? '#cf222e' : '#1a7f37';
    }
    function log(msg) {
        console.log('[连播助手]', msg);
        if (!TOP || !logEl) return;
        const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const div = document.createElement('div');
        div.textContent = `${t} ${msg}`;
        logEl.prepend(div);
        while (logEl.children.length > 4) logEl.lastChild.remove();
    }
    function setStatus(msg, warn) {
        console.log('[连播助手]', msg);
        if (!TOP || !statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = warn ? '#cf222e' : '#57606a';
    }

    /* ================= 弹窗处理 ================= */
    function findModal() {
        return [...document.querySelectorAll('[class*="dialog" i],[class*="modal" i],[class*="popup" i],[class*="mask" i],[class*="confirm" i],[class*="toast" i]')]
            .find(x => visible(x) && x.getBoundingClientRect().height > 10 && (x.textContent || '').length < 500);
    }
    function handlePopups() {
        const modal = findModal();
        if (modal) {
            const text = modal.textContent || '';
            // 随堂测验：不能代答，暂停并提醒
            if (CFG.QUIZ_RE.test(text)) {
                setStatus('⚠️ 检测到随堂测验弹窗，已暂停。请手动作答后再点【▶ 启动】', true);
                S.running = false; refreshBtn();
                try { alert('连播助手：检测到随堂测验，请手动作答！'); } catch (e) {}
                return true;
            }
            const btn = [...modal.querySelectorAll('button, a, [class*="btn" i], span, div')]
                .filter(visible)
                .find(x => CFG.POPUP_KEYWORDS.includes((x.textContent || '').trim()));
            if (btn) {
                simClick(btn, true);
                log(`自动关闭弹窗：${(btn.textContent || '').trim()}`);
                return true;
            }
        }
        // 兜底：有些提示层没有 dialog/modal 类名（部分播放器的挂机提示），
        // 直接全局找像按钮的"继续播放/继续学习"元素
        const btn = [...document.querySelectorAll('button, a, [class*="btn" i], [class*="Btn"], div, span')]
            .filter(visible)
            .find(x => {
                const t = (x.textContent || '').trim();
                return t.length <= 12 && /继续播放|继续学习|继续观看|点我继续|点击继续/.test(t);
            });
        if (btn) {
            simClick(btn, true);
            log(`自动点击提示按钮：${(btn.textContent || '').trim().slice(0, 15)}`);
            return true;
        }
        return false;
    }

    /* ================= 播放页逻辑 ================= */
    let finished = false;
    let videoBusy = false;
    function videoLoop() {
        setInterval(async () => {
            if (!S.running || videoBusy) return;
            videoBusy = true;
            try {
                await videoTick();
            } finally { videoBusy = false; }
        }, 3000);
    }
    async function videoTick() {
            handlePopups();
            const vids = [...document.querySelectorAll('video')];
            if (!vids.length) return;
            const v = vids.find(x => x.duration > 0) || vids[0];
            v.muted = CFG.MUTE;
            applySpeed(); // 每轮检查，防止播放器把倍速重置回去

            // ---- 播完判定 ----
            if (v.ended || (v.duration > 0 && v.duration > 1 && v.currentTime >= v.duration - 1.5)) {
                if (finished) return;
                finished = true;
                touchSpoof();
                log('本节播放完毕');
                await sleep(rand(CFG.BACK_DELAY));

                // 播完 → 找返回/下一课类按钮；优先图标按钮，其次文字按钮，最后浏览器后退
                const backBtn = [...document.querySelectorAll('button, a, div, span')]
                    .filter(visible)
                    .find(x => (x.textContent || '').trim() === '返回');
                const nextBtn = [...document.querySelectorAll('button, a, div, span')]
                    .filter(visible)
                    .find(x => /^下一(课|节|章|集|个)$/.test((x.textContent || '').trim()));
                const iconBtns = [...document.querySelectorAll('[class*="btn-circle"][class*="btn-icon"]')]
                    .filter(visible)
                    .filter(x => (x.textContent || '').trim() !== '返回');
                let exitTarget = nextBtn || null;
                if (!exitTarget && iconBtns.length) {
                    // 优先取与【返回】同层/相邻的图标按钮
                    exitTarget = backBtn
                        ? (iconBtns.find(x => x.parentElement === backBtn.parentElement)
                            || iconBtns.find(x => backBtn.parentElement && x.parentElement === backBtn.parentElement.parentElement)
                            || iconBtns[0])
                        : iconBtns[0];
                }
                let navigated = false;
                if (exitTarget) {
                    const hashBefore = location.hash;
                    simClick(exitTarget, true);
                    log('点击播放页出口按钮');
                    await sleep(3000);
                    navigated = location.hash !== hashBefore;
                }
                if (!navigated && backBtn) {
                    simClick(backBtn, true);
                    log('点击【返回】');
                    await sleep(3000);
                    navigated = true;
                }
                if (!navigated && TOP) { log('history.back() 返回列表'); history.back(); }
                if (!navigated && !TOP) { S.doneSig = Date.now(); } // 子帧：发信号给顶层帧
                return;
            }

            // ---- 暂停自动恢复 ----
            if (v.paused) {
                touchSpoof();
                await sleep(rand([600, 1600]));
                // 先找播放器里的大播放按钮，点不到就直接 play()
                const box = v.closest('[class*="player" i]') || v.parentElement;
                const pb = box && [...box.querySelectorAll('div, button, [class*="play" i], [class*="pause" i]')]
                    .find(x => /play|pause/i.test(x.className || ''));
                if (pb && simClick(pb)) log('模拟点击播放');
                else {
                    try { await v.play(); log('video.play() 恢复播放'); }
                    catch (e) { simClick(v); }
                }
            } else {
                touchSpoof();
            }
    }

    /* ================= 列表页逻辑（仅顶层帧） ================= */
    // 判断学习按钮所在条目是否已完成（向上找最多 6 层，遇到 100%/已完成 标记）
    function rowIsDone(btn) {
        let el = btn;
        for (let i = 0; i < 6 && el; i++) {
            el = el.parentElement;
            if (!el) break;
            const t = el.textContent || '';
            if (t.length > 400) break; // 走出条目容器了
            if (CFG.DONE_RE.test(t)) return true;
        }
        return false;
    }

    function getLearnButtons() {
        return [...document.querySelectorAll('button, a, div, span')]
            .filter(visible)
            .filter(x => CFG.LEARN_BTN_RE.test((x.textContent || '').trim()));
    }
    const getClickedSet = () => GM_getValue('k_clicked', []);
    const saveClickedSet = s => GM_setValue('k_clicked', s);

    // 按按钮在页面里的序号选下一门：跳过刚点过的(lastIdx)和历史点过的(clickedSet)以及已完成的
    function pickNextCourse(lastIdx) {
        const btns = getLearnButtons();
        const clicked = getClickedSet();
        for (let i = 0; i < btns.length; i++) {
            if (i === lastIdx) continue;
            if (clicked.includes(i)) continue;
            if (rowIsDone(btns[i])) continue;
            return { btn: btns[i], idx: i, label: `第 ${i + 1} 门课程` };
        }
        return null;
    }

    // 点进课程并校验是否真的跳转了；没跳转就走兜底，最后留调试日志
    async function enterCourse(target) {
        const hashBefore = location.hash;
        await sleep(rand(CFG.CLICK_DELAY));
        simClick(target.btn, true);
        await sleep(3500);
        if (location.hash !== hashBefore) return true;

        // 兜底1：条目里的 <a href> 链接直接点（SPA 路由监听 anchor 点击）
        const row = target.btn.closest('li') || target.btn.parentElement;
        const a = row && row.querySelector('a[href]');
        if (a) {
            log('按钮点击未跳转，尝试条目内链接');
            simClick(a, true);
            await sleep(2500);
            if (location.hash !== hashBefore) return true;
        }

        // 兜底2：留调试信息并暂停，等待人工反馈
        log('仍未跳转。条目结构：' + ((row ? row.outerHTML : target.btn.outerHTML) || '').replace(/\s+/g, ' ').slice(0, 220));
        setStatus('⚠️ 点击未触发跳转，已暂停。请查看面板日志', true);
        S.running = false;
        refreshBtn();
        return false;
    }

    let lastHash = '';
    let noVideoSince = 0;
    let lastIdx = -1;        // 上一轮刚点过的按钮序号
    let sweep = 0;           // 扫描轮次：第1遍跳过已点清单，之后清空清单复查未到100%的
    let scrollProbed = false;
    let pagerTries = 0;      // 翻页尝试次数
    let listBusy = false;
    function listLoop() {
        setInterval(async () => {
            if (!TOP || !S.running || listBusy) return;
            listBusy = true;
            try {
                const h = location.hash;
                if (h !== lastHash) {
                    lastHash = h;
                    finished = false;
                    noVideoSince = 0;
                    log('页面切换');
                    await sleep(3000); // 等 SPA 渲染
                }

                const hasVideo = !!document.querySelector('video');
                // 列表页动态判定：无视频且页面里有"学习"按钮
                // （同时覆盖卡片式课程列表和表格式课程列表）
                const isList = !hasVideo && getLearnButtons().length >= 1;

                // 子帧发来"播完"信号且当前无视频 → 返回列表
                if (!isList && S.doneSig && Date.now() - S.doneSig < 15000 && !hasVideo) {
                    S.doneSig = 0;
                    log('收到播完信号，返回列表');
                    await sleep(rand(CFG.BACK_DELAY));
                    history.back();
                    return;
                }

                if (!isList) {
                    setStatus('播放页：播放中…');
                    // 播放页 40 秒都没出现 video（可能是纯文档课），返回换下一个
                    if (!hasVideo) {
                        if (!noVideoSince) noVideoSince = Date.now();
                        else if (Date.now() - noVideoSince > 40000) {
                            noVideoSince = 0;
                            log('40秒未见视频，返回列表重试');
                            history.back();
                        }
                    }
                    return;
                }

                // ===== 列表页：点下一个未完成课程的【学习】按钮 =====
                setStatus(`列表页：扫描课程…（第 ${sweep + 1} 遍）`);
                const target = pickNextCourse(lastIdx);
                if (!target) {
                    // ① 先滚动到底部探测一次（防懒加载）
                    if (!scrollProbed) {
                        scrollProbed = true;
                        log('滚动列表加载更多课程…');
                        window.scrollTo(0, document.body.scrollHeight);
                        await sleep(1800);
                        window.scrollTo(0, 0);
                        return;
                    }
                    // ② 尝试翻页（分页列表：下一页的课程还没渲染）
                    if (pagerTries < 3) {
                        const pager = [...document.querySelectorAll('a, button, div, span, li')]
                            .filter(visible)
                            .find(x => {
                                const t = (x.textContent || '').trim();
                                if (/^(下一页|下页|›|»|next)$/i.test(t)) return true;
                                return /next[-_]?page|page[-_]?next/i.test(x.className || '');
                            });
                        const disabled = pager && /disabled|active|current/i.test(pager.className || '');
                        if (pager && !disabled) {
                            pagerTries++;
                            log('翻到下一页…');
                            saveClickedSet([]); // 新一页重新计数
                            lastIdx = -1;
                            scrollProbed = false;
                            simClick(pager, true);
                            await sleep(2500);
                            return;
                        }
                    }
                    // ③ 已点的都跳过了还没得选 → 清空清单进入下一遍，复查没到 100% 的
                    if (sweep < 2) {
                        sweep++;
                        saveClickedSet([]);
                        scrollProbed = false;
                        pagerTries = 0;
                        lastIdx = -1;
                        log(`开始第 ${sweep + 1} 遍：复查未到 100% 的课程`);
                        return;
                    }
                    setStatus('✅ 列表中未发现更多未完成课程，刷课完成！', false);
                    S.running = false;
                    refreshBtn();
                    return;
                }
                pagerTries = 0; // 有点可点说明本页还有课，翻页计数归零
                log(`点击${target.label}`);
                lastIdx = target.idx;
                const cs = getClickedSet();
                if (!cs.includes(target.idx)) { cs.push(target.idx); saveClickedSet(cs); }
                await enterCourse(target);
            } finally { listBusy = false; }
        }, CFG.POLL);
    }

    /* ================= 启动 ================= */
    function boot() {
        buildPanel();
        videoLoop();
        listLoop();
    }
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);
    setTimeout(boot, 3000); // SPA 晚渲染兜底
})();
