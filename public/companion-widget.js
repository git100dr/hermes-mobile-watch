(function() {
  // Prevent duplicate initialization
  if (window.__HERMES_WATCH_WIDGET_LOADED__) return;
  window.__HERMES_WATCH_WIDGET_LOADED__ = true;

  const host = window.location.hostname || 'localhost';
  const COMPANION_ORIGIN = `http://${host}:8649`;
  const COMPANION_WS = `ws://${host}:8649`;

  console.log('[Hermes Watch] Initializing Desktop Guardian & Companion Widget from:', COMPANION_ORIGIN);

  // State
  let companionInfo = null;
  let wsClient = null;
  let activeApprovals = new Map(); // approval_id -> data
  let activeNotifications = new Map(); // approval_id -> Notification instance
  let activeTab = 'desktop'; // 'desktop' | 'mobile'
  let soundEnabled = true;
  let autoApproveCurrentSession = false;
  let autoApproveSessionId = null;
  let swRegistration = null;
  let titleBlinkTimer = null;
  let originalDocumentTitle = document.title || 'Ekko Studio';

  if (!originalDocumentTitle.includes('Ekko') && !originalDocumentTitle.includes('Hermes')) {
    originalDocumentTitle = 'Ekko Studio';
  }

  // --- Sound Alert via Web Audio API (Zero dependencies, pure synthesis) ---
  function playAlertBeep(isCompletion = false) {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      if (isCompletion) {
        // Cheerful success chime (C5 -> E5 -> G5)
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + idx * 0.1);
          gain.gain.setValueAtTime(0.001, now + idx * 0.1);
          gain.gain.linearRampToValueAtTime(0.2, now + idx * 0.1 + 0.02);
          gain.gain.linearRampToValueAtTime(0.001, now + idx * 0.1 + 0.18);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + idx * 0.1);
          osc.stop(now + idx * 0.1 + 0.2);
        });
      } else {
        // Warning chime (Two-tone)
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(784, now); // G5
        osc1.frequency.setValueAtTime(880, now + 0.12); // A5

        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(523.25, now); // C5
        osc2.frequency.setValueAtTime(659.25, now + 0.12); // E5

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.25, now + 0.02);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.12);
        gain.gain.linearRampToValueAtTime(0.3, now + 0.14);
        gain.gain.linearRampToValueAtTime(0.001, now + 0.35);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.36);
        osc2.stop(now + 0.36);
      }
    } catch (e) {}
  }

  // --- Service Worker Setup ---
  async function setupServiceWorker() {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      try {
        swRegistration = await navigator.serviceWorker.register('/notification-sw.js');
        if (navigator.serviceWorker.ready) {
          swRegistration = await navigator.serviceWorker.ready;
        }
        console.log('[Hermes Watch] Service Worker ready for notifications');
        
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'HERMES_NOTIFICATION_CLICK') {
            handleNotificationClickEvent(event.data.data);
          }
        });
      } catch (err) {
        console.warn('[Hermes Watch] Service Worker registration failed, fallback to native Notification:', err.message);
      }
    }
  }
  setupServiceWorker();

  // --- Title Flashing Indicator ---
  function startTitleBlink(text) {
    if (titleBlinkTimer) return;
    let step = 0;
    const msg = text || '【⚠️ 待审批!】';
    titleBlinkTimer = setInterval(() => {
      if (activeApprovals.size === 0) {
        stopTitleBlink();
        return;
      }
      step = (step + 1) % 2;
      document.title = step === 0 ? `${msg} ${originalDocumentTitle}` : `【🔔 需授权】${originalDocumentTitle}`;
    }, 1000);
  }

  function stopTitleBlink() {
    if (titleBlinkTimer) {
      clearInterval(titleBlinkTimer);
      titleBlinkTimer = null;
    }
    document.title = originalDocumentTitle;
  }

  window.addEventListener('focus', () => {
    if (activeApprovals.size === 0) {
      stopTitleBlink();
    }
  });

  // --- Helper to spawn notification with fallback ---
  function createNotification(title, options = {}, onClickCallback = null) {
    const absIcon = new URL('/logo.png', window.location.origin).href;
    const opts = {
      ...options,
      icon: absIcon,
      badge: new URL('/favicon.ico', window.location.origin).href,
    };

    let notif = null;

    // Use Service Worker as primary (works in background tabs)
    // NEVER call both Window Notification and SW simultaneously, as Chrome will spawn duplicate cards!
    if (swRegistration && swRegistration.showNotification) {
      try {
        swRegistration.showNotification(title, opts).catch(err => {
          console.warn('[Hermes Watch] SW showNotification error, fallback to window:', err.message);
          return tryWindowNotification(title, opts, onClickCallback);
        });
      } catch (err) {
        console.warn('[Hermes Watch] SW showNotification throw, fallback to window:', err.message);
        notif = tryWindowNotification(title, opts, onClickCallback);
      }
    } else {
      notif = tryWindowNotification(title, opts, onClickCallback);
    }

    return notif;
  }

  function tryWindowNotification(title, opts, onClickCallback) {
    if (!('Notification' in window)) return null;
    try {
      const notif = new Notification(title, opts);
      if (onClickCallback) {
        notif.onclick = function(event) {
          try { event.preventDefault(); } catch(e){}
          window.focus();
          notif.close();
          onClickCallback();
        };
      }
      return notif;
    } catch (err) {
      console.warn('[Hermes Watch] Window Notification failed:', err.message);
      return null;
    }
  }

  const notifiedApprovalIds = new Set();

  // --- Browser Desktop Notification Manager ---
  function triggerDesktopNotification(approval) {
    const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
    if (perm !== 'granted') {
      console.warn('[Hermes Watch] Desktop notification skipped because permission is:', perm);
      return;
    }

    if (!approval || !approval.approval_id) return;
    if (notifiedApprovalIds.has(approval.approval_id) || activeNotifications.has(approval.approval_id)) {
      console.log('[Hermes Watch] Skipping duplicate approval notification for ID:', approval.approval_id);
      return;
    }
    notifiedApprovalIds.add(approval.approval_id);
    setTimeout(() => notifiedApprovalIds.delete(approval.approval_id), 60000);

    const commandStr = approval.command ? approval.command.trim() : '';
    const descStr = approval.description ? approval.description.trim() : '';
    const title = `⚠️ Hermes 任务需要审批！`;
    const body = `${descStr ? descStr + '\n' : ''}待执行: ${commandStr || '敏感指令'}\n👉 点击弹窗立即返回页面进行审批`;
    const tag = `hermes-approval-${approval.approval_id}`;

    playAlertBeep(false);

    const notifOptions = {
      body,
      tag,
      renotify: false, // Ensure Chrome updates cleanly without popping duplicate cards
      requireInteraction: true,
      silent: false,
      data: {
        approval_id: approval.approval_id,
        session_id: approval.session_id,
        command: commandStr,
        description: descStr
      }
    };

    const notif = createNotification(title, notifOptions, () => {
      handleNotificationClickEvent(notifOptions.data);
    });

    if (notif) {
      activeNotifications.set(approval.approval_id, notif);
    }

    startTitleBlink();
  }

  let lastCompletedRunKey = null;
  let lastCompletedRunTime = 0;

  function triggerRunCompletedNotification(summary) {
    if (Notification.permission !== 'granted') return;
    if (!summary) return;

    const runKey = summary.messageId || summary.runId || summary.sessionId || 'last-run';
    const now = Date.now();
    // Debounce intermediate tool completion bursts and repeated completion events within 5 seconds
    if (lastCompletedRunKey === runKey || (now - lastCompletedRunTime < 5000)) {
      console.log('[Hermes Watch] Debouncing duplicate run.completed notification:', runKey);
      return;
    }
    lastCompletedRunKey = runKey;
    lastCompletedRunTime = now;

    // If user is actively focused on this page and reading the response, do not pop intrusive desktop banner
    // (Native Hermes UI also suppresses background notification when tab is focused and active)
    const isForeground = typeof document !== 'undefined' && !document.hidden && document.hasFocus();
    if (isForeground) {
      console.log('[Hermes Watch] User is actively in foreground, skipping desktop card popup');
      return;
    }

    playAlertBeep(true);

    const sessionTitle = summary.sessionTitle || 'Hermes 会话';
    const outputTokens = summary.stats?.outputTokens || '0';
    const cost = summary.stats?.estimatedCost || '$0';
    const title = `✅ [${sessionTitle}] 任务执行完成！`;
    const preview = (summary.preview || summary.output || '任务阶段执行完毕').slice(0, 100);
    const body = `输出: ${outputTokens} tokens | 费用: ${cost}\n${preview}\n👉 点击返回标签页查看结果`;

    // Standardized notification tag format so Chrome collapses duplicate cards
    const tag = `hermes-task-${summary.sessionId || 'active'}`;

    createNotification(title, {
      body,
      tag,
      renotify: false, // Ensure Chrome does not spam repeated popup banners
      requireInteraction: false
    }, () => {
      window.focus();
    });
  }

  function dismissDesktopNotification(approvalId) {
    const notif = activeNotifications.get(approvalId);
    if (notif) {
      try { notif.close(); } catch {}
      activeNotifications.delete(approvalId);
    }
    if (swRegistration && swRegistration.getNotifications) {
      swRegistration.getNotifications({ tag: `hermes-approval-${approvalId}` })
        .then(list => { list.forEach(n => n.close()); })
        .catch(() => {});
    }
  }

  function handleNotificationClickEvent(data) {
    window.focus();
    if (!data) return;

    const approvalId = data.approval_id;
    const approval = activeApprovals.get(approvalId) || data;
    showQuickApprovalModal(approval);
  }

  // --- Native Pinia & DOM Approval Automation ---
  function findPinia() {
    try {
      const appEl = document.getElementById('app');
      const vueApp = appEl?.__vue_app__;
      if (!vueApp) return null;

      if (vueApp.config?.globalProperties?.$pinia) {
        return vueApp.config.globalProperties.$pinia;
      }

      const provides = vueApp._context?.provides;
      if (provides) {
        for (const k of Object.keys(provides)) {
          const v = provides[k];
          if (v && (v._s instanceof Map || (v.state && v._p))) return v;
        }
        for (const s of Object.getOwnPropertySymbols(provides)) {
          const v = provides[s];
          if (v && (v._s instanceof Map || (v.state && v._p))) return v;
        }
      }
    } catch (e) {
      console.warn('[Hermes Watch] findPinia error:', e);
    }
    return null;
  }

  function getCurrentSessionInfo() {
    let id = null;
    let title = null;
    try {
      const pinia = findPinia();
      if (pinia && pinia._s) {
        const chatStore = pinia._s.get('chat');
        if (chatStore) {
          id = chatStore.activeSessionId?.value || chatStore.activeSessionId || null;
          const list = chatStore.sessions?.value || chatStore.sessions;
          if (id && Array.isArray(list)) {
            const target = list.find(s => s.id === id);
            if (target && target.title) title = target.title;
          }
        }
      }
    } catch (e) {}
    if (!id) {
      const hash = window.location.hash || '';
      const match = hash.match(/\/session\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) id = match[1];
    }
    return { id, title: title || (id ? `会话 (${id.slice(0, 8)})` : '当前活跃会话') };
  }

  function showAutoApproveToast(app) {
    playAlertBeep(true);
    let toast = document.getElementById('hm-auto-approve-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'hm-auto-approve-toast';
      toast.style.cssText = `
        position: fixed;
        bottom: 80px;
        right: 24px;
        z-index: 999999;
        background: rgba(15, 23, 42, 0.95);
        border: 1px solid rgba(56, 189, 248, 0.5);
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 15px rgba(56, 189, 248, 0.25);
        color: #f8fafc;
        padding: 10px 16px;
        border-radius: 12px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 10px;
        backdrop-filter: blur(8px);
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        transform: translateY(20px);
        opacity: 0;
      `;
      document.body.appendChild(toast);
    }
    const cmdStr = (app.command || app.description || '敏感指令').slice(0, 50);
    toast.innerHTML = `
      <span style="font-size: 18px;">⚡</span>
      <div>
        <div style="font-weight: 600; color: #38bdf8; font-size: 12.5px;">看护助手 · 当前会话自动放行</div>
        <div style="font-size: 11.5px; color: #cbd5e1; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <code>${escapeHtml(cmdStr)}</code>
        </div>
      </div>
    `;
    requestAnimationFrame(() => {
      toast.style.transform = 'translateY(0)';
      toast.style.opacity = '1';
    });
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.style.transform = 'translateY(20px)';
      toast.style.opacity = '0';
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
    }, 4000);
  }

  function triggerNativeApprovalAction(sessionId, approvalId, choice) {
    console.log('[Hermes Watch] Executing native approval action:', { sessionId, approvalId, choice });
    let resolved = false;

    // Strategy 1: Direct Vue 3 / Pinia Store Invocation
    try {
      const pinia = findPinia();
      if (pinia && pinia._s) {
        const chatStore = pinia._s.get('chat');
        const groupStore = pinia._s.get('group-chat');

        if (chatStore) {
          // 1. If store has pendingApprovals Map, check matching item
          if (chatStore.pendingApprovals?.value instanceof Map) {
            const pMap = chatStore.pendingApprovals.value;
            for (const [sId, item] of pMap.entries()) {
              if (item.approvalId === approvalId || sId === sessionId) {
                console.log('[Hermes Watch] Matched pending approval in chatStore:', sId, item.approvalId);
                if (typeof chatStore.respondApprovalFor === 'function') {
                  chatStore.respondApprovalFor(sId, item.approvalId, choice);
                  resolved = true;
                }
                // Immediately delete from reactive Map to clear native float bar
                pMap.delete(sId);
                chatStore.pendingApprovals.value = new Map(pMap);
              }
            }
          }

          // 2. Try respondApprovalFor directly
          if (!resolved && sessionId && approvalId && typeof chatStore.respondApprovalFor === 'function') {
            console.log('[Hermes Watch] Invoking chatStore.respondApprovalFor directly');
            const res = chatStore.respondApprovalFor(sessionId, approvalId, choice);
            if (res === 'submitted') resolved = true;
          }

          // 3. Fallback: try active session respondApproval
          if (!resolved && typeof chatStore.respondApproval === 'function') {
            console.log('[Hermes Watch] Invoking chatStore.respondApproval fallback');
            const res = chatStore.respondApproval(choice);
            if (res === 'submitted') resolved = true;
          }
        }

        if (groupStore) {
          if (groupStore.pendingApprovals?.value instanceof Map) {
            const gMap = groupStore.pendingApprovals.value;
            for (const [rId, item] of gMap.entries()) {
              if (item.approvalId === approvalId || rId === sessionId) {
                if (typeof groupStore.respondApprovalFor === 'function') {
                  groupStore.respondApprovalFor(rId, item.approvalId, choice);
                  resolved = true;
                }
                gMap.delete(rId);
                groupStore.pendingApprovals.value = new Map(gMap);
              }
            }
          }
          if (!resolved && sessionId && approvalId && typeof groupStore.respondApprovalFor === 'function') {
            groupStore.respondApprovalFor(sessionId, approvalId, choice);
            resolved = true;
          }
        }
      }
    } catch (err) {
      console.warn('[Hermes Watch] Pinia store invocation error:', err);
    }

    // Strategy 2: Simulate Native DOM Button Click
    try {
      const selectors = [
        '.approval-float-panel button',
        '.approval-float-actions button',
        '.global-pending-actions button',
        '.global-pending-actions-host button',
        '[class*="approval-float"] button',
        '[class*="approval"] button'
      ];
      const buttons = Array.from(document.querySelectorAll(selectors.join(', ')));

      const labelKeywords = {
        once: ['一次', '仅本次', '允许执行一次', '同意写入', '同意', 'once', 'agree', 'allow once'],
        session: ['本次会话', '会话允许', 'session', 'allow for session'],
        always: ['永久允许', '始终', 'always', 'always allow'],
        deny: ['拒绝', '不执行', 'deny', 'reject', 'cancel']
      };

      const targets = labelKeywords[choice] || [];
      for (const btn of buttons) {
        if (btn.closest('#hermes-quick-approval-overlay') || btn.closest('#hermes-mobile-widget') || btn.closest('#hermes-guardian-modal')) {
          continue;
        }
        const text = (btn.textContent || '').trim().toLowerCase();
        const matches = targets.some(kw => text.includes(kw.toLowerCase()));
        if (matches) {
          console.log('[Hermes Watch] Triggering native DOM approval button:', text);
          btn.click();
          try {
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          } catch (e) {}
          resolved = true;
          break;
        }
      }
    } catch (err) {
      console.warn('[Hermes Watch] DOM click simulation error:', err);
    }

    // Strategy 3: Broadcast Custom Event
    try {
      window.dispatchEvent(new CustomEvent('hermes:approval-resolved', {
        detail: { session_id: sessionId, approval_id: approvalId, choice }
      }));
    } catch (e) {}

    return resolved;
  }

  // --- Quick Approval In-Page Modal (Immediate 1-Click Action) ---
  function showQuickApprovalModal(approval) {
    if (!approval || !approval.approval_id) return;
    
    const existing = document.getElementById('hermes-quick-approval-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'hermes-quick-approval-overlay';
    overlay.className = 'hm-quick-overlay';

    const cmd = escapeHtml(approval.command || '无具体命令');
    const desc = escapeHtml(approval.description || 'Agent 正在请求执行敏感指令或外部工具操作');

    overlay.innerHTML = `
      <div class="hm-quick-card">
        <div class="hm-quick-header">
          <div class="hm-quick-badge">
            <span class="hm-quick-badge-dot"></span>
            <span>⚠️ 待审批命令</span>
          </div>
          <button class="hm-quick-close" id="hmQuickClose">&times;</button>
        </div>

        <div class="hm-quick-body">
          <div class="hm-quick-desc">${desc}</div>
          <div class="hm-quick-cmd-box">
            <div class="hm-quick-cmd-label">
              <span>待执行命令</span>
              <button class="hm-quick-copy-cmd" id="hmQuickCopyCmd">复制命令</button>
            </div>
            <pre class="hm-quick-cmd-content"><code>${cmd}</code></pre>
          </div>
        </div>

        <div class="hm-quick-footer">
          <div class="hm-quick-btn-group">
            <button class="hm-btn hm-btn-allow-once" data-choice="once">
              <span class="hm-btn-icon">⚡</span>
              <span>允许执行一次</span>
            </button>
            <button class="hm-btn hm-btn-allow-session" data-choice="session">
              <span class="hm-btn-icon">🕒</span>
              <span>本次会话允许</span>
            </button>
            <button class="hm-btn hm-btn-allow-always" data-choice="always">
              <span class="hm-btn-icon">🛡️</span>
              <span>永久允许</span>
            </button>
            <button class="hm-btn hm-btn-deny" data-choice="deny">
              <span class="hm-btn-icon">🛑</span>
              <span>拒绝</span>
            </button>
          </div>
          <div class="hm-quick-nav-row">
            <button type="button" class="hm-quick-nav-link" id="hmQuickNavNative">
              <span>📍 前往会话详情与原生审批卡片</span>
            </button>
          </div>
          <div class="hm-quick-hint">审批将通过原生官方链路即时生效并同步至移动端</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#hmQuickClose').onclick = () => overlay.remove();
    overlay.querySelector('#hmQuickCopyCmd').onclick = (e) => {
      navigator.clipboard.writeText(approval.command || '');
      e.target.textContent = '已复制!';
      setTimeout(() => { e.target.textContent = '复制命令'; }, 2000);
    };

    const navBtn = overlay.querySelector('#hmQuickNavNative');
    if (navBtn) {
      navBtn.onclick = () => {
        if (approval.session_id) {
          window.location.hash = `#/hermes/session/${approval.session_id}`;
          setTimeout(() => {
            const nativeBar = document.querySelector('.approval-float-panel, .global-pending-actions');
            if (nativeBar) {
              nativeBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, 300);
        }
        overlay.remove();
      };
    }

    const actionBtns = overlay.querySelectorAll('.hm-quick-btn-group button');
    actionBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const choice = btn.getAttribute('data-choice');
        actionBtns.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
        btn.innerHTML = '<span>提交中...</span>';

        await submitApprovalResponse(approval.session_id, approval.approval_id, choice);

        btn.innerHTML = '<span>✅ 已批准</span>';
        btn.style.opacity = '1';
        setTimeout(() => {
          overlay.remove();
        }, 600);
      });
    });
  }

  async function submitApprovalResponse(sessionId, approvalId, choice) {
    console.log('[Hermes Watch] Submitting approval response:', { sessionId, approvalId, choice });

    // 1. Immediately trigger native approval in current page context
    triggerNativeApprovalAction(sessionId, approvalId, choice);

    // 2. Schedule a short retry (150ms) to ensure DOM/Pinia reacts even if rendered during turn
    setTimeout(() => {
      triggerNativeApprovalAction(sessionId, approvalId, choice);
    }, 150);

    // 3. Send to companion daemon via WebSocket & HTTP
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      try {
        wsClient.send(JSON.stringify({
          type: 'approval.respond',
          session_id: sessionId,
          approval_id: approvalId,
          choice
        }));
      } catch (err) {}
    }

    try {
      await fetch(`${COMPANION_ORIGIN}/api/approval/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          approval_id: approvalId,
          choice
        })
      });
    } catch (err) {}

    activeApprovals.delete(approvalId);
    dismissDesktopNotification(approvalId);
    updateWidgetBadge();
    if (activeApprovals.size === 0) stopTitleBlink();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- WebSocket Connection to Mobile Watch Server ---
  let reconnectAttempts = 0;
  function connectWebSocket() {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      wsClient = new WebSocket(COMPANION_WS);

      wsClient.onopen = () => {
        console.log('[Hermes Watch] WebSocket connected to companion daemon');
        reconnectAttempts = 0;
        updateWidgetStatus(true);
      };

      wsClient.onclose = () => {
        updateWidgetStatus(false);
        const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts++), 10000);
        setTimeout(connectWebSocket, delay);
      };

      wsClient.onerror = () => {
        try { wsClient.close(); } catch {}
      };

      wsClient.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleCompanionMessage(msg);
        } catch (err) {}
      };
    } catch (err) {
      setTimeout(connectWebSocket, 3000);
    }
  }

  function handleCompanionMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'init':
        activeApprovals.clear();
        if (Array.isArray(msg.approvals)) {
          msg.approvals.forEach(app => {
            activeApprovals.set(app.approval_id, app);
          });
        }
        if (msg.autoApprove) {
          autoApproveCurrentSession = Boolean(msg.autoApprove.enabled);
          autoApproveSessionId = msg.autoApprove.sessionId;
        }
        updateWidgetBadge();
        break;

      case 'auto_approve_changed':
        autoApproveCurrentSession = Boolean(msg.enabled);
        autoApproveSessionId = msg.sessionId;
        break;

      case 'approval.auto_resolved':
        if (msg.approval_id) {
          triggerNativeApprovalAction(msg.session_id, msg.approval_id, 'session');
          activeApprovals.delete(msg.approval_id);
          dismissDesktopNotification(msg.approval_id);
          updateWidgetBadge();
        }
        showAutoApproveToast(msg);
        break;

      case 'approval.requested':
        if (msg.approval && msg.approval.approval_id) {
          activeApprovals.set(msg.approval.approval_id, msg.approval);
          updateWidgetBadge();
          triggerDesktopNotification(msg.approval);
        }
        break;

      case 'approval.resolved':
      case 'execute_native_approval':
        if (msg.approval_id || msg.session_id) {
          triggerNativeApprovalAction(msg.session_id, msg.approval_id, msg.choice);
          if (msg.approval_id) {
            activeApprovals.delete(msg.approval_id);
            dismissDesktopNotification(msg.approval_id);
            updateWidgetBadge();
          }
          if (activeApprovals.size === 0) stopTitleBlink();

          const overlay = document.getElementById('hermes-quick-approval-overlay');
          if (overlay) overlay.remove();
        }
        break;

      case 'run.completed':
        if (msg.summary) {
          triggerRunCompletedNotification(msg.summary);
        }
        break;

      case 'clarify.requested':
        if (msg.clarify && msg.clarify.clarify_id) {
          triggerClarifyNotification(msg.clarify);
        }
        break;
    }
  }

  const notifiedClarifyIds = new Set();

  function triggerClarifyNotification(clarify) {
    if (Notification.permission !== 'granted') return;
    if (!clarify || !clarify.clarify_id) return;
    if (notifiedClarifyIds.has(clarify.clarify_id)) return;
    notifiedClarifyIds.add(clarify.clarify_id);
    setTimeout(() => notifiedClarifyIds.delete(clarify.clarify_id), 60000);

    playAlertBeep(false);
    const title = `❓ Hermes Agent 待确认选择`;
    const body = `问题: ${clarify.question || '有需要您决策的内容'}\n👉 点击弹窗返回页面进行选择`;
    
    createNotification(title, {
      body,
      tag: `hermes-clarify-${clarify.clarify_id}`,
      renotify: false,
      requireInteraction: true
    }, () => {
      window.focus();
    });
    startTitleBlink('【❓ 待选择】');
  }

  // --- Fetch Companion Info API ---
  async function fetchCompanionInfo(sessionId) {
    try {
      const url = sessionId
        ? `${COMPANION_ORIGIN}/api/info?session=${encodeURIComponent(sessionId)}`
        : `${COMPANION_ORIGIN}/api/info`;
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.autoApprove) {
        autoApproveCurrentSession = Boolean(data.autoApprove.enabled);
        autoApproveSessionId = data.autoApprove.sessionId;
      }
      return data;
    } catch (err) {
      return null;
    }
  }

  // --- UI Styles Injection ---
  function injectStyles() {
    if (document.getElementById('hermes-companion-enhanced-style')) return;
    const style = document.createElement('style');
    style.id = 'hermes-companion-enhanced-style';
    style.textContent = `
      .hm-widget-btn {
        position: fixed !important;
        bottom: 110px !important;
        right: 24px !important;
        z-index: 2147483640 !important;
        width: 40px !important;
        height: 40px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        background: rgba(18, 22, 30, 0.92) !important;
        backdrop-filter: blur(14px) !important;
        -webkit-backdrop-filter: blur(14px) !important;
        border: 1.5px solid rgba(255, 255, 255, 0.16) !important;
        color: #f1f5f9 !important;
        padding: 0 !important;
        border-radius: 50% !important;
        cursor: grab !important;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45) !important;
        transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s !important;
        user-select: none !important;
        touch-action: none !important;
      }
      .hm-widget-btn:active {
        cursor: grabbing !important;
      }
      .hm-widget-btn:hover {
        background: rgba(28, 35, 48, 0.98) !important;
        border-color: #38bdf8 !important;
        box-shadow: 0 8px 24px rgba(56, 189, 248, 0.35) !important;
        transform: scale(1.08) !important;
      }
      .hm-widget-icon {
        font-size: 19px !important;
        line-height: 1 !important;
        pointer-events: none !important;
      }
      .hm-widget-dot {
        position: absolute !important;
        top: 2px !important;
        right: 2px !important;
        width: 8px !important;
        height: 8px !important;
        border-radius: 50% !important;
        border: 1.5px solid #12161e !important;
        background: #10b981 !important;
        box-shadow: 0 0 6px #10b981 !important;
        transition: all 0.3s ease !important;
        pointer-events: none !important;
      }
      .hm-widget-badge {
        display: none;
        position: absolute !important;
        top: -4px !important;
        right: -4px !important;
        background: #ef4444 !important;
        color: #ffffff !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        border-radius: 10px !important;
        min-width: 16px !important;
        height: 16px !important;
        padding: 0 3px !important;
        align-items: center !important;
        justify-content: center !important;
        border: 1.5px solid #0f172a !important;
        box-shadow: 0 0 8px rgba(239, 68, 68, 0.6) !important;
        pointer-events: none !important;
      }
      .hm-widget-btn.has-approvals {
        background: linear-gradient(135deg, rgba(234, 88, 12, 0.95), rgba(194, 65, 12, 0.95)) !important;
        border-color: #fb923c !important;
        box-shadow: 0 0 20px rgba(249, 115, 22, 0.6) !important;
        animation: hmPulseBtn 1.8s infinite !important;
      }
      .hm-widget-btn.has-approvals .hm-widget-dot {
        display: none !important;
      }
      @keyframes hmPulseBtn {
        0%, 100% { transform: scale(1); box-shadow: 0 0 16px rgba(249, 115, 22, 0.6); }
        50% { transform: scale(1.08); box-shadow: 0 0 24px rgba(249, 115, 22, 0.9); }
      }

      .hm-modal-overlay {
        position: fixed !important;
        inset: 0 !important;
        background: rgba(0, 0, 0, 0.72) !important;
        backdrop-filter: blur(10px) !important;
        -webkit-backdrop-filter: blur(10px) !important;
        z-index: 2147483645 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        animation: hmFadeIn 0.2s ease !important;
      }
      @keyframes hmFadeIn { from { opacity: 0; } to { opacity: 1; } }

      .hm-modal {
        background: #15171e !important;
        border: 1px solid rgba(255, 255, 255, 0.16) !important;
        border-radius: 20px !important;
        width: 480px !important;
        max-width: 94vw !important;
        max-height: 92vh !important;
        display: flex !important;
        flex-direction: column !important;
        color: #f8fafc !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        box-shadow: 0 24px 56px rgba(0, 0, 0, 0.7) !important;
        position: relative !important;
        overflow: hidden !important;
      }
      .hm-modal-header {
        padding: 18px 24px 14px !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
      }
      .hm-modal-title-wrap {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
      }
      .hm-modal-title {
        font-size: 17px !important;
        font-weight: 700 !important;
        color: #f8fafc !important;
      }
      .hm-close-btn {
        background: rgba(255, 255, 255, 0.06) !important;
        border: 1px solid rgba(255, 255, 255, 0.12) !important;
        border-radius: 50% !important;
        width: 30px !important;
        height: 30px !important;
        color: #94a3b8 !important;
        font-size: 18px !important;
        cursor: pointer !important;
        display: grid !important;
        place-items: center !important;
        line-height: 1 !important;
        transition: all 0.2s !important;
      }
      .hm-close-btn:hover {
        background: rgba(255, 255, 255, 0.15) !important;
        color: #fff !important;
      }

      .hm-tabs {
        display: flex !important;
        padding: 6px 20px !important;
        background: rgba(0, 0, 0, 0.25) !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
        gap: 8px !important;
      }
      .hm-tab-btn {
        flex: 1 !important;
        padding: 8px 12px !important;
        background: transparent !important;
        border: none !important;
        border-radius: 10px !important;
        color: #94a3b8 !important;
        font-size: 13px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        transition: all 0.2s !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
      }
      .hm-tab-btn.active {
        background: rgba(255, 255, 255, 0.12) !important;
        color: #f8fafc !important;
      }

      .hm-modal-content {
        padding: 18px 24px !important;
        overflow-y: auto !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 16px !important;
      }

      .hm-feature-card {
        background: rgba(255, 255, 255, 0.04) !important;
        border: 1px solid rgba(255, 255, 255, 0.09) !important;
        border-radius: 14px !important;
        padding: 14px 16px !important;
      }
      .hm-feature-title {
        font-size: 14px !important;
        font-weight: 600 !important;
        color: #f1f5f9 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        margin-bottom: 6px !important;
      }
      .hm-feature-desc {
        font-size: 12px !important;
        color: #94a3b8 !important;
        line-height: 1.5 !important;
        margin-bottom: 12px !important;
      }
      .hm-status-badge {
        font-size: 11px !important;
        padding: 2px 8px !important;
        border-radius: 999px !important;
        font-weight: 600 !important;
      }
      .hm-status-granted {
        background: rgba(16, 185, 129, 0.18) !important;
        color: #34d399 !important;
        border: 1px solid rgba(16, 185, 129, 0.3) !important;
      }
      .hm-status-denied {
        background: rgba(239, 68, 68, 0.18) !important;
        color: #f87171 !important;
        border: 1px solid rgba(239, 68, 68, 0.3) !important;
      }
      .hm-status-default {
        background: rgba(234, 179, 8, 0.18) !important;
        color: #facc15 !important;
        border: 1px solid rgba(234, 179, 8, 0.3) !important;
      }

      .hm-btn-row {
        display: flex !important;
        gap: 8px !important;
        margin-top: 6px !important;
      }
      .hm-act-btn {
        flex: 1 !important;
        padding: 9px 12px !important;
        border-radius: 10px !important;
        font-size: 12.5px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        border: none !important;
        transition: all 0.2s !important;
      }
      .hm-act-btn-primary { background: #2563eb !important; color: #fff !important; }
      .hm-act-btn-primary:hover { background: #1d4ed8 !important; }
      .hm-act-btn-success { background: #059669 !important; color: #fff !important; }
      .hm-act-btn-success:hover { background: #047857 !important; }
      .hm-act-btn-win { background: #7c3aed !important; color: #fff !important; }
      .hm-act-btn-win:hover { background: #6d28d9 !important; }
      .hm-act-btn-secondary {
        background: rgba(255, 255, 255, 0.08) !important;
        color: #e2e8f0 !important;
        border: 1px solid rgba(255, 255, 255, 0.14) !important;
      }
      .hm-act-btn-secondary:hover { background: rgba(255, 255, 255, 0.14) !important; }

      .hm-troubleshoot-details {
        background: rgba(255, 255, 255, 0.03) !important;
        border: 1px dashed rgba(255, 255, 255, 0.14) !important;
        border-radius: 10px !important;
        padding: 8px 12px !important;
        font-size: 11.5px !important;
        color: #94a3b8 !important;
        cursor: pointer !important;
      }
      .hm-troubleshoot-summary {
        font-weight: 500 !important;
        color: #fbbf24 !important;
        outline: none !important;
        user-select: none !important;
      }
      .hm-troubleshoot-content {
        margin-top: 8px !important;
        padding-top: 6px !important;
        border-top: 1px solid rgba(255, 255, 255, 0.06) !important;
        line-height: 1.6 !important;
        color: #94a3b8 !important;
      }

      /* Quick Approval Modal */
      .hm-quick-overlay {
        position: fixed !important;
        inset: 0 !important;
        background: rgba(0, 0, 0, 0.75) !important;
        backdrop-filter: blur(12px) !important;
        -webkit-backdrop-filter: blur(12px) !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        animation: hmFadeIn 0.2s ease !important;
      }
      .hm-quick-card {
        background: #161820 !important;
        border: 1px solid rgba(249, 115, 22, 0.4) !important;
        border-radius: 20px !important;
        width: 520px !important;
        max-width: 92vw !important;
        color: #f8fafc !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        box-shadow: 0 25px 60px rgba(0, 0, 0, 0.75), 0 0 30px rgba(249, 115, 22, 0.15) !important;
        overflow: hidden !important;
      }
      .hm-quick-header {
        padding: 16px 20px !important;
        background: rgba(234, 88, 12, 0.08) !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
      }
      .hm-quick-badge {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        font-size: 15px !important;
        font-weight: 700 !important;
        color: #fb923c !important;
      }
      .hm-quick-badge-dot {
        width: 8px !important;
        height: 8px !important;
        border-radius: 50% !important;
        background: #f97316 !important;
        box-shadow: 0 0 8px #f97316 !important;
      }
      .hm-quick-close {
        background: transparent !important;
        border: none !important;
        color: #94a3b8 !important;
        font-size: 20px !important;
        cursor: pointer !important;
        padding: 0 4px !important;
      }
      .hm-quick-close:hover { color: #fff !important; }

      .hm-quick-body {
        padding: 20px !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 14px !important;
      }
      .hm-quick-desc {
        font-size: 13.5px !important;
        color: #e2e8f0 !important;
        line-height: 1.5 !important;
      }
      .hm-quick-cmd-box {
        background: #0d0f14 !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        border-radius: 12px !important;
        padding: 12px 14px !important;
      }
      .hm-quick-cmd-label {
        font-size: 11px !important;
        color: #64748b !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        margin-bottom: 8px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
      }
      .hm-quick-copy-cmd {
        background: transparent !important;
        border: 1px solid rgba(255, 255, 255, 0.12) !important;
        color: #94a3b8 !important;
        padding: 2px 8px !important;
        border-radius: 4px !important;
        font-size: 11px !important;
        cursor: pointer !important;
      }
      .hm-quick-copy-cmd:hover { color: #fff !important; border-color: rgba(255, 255, 255, 0.25) !important; }
      .hm-quick-cmd-content {
        margin: 0 !important;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
        font-size: 13px !important;
        color: #38bdf8 !important;
        white-space: pre-wrap !important;
        word-break: break-all !important;
        max-height: 180px !important;
        overflow-y: auto !important;
      }

      .hm-quick-footer {
        padding: 16px 20px 20px !important;
        background: rgba(0, 0, 0, 0.2) !important;
        border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
      }
      .hm-quick-btn-group {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 10px !important;
      }
      .hm-btn {
        padding: 12px 14px !important;
        border-radius: 12px !important;
        font-size: 13px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        border: none !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        transition: all 0.2s !important;
      }
      .hm-btn-allow-once { background: #10b981 !important; color: #ffffff !important; }
      .hm-btn-allow-once:hover { background: #059669 !important; }
      .hm-btn-allow-session { background: #f59e0b !important; color: #ffffff !important; }
      .hm-btn-allow-session:hover { background: #d97706 !important; }
      .hm-btn-allow-always { background: #3b82f6 !important; color: #ffffff !important; }
      .hm-btn-allow-always:hover { background: #2563eb !important; }
      .hm-btn-deny { background: #ef4444 !important; color: #ffffff !important; }
      .hm-quick-nav-row {
        margin-top: 10px !important;
        display: flex !important;
        justify-content: center !important;
      }
      .hm-quick-nav-link {
        background: transparent !important;
        border: 1px dashed rgba(255, 255, 255, 0.22) !important;
        border-radius: 999px !important;
        color: #94a3b8 !important;
        padding: 5px 14px !important;
        font-size: 11.5px !important;
        cursor: pointer !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        transition: all 0.2s !important;
      }
      .hm-quick-nav-link:hover {
        background: rgba(255, 255, 255, 0.08) !important;
        color: #38bdf8 !important;
        border-color: #38bdf8 !important;
      }
      .hm-quick-hint {
        font-size: 11px !important;
        color: #64748b !important;
        text-align: center !important;
        margin-top: 10px !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // --- Floating Button Rendering with Draggable Support ---
  function renderFloatingButton() {
    if (document.getElementById('hermes-mobile-widget')) return;

    const btn = document.createElement('div');
    btn.id = 'hermes-mobile-widget';
    btn.className = 'hm-widget-btn';
    btn.setAttribute('title', '看护助手 (可拖拽)');
    btn.innerHTML = `
      <span class="hm-widget-icon">📱</span>
      <span class="hm-widget-dot"></span>
      <span class="hm-widget-badge"></span>
    `;

    // Restore saved position if valid
    try {
      const savedPos = JSON.parse(localStorage.getItem('hm_widget_pos') || 'null');
      if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
        const maxX = Math.max(0, window.innerWidth - 48);
        const maxY = Math.max(0, window.innerHeight - 48);
        const clampX = Math.min(Math.max(8, savedPos.left), maxX);
        const clampY = Math.min(Math.max(8, savedPos.top), maxY);
        btn.style.left = `${clampX}px`;
        btn.style.top = `${clampY}px`;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
      }
    } catch {}

    const target = document.body || document.documentElement;
    target.appendChild(btn);

    // Draggable Implementation (Mouse + Touch)
    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let initialX = 0, initialY = 0;

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      isDragging = true;
      hasMoved = false;
      const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      startX = clientX;
      startY = clientY;

      const rect = btn.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;

      btn.style.transition = 'none';
      btn.style.cursor = 'grabbing';

      window.addEventListener('mousemove', onPointerMove, { passive: false });
      window.addEventListener('mouseup', onPointerUp, { passive: false });
      window.addEventListener('touchmove', onPointerMove, { passive: false });
      window.addEventListener('touchend', onPointerUp, { passive: false });
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      const dx = clientX - startX;
      const dy = clientY - startY;

      if (!hasMoved && Math.hypot(dx, dy) > 5) {
        hasMoved = true;
      }

      if (hasMoved) {
        try { e.preventDefault(); } catch {}
        const maxX = Math.max(0, window.innerWidth - 48);
        const maxY = Math.max(0, window.innerHeight - 48);
        const newX = Math.min(Math.max(8, initialX + dx), maxX);
        const newY = Math.min(Math.max(8, initialY + dy), maxY);

        btn.style.left = `${newX}px`;
        btn.style.top = `${newY}px`;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
      }
    }

    function onPointerUp() {
      if (!isDragging) return;
      isDragging = false;
      btn.style.cursor = 'grab';
      btn.style.transition = '';

      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      window.removeEventListener('touchmove', onPointerMove);
      window.removeEventListener('touchend', onPointerUp);

      if (hasMoved) {
        const rect = btn.getBoundingClientRect();
        try {
          localStorage.setItem('hm_widget_pos', JSON.stringify({ left: rect.left, top: rect.top }));
        } catch {}
      } else {
        openGuardianModal();
      }
    }

    btn.addEventListener('mousedown', onPointerDown);
    btn.addEventListener('touchstart', onPointerDown, { passive: false });
  }

  function updateWidgetStatus(connected) {
    const btn = document.getElementById('hermes-mobile-widget');
    if (!btn) return;
    const dot = btn.querySelector('.hm-widget-dot');
    if (dot) {
      if (activeApprovals.size > 0) {
        dot.style.background = '#ffffff';
      } else {
        dot.style.background = connected ? '#10b981' : '#f59e0b';
        dot.style.boxShadow = connected ? '0 0 6px #10b981' : '0 0 6px #f59e0b';
      }
    }
  }

  function updateWidgetBadge() {
    const btn = document.getElementById('hermes-mobile-widget');
    if (!btn) return;

    const count = activeApprovals.size;
    const badge = btn.querySelector('.hm-widget-badge');
    const dot = btn.querySelector('.hm-widget-dot');

    if (count > 0) {
      btn.classList.add('has-approvals');
      if (badge) {
        badge.style.display = 'flex';
        badge.textContent = count > 9 ? '9+' : String(count);
      }
      if (dot) dot.style.display = 'none';
      btn.setAttribute('title', `看护助手 (${count} 个待审批命令)`);
    } else {
      btn.classList.remove('has-approvals');
      if (badge) badge.style.display = 'none';
      if (dot) dot.style.display = 'block';
      btn.setAttribute('title', '看护助手 (可拖拽)');
    }
    updateWidgetStatus(wsClient && wsClient.readyState === WebSocket.OPEN);
  }

  // --- Main Guardian Modal (Tabbed: Desktop + Mobile) ---
  async function openGuardianModal() {
    const existing = document.getElementById('hermes-guardian-modal-overlay');
    if (existing) existing.remove();

    const currentSession = getCurrentSessionInfo();
    const info = await fetchCompanionInfo(currentSession?.id) || companionInfo || {};
    companionInfo = info;

    const overlay = document.createElement('div');
    overlay.id = 'hermes-guardian-modal-overlay';
    overlay.className = 'hm-modal-overlay';

    function renderModalContent() {
      const currentSessionInfo = getCurrentSessionInfo();
      const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
      let permBadge = '';
      if (perm === 'granted') {
        permBadge = '<span class="hm-status-badge hm-status-granted">✅ 已开启</span>';
      } else if (perm === 'denied') {
        permBadge = '<span class="hm-status-badge hm-status-denied">🚫 已拒绝 (请在浏览器中允许)</span>';
      } else {
        permBadge = '<span class="hm-status-badge hm-status-default">⚠️ 未开启</span>';
      }

      const desktopTabHtml = `
        <div class="hm-feature-card">
          <div class="hm-feature-title">
            <span>🖥️ 浏览器桌面通知</span>
            ${permBadge}
          </div>
          <div class="hm-feature-desc">
            后台或最小化时在屏幕角落弹出横幅，点击直接唤醒本页面。
          </div>
          
          ${perm !== 'granted' ? `
            <button class="hm-act-btn hm-act-btn-primary" id="hmBtnRequestPerm">
              <span>🔔 开启桌面通知权限</span>
            </button>
          ` : `
            <div class="hm-btn-row">
              <button class="hm-act-btn hm-act-btn-success" id="hmBtnTestInstant">
                <span>⚡ 立即测试</span>
              </button>
              <button class="hm-act-btn hm-act-btn-secondary" id="hmBtnTestNotif">
                <span>⏳ 延时 3s 测试</span>
              </button>
            </div>
          `}
        </div>

        <div class="hm-feature-card">
          <div class="hm-feature-title">
            <span>💻 Windows 置顶强弹窗</span>
            <span class="hm-status-badge hm-status-granted">✨ 免打扰穿透</span>
          </div>
          <div class="hm-feature-desc">
            系统底层直接置顶弹窗，穿透静音、全屏与 Windows 免打扰模式。
          </div>
          <button class="hm-act-btn hm-act-btn-win" id="hmBtnTestWinAlert">
            <span>🚀 测试置顶强弹</span>
          </button>
        </div>

        <details class="hm-troubleshoot-details">
          <summary class="hm-troubleshoot-summary">❓ 听见声音但未见横幅？点击排查</summary>
          <div class="hm-troubleshoot-content">
            1. Windows 开启「专注助手/请勿打扰」时，横幅会被收录至右下角通知中心；<br/>
            2. 可在 Windows【设置 → 系统 → 通知】中确保允许 Chrome 显示横幅；<br/>
            3. 若横幅被拦截，上方的「Windows 置顶强弹窗」仍会强行置顶提醒。
          </div>
        </details>

        <div class="hm-feature-card">
          <div class="hm-feature-title">
            <span>⚠️ 待审批任务</span>
            <span class="hm-status-badge ${activeApprovals.size > 0 ? 'hm-status-default' : 'hm-status-granted'}">
              ${activeApprovals.size} 项待处理
            </span>
          </div>
          ${activeApprovals.size > 0 ? `
            <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
              ${Array.from(activeApprovals.values()).map(app => `
                <div style="background:#0e1015; border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px; display:flex; align-items:center; justify-content:space-between;">
                  <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:280px; font-size:12.5px; color:#38bdf8;">
                    ${escapeHtml(app.command || app.description || '待审批指令')}
                  </div>
                  <button class="hm-btn hm-btn-allow-once" style="padding:6px 12px; font-size:12px;" onclick="window.__HERMES_OPEN_QUICK_APPROVAL__('${app.approval_id}')">
                    去审批
                  </button>
                </div>
              `).join('')}
            </div>
          ` : `
            <div style="font-size:12px; color:#64748b; padding:2px 0;">当前暂无待审批任务</div>
          `}
        </div>

        <div class="hm-feature-card" style="display:flex; align-items:center; justify-content:space-between;">
          <div>
            <div style="font-size:13.5px; font-weight:600; color:#f1f5f9;">🔊 提示声音</div>
            <div style="font-size:11.5px; color:#64748b;">审批警报音与任务完成音</div>
          </div>
          <input type="checkbox" id="hmSoundToggle" ${soundEnabled ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;" />
        </div>

        <div class="hm-feature-card">
          <div class="hm-feature-title">
            <div style="display:flex; align-items:center; gap:8px;">
              <span>⚡ 自动审批托管 (全会话免审批)</span>
              ${autoApproveCurrentSession ? '<span class="hm-status-badge hm-status-granted">✅ 自动放行中</span>' : '<span class="hm-status-badge hm-status-default">未开启</span>'}
            </div>
            <input type="checkbox" id="hmAutoApproveToggle" ${autoApproveCurrentSession ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;" />
          </div>
          <div class="hm-feature-desc">
            开启后，Agent 在执行任何命令或工具时，由看护助手后台毫秒级自动放行，无需人工确认，彻底告别审批弹窗与超时中断。
          </div>
          ${autoApproveCurrentSession ? `
            <div style="margin-top:8px; font-size:12px; color:#38bdf8; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.2); border-radius:8px; padding:6px 10px; display:flex; align-items:center; justify-content:space-between;">
              <span>🛡️ 托管范围: <b>全局所有会话与子任务</b></span>
              <span style="font-size:11px; color:#94a3b8;">自动放行已持久生效</span>
            </div>
          ` : ''}
        </div>
      `;

      const mobileTabHtml = `
        <div style="text-align:center;">
          <div style="font-size:12.5px; color:#94a3b8; margin-bottom:12px;">
            同一 Wi-Fi 下扫码，手机锁屏也能接收通知与审批。
          </div>
          <div style="background:#ffffff; padding:10px; border-radius:14px; display:inline-block; margin-bottom:12px;">
            <img src="${info.qrDataUrl || ''}" alt="QR Code" style="width:170px; height:170px; display:block;" />
          </div>
          <div style="background:#0f1013; border:1px solid #282a32; border-radius:8px; padding:8px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; font-size:12.5px; font-family:monospace; color:#93c5fd;">
            <span>${info.lanUrl || '加载中...'}</span>
            <div style="display:flex; gap:6px;">
              <button class="hm-refresh-ip-btn" id="hmRefreshIpBtn" style="background:#334155; color:#fff; border:none; padding:4px 8px; border-radius:5px; font-size:11.5px; cursor:pointer;" title="切换Wi-Fi后点击重新获取最新IP">🔄 刷新网络</button>
              <button class="hm-copy-btn" id="hmCopyBtn" style="background:#2563eb; color:#fff; border:none; padding:4px 10px; border-radius:5px; font-size:11.5px; cursor:pointer;">复制</button>
            </div>
          </div>
          <div style="font-size:11.5px; color:#64748b; display:flex; align-items:center; justify-content:center; gap:6px;">
            <span class="hm-widget-dot" style="background:${info.hermesConnected ? '#10b981' : '#f59e0b'}"></span>
            <span>伴侣服务就绪 · 手机已连接 ${info.connectedMobileClients || 0} 台</span>
          </div>
        </div>
      `;

      overlay.innerHTML = `
        <div class="hm-modal">
          <div class="hm-modal-header">
            <div class="hm-modal-title-wrap">
              <span style="font-size:18px;">🛡️</span>
              <span class="hm-modal-title">Hermes 看护助手</span>
            </div>
            <button class="hm-close-btn" id="hmCloseModal">&times;</button>
          </div>

          <div class="hm-tabs">
            <button class="hm-tab-btn ${activeTab === 'desktop' ? 'active' : ''}" id="hmTabDesktop">
              <span>🖥️ 桌面弹窗</span>
            </button>
            <button class="hm-tab-btn ${activeTab === 'mobile' ? 'active' : ''}" id="hmTabMobile">
              <span>📱 手机协同</span>
            </button>
          </div>

          <div class="hm-modal-content">
            ${activeTab === 'desktop' ? desktopTabHtml : mobileTabHtml}
          </div>
        </div>
      `;

      bindModalEvents();
    }

    function bindModalEvents() {
      overlay.querySelector('#hmCloseModal').onclick = () => overlay.remove();

      overlay.querySelector('#hmTabDesktop').onclick = () => {
        activeTab = 'desktop';
        renderModalContent();
      };
      overlay.querySelector('#hmTabMobile').onclick = () => {
        activeTab = 'mobile';
        renderModalContent();
      };

      const copyBtn = overlay.querySelector('#hmCopyBtn');
      if (copyBtn) {
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(info.lanUrl || '');
          copyBtn.textContent = '已复制!';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
        };
      }

      const refreshIpBtn = overlay.querySelector('#hmRefreshIpBtn');
      if (refreshIpBtn) {
        refreshIpBtn.onclick = async () => {
          refreshIpBtn.textContent = '🔄 检测中...';
          const currentSession = getCurrentSessionInfo();
          const fresh = await fetchCompanionInfo(currentSession?.id);
          if (fresh) {
            companionInfo = fresh;
            renderModalContent();
          }
        };
      }

      const autoToggle = overlay.querySelector('#hmAutoApproveToggle');
      if (autoToggle) {
        autoToggle.onchange = async () => {
          const enabled = autoToggle.checked;
          autoApproveCurrentSession = enabled;
          autoApproveSessionId = enabled ? '*' : null;
          try {
            await fetch(`${COMPANION_ORIGIN}/api/auto-approve`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled, sessionId: '*' })
            });
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
              wsClient.send(JSON.stringify({ type: 'set_auto_approve', enabled, sessionId: '*' }));
            }
          } catch (e) {}
          renderModalContent();
        };
      }

      const reqBtn = overlay.querySelector('#hmBtnRequestPerm');
      if (reqBtn) {
        reqBtn.onclick = async () => {
          try {
            const p = await Notification.requestPermission();
            if (p === 'granted') {
              setupServiceWorker();
              alert('🎉 桌面通知权限开启成功！下次需要审批时将直接弹出系统窗口。');
            } else if (p === 'denied') {
              alert('⚠️ 您已屏蔽通知权限，请点击 Chrome 地址栏左侧的设置图标，将“通知”设为“允许”。');
            }
            renderModalContent();
          } catch (e) {
            alert('获取权限失败: ' + e.message);
          }
        };
      }

      // Test Instant Browser Notification
      const instantBtn = overlay.querySelector('#hmBtnTestInstant');
      if (instantBtn) {
        instantBtn.onclick = () => {
          playAlertBeep(false);
          const notif = createNotification('🔔 Hermes 浏览器桌面弹窗测试成功！', {
            body: '恭喜！浏览器桌面弹窗通道完全通畅。\n点击此通知即可测试窗口聚焦。',
            tag: 'test-instant-' + Date.now()
          }, () => {
            window.focus();
            alert('🎉 点击弹窗唤醒标签页成功！');
          });
          if (!notif && (!swRegistration || !swRegistration.showNotification)) {
            alert('⚠️ 无法创建通知，请确保已授予通知权限。');
          }
        };
      }

      // Test 3s Countdown Background Notification
      const testBtn = overlay.querySelector('#hmBtnTestNotif');
      if (testBtn) {
        testBtn.onclick = () => {
          let count = 3;
          testBtn.disabled = true;
          testBtn.innerHTML = `<span>⏳ ${count}s 内切到后台...</span>`;
          
          const cd = setInterval(() => {
            count--;
            if (count > 0) {
              testBtn.innerHTML = `<span>⏳ ${count}s 内切到后台...</span>`;
            } else {
              clearInterval(cd);
              testBtn.disabled = false;
              testBtn.innerHTML = `<span>⏳ 延时 3s 测试</span>`;
              
              triggerDesktopNotification({
                approval_id: 'test-' + Date.now(),
                session_id: 'test-session',
                command: 'echo "Hermes Desktop Guardian Test OK!"',
                description: '【测试弹窗】点击此通知返回本页面'
              });
            }
          }, 1000);
        };
      }

      // Test Windows Native Alert
      const winBtn = overlay.querySelector('#hmBtnTestWinAlert');
      if (winBtn) {
        winBtn.onclick = async () => {
          winBtn.disabled = true;
          winBtn.innerHTML = '<span>🚀 唤起中...</span>';
          try {
            const res = await fetch(`${COMPANION_ORIGIN}/api/test-windows-alert`, { method: 'POST' });
            if (res.ok) {
              winBtn.innerHTML = '<span>✅ 置顶弹窗已触发</span>';
            } else {
              winBtn.innerHTML = '<span>⚠️ 触发失败</span>';
            }
          } catch (err) {
            winBtn.innerHTML = '<span>❌ 服务未连接</span>';
          }
          setTimeout(() => {
            winBtn.disabled = false;
            winBtn.innerHTML = '<span>🚀 测试置顶强弹</span>';
          }, 3000);
        };
      }

      const soundToggle = overlay.querySelector('#hmSoundToggle');
      if (soundToggle) {
        soundToggle.onchange = (e) => {
          soundEnabled = e.target.checked;
        };
      }
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    try {
      renderModalContent();
    } catch (err) {
      console.error('[Hermes Watch] renderModalContent failed:', err);
      overlay.innerHTML = `
        <div class="hm-modal" style="padding:24px; text-align:center;">
          <div style="font-size:16px; font-weight:600; color:#ef4444; margin-bottom:8px;">⚠️ 看护助手加载失败</div>
          <div style="font-size:12px; color:#94a3b8; margin-bottom:14px;">${escapeHtml(err.message)}</div>
          <button class="hm-btn hm-btn-allow-once" onclick="this.closest('.hm-modal-overlay').remove()">关闭</button>
        </div>
      `;
    }
  }

  // Global helper for opening modal by id
  window.__HERMES_OPEN_QUICK_APPROVAL__ = (id) => {
    const app = activeApprovals.get(id);
    if (app) {
      const modal = document.getElementById('hermes-guardian-modal-overlay');
      if (modal) modal.remove();
      showQuickApprovalModal(app);
    }
  };

  // --- Bootstrap ---
  async function init() {
    try {
      injectStyles();
      renderFloatingButton();

      companionInfo = await fetchCompanionInfo();
      updateWidgetStatus(Boolean(companionInfo));
      connectWebSocket();

      if ('Notification' in window && Notification.permission === 'granted') {
        setupServiceWorker();
      }
    } catch (err) {
      console.warn('[Hermes Watch] Widget bootstrap error:', err);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
