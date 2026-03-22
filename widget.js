/* ═══════════════════════════════════════════════════════════════════
   IAM Platform — Embeddable Widget v3
   Place at: widget.js in your repo root
   ═══════════════════════════════════════════════════════════════════ */

(function (window, document) {
  'use strict';

  var cfg         = window.IAMConfig || {};
  var BOT_ID      = cfg.botId;
  var COLOR       = cfg.color      || '#6c63ff';
  var POSITION    = cfg.position   || 'bottom-right';
  var CONTAINER_ID = cfg.containerId || null;
  var IS_INLINE   = POSITION === 'inline' && CONTAINER_ID;

  if (!BOT_ID) { console.warn('[IAM] No botId in IAMConfig'); return; }

  // ── API base ───────────────────────────────────────────────────────
  var API_BASE = (function () {
    var tags = document.getElementsByTagName('script');
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].src && tags[i].src.indexOf('widget.js') !== -1) {
        return tags[i].src.replace('/widget.js', '');
      }
    }
    return window.location.origin;
  })();

  // ── State ──────────────────────────────────────────────────────────
  var convId         = null;
  var isSending      = false;
  var botConfig      = { name: 'Assistant', color: COLOR, avatarUrl: '', greeting: 'Hi! How can I help you today?' };

  // HITL state
  var _pollInterval  = null;
  var _statusInterval = null;
  var _lastMsgAt     = null;
  var _hitlActive    = false;
  var _shownSysMsgs  = {};
  var _shownMsgIds   = {};

  // Pre-chat form state
  var _preChatDone  = false;
  var _preChatName  = '';
  var _preChatEmail = '';

  // ── Visitor ID ─────────────────────────────────────────────────────
  function getVisitorId() {
    var k = 'iam_visitor_id';
    var id = localStorage.getItem(k);
    if (!id) {
      id = 'vis_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem(k, id);
    }
    return id;
  }

  // ── Position ───────────────────────────────────────────────────────
  var POS = { 'bottom-right': 'bottom:24px;right:24px;', 'bottom-left': 'bottom:24px;left:24px;', 'top-right': 'top:24px;right:24px;', 'top-left': 'top:24px;left:24px;' };
  var pos = IS_INLINE ? '' : (POS[POSITION] || POS['bottom-right']);

  // ── Styles ─────────────────────────────────────────────────────────
  var css = document.createElement('style');
  css.textContent = [
    IS_INLINE ? '' : '#iam-launcher{position:fixed;' + pos + 'width:58px;height:58px;background:' + COLOR + ';border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 4px 24px rgba(0,0,0,.22);cursor:pointer;z-index:2147483647;border:none;transition:transform .2s;overflow:hidden;}',
    IS_INLINE ? '' : '#iam-launcher:hover{transform:scale(1.08);}',
    IS_INLINE ? '' : '#iam-launcher img{width:100%;height:100%;object-fit:cover;border-radius:50%;}',
    IS_INLINE ? '' : (function(){ var r=POSITION.indexOf('right')!==-1; var t=POSITION.indexOf('top')!==-1; return '#iam-greeting-popup{position:fixed;' + (t?'top:90px;':'bottom:90px;') + (r?'right:24px;':'left:24px;') + 'background:#fff;border-radius:12px;padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,.15);max-width:230px;font-size:13px;color:#333;z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,sans-serif;animation:iamPopIn .3s ease;cursor:pointer;line-height:1.4;}'; })(),
    IS_INLINE ? '' : (function(){ var r=POSITION.indexOf('right')!==-1; var t=POSITION.indexOf('top')!==-1; var s=r?'right:18px;':'left:18px;'; var a=t?'top:-6px;border-bottom:6px solid #fff;':'bottom:-6px;border-top:6px solid #fff;'; return '#iam-greeting-popup::after{content:"";position:absolute;'+a+s+'width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;}'; })(),
    IS_INLINE ? '' : '@keyframes iamPopIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
    IS_INLINE
      ? '#iam-window{position:relative;width:100%;height:100%;background:#fff;border-radius:18px;display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
      : '#iam-window{position:fixed;' + pos + 'width:360px;height:530px;background:#fff;border-radius:18px;box-shadow:0 12px 48px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;animation:iamOpen .25s cubic-bezier(.34,1.56,.64,1);}',
    '@keyframes iamOpen{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}',
    '#iam-header{padding:14px 16px;display:flex;align-items:center;gap:10px;color:#fff;flex-shrink:0;}',
    '#iam-bot-avatar{width:36px;height:36px;background:rgba(255,255,255,.2);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0;overflow:hidden;color:#fff;}',
    '#iam-bot-avatar img{width:100%;height:100%;object-fit:cover;border-radius:8px;}',
    '#iam-header-info{flex:1;min-width:0;}',
    '#iam-bot-name{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#iam-bot-status{font-size:11px;opacity:.85;margin-top:1px;}',
    '.iam-hbtn{width:28px;height:28px;background:rgba(255,255,255,.2);border:none;border-radius:50%;color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.iam-hbtn:hover{background:rgba(255,255,255,.35);}',
    '#iam-messages{flex:1;padding:14px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;background:#fafafa;}',
    '#iam-messages::-webkit-scrollbar{width:4px;}#iam-messages::-webkit-scrollbar-thumb{background:#ddd;border-radius:4px;}',
    '.iam-msg{max-width:82%;padding:9px 13px;border-radius:16px;font-size:13px;line-height:1.5;word-break:break-word;}',
    '.iam-msg.bot{background:#fff;border:1px solid #eee;border-bottom-left-radius:4px;align-self:flex-start;color:#333;box-shadow:0 1px 3px rgba(0,0,0,.05);}',
    '.iam-msg.bot a{color:' + COLOR + ';text-decoration:underline;}',
    '.iam-msg.user{background:' + COLOR + ';color:#fff;border-bottom-right-radius:4px;align-self:flex-end;}',
    '.iam-agent-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:2px;}',
    '.iam-agent-label{font-size:10px;color:#10b981;margin-left:4px;font-weight:600;}',
    '.iam-agent-bubble{background:#fff;border:1px solid #eee;border-left:3px solid #10b981;border-radius:16px;border-bottom-left-radius:4px;max-width:82%;padding:9px 13px;font-size:13px;line-height:1.5;color:#333;}',
    '.iam-system{display:flex;justify-content:center;margin:4px 0;}',
    '.iam-system span{font-size:10px;color:#888;background:#f0f0f0;border-radius:20px;padding:3px 12px;}',
    '.iam-typing{display:flex;align-items:center;gap:3px;padding:6px 2px;align-self:flex-start;}',
    '.iam-typing span{width:5px;height:5px;border-radius:50%;animation:iamWave 1.3s ease-in-out infinite;}',
    '.iam-typing span:nth-child(1){background:#c0c0c0;animation-delay:0s;}',
    '.iam-typing span:nth-child(2){background:#808080;animation-delay:.18s;}',
    '.iam-typing span:nth-child(3){background:#303030;animation-delay:.36s;}',
    '@keyframes iamWave{0%,60%,100%{transform:translateY(0);opacity:.6}30%{transform:translateY(-4px);opacity:1}}',
    '#iam-input-area{padding:10px 12px;border-top:1px solid #eee;display:flex;gap:8px;align-items:center;background:#fff;flex-shrink:0;}',
    '#iam-input{flex:1;border:1px solid #e5e5e5;border-radius:20px;padding:8px 14px;font-size:13px;outline:none;color:#333;background:#f8f8f8;font-family:inherit;}',
    '#iam-input:focus{border-color:' + COLOR + ';}',
    '#iam-send{width:34px;height:34px;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;flex-shrink:0;background:' + COLOR + ';}',
    '#iam-new-conv-confirm{display:none;position:absolute;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:14px 16px;flex-direction:column;align-items:center;gap:10px;z-index:10;box-shadow:0 -4px 12px rgba(0,0,0,.08);}',
    '#iam-new-conv-confirm p{margin:0;font-size:13px;font-weight:600;color:#333;}',
    '#iam-new-conv-confirm small{margin:0;font-size:11px;color:#888;text-align:center;}',
    '.iam-ncbns{display:flex;gap:8px;width:100%;}',
    '.iam-ncbns button{flex:1;padding:8px;border-radius:10px;font-size:13px;cursor:pointer;border:none;}',
    '#iam-btn-cancel-nc{background:#f0f0f0;color:#333;}',
    '#iam-btn-confirm-nc{color:#fff;font-weight:600;background:' + COLOR + ';}',
  ].join('');
  document.head.appendChild(css);

  // ── Launcher + greeting popup ──────────────────────────────────────
  var launcher = null;
  var greetingPopup = null;
  if (!IS_INLINE) {
    launcher = document.createElement('button');
    launcher.id = 'iam-launcher';
    launcher.title = 'Chat with us';
    launcher.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    document.body.appendChild(launcher);

    // Greeting popup — shows after 2s, hides when chat opens
    greetingPopup = document.createElement('div');
    greetingPopup.id = 'iam-greeting-popup';
    greetingPopup.style.display = 'none';
    greetingPopup.addEventListener('click', openWidget);
    document.body.appendChild(greetingPopup);

    // Show greeting popup after 2 seconds
    setTimeout(function() {
      if (!convId && greetingPopup) {
        greetingPopup.textContent = botConfig.greeting;
        greetingPopup.style.display = 'block';
      }
    }, 2000);
  }

  // ── Chat window ───────────────────────────────────────────────────
  var win = document.createElement('div');
  win.id = 'iam-window';
  win.style.display = IS_INLINE ? 'flex' : 'none';
  win.innerHTML = [
    '<div id="iam-header" style="background:' + COLOR + '">',
    '  <div id="iam-bot-avatar">A</div>',
    '  <div id="iam-header-info">',
    '    <div id="iam-bot-name">Assistant</div>',
    '    <div id="iam-bot-status">⬤ Online · Ready to help</div>',
    '  </div>',
    '  <button class="iam-hbtn" id="iam-btn-new" title="New conversation">&#8635;</button>',
    IS_INLINE ? '' : '  <button class="iam-hbtn" id="iam-btn-close" title="Close">✕</button>',
    '</div>',
    '<div id="iam-prechat" style="display:none;flex-direction:column;flex:1;overflow:hidden;">',
    '  <div id="iam-prechat-inner" style="padding:20px 18px;display:flex;flex-direction:column;gap:14px;flex:1;overflow-y:auto;">',
    '    <div style="font-size:13px;color:#666;line-height:1.6;">Before we start, we\'d love to know who we\'re speaking with. Completely optional.</div>',
    '    <div style="display:flex;flex-direction:column;gap:5px;">',
    '      <label style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;">Your Name</label>',
    '      <input id="iam-pc-name" placeholder="e.g. John Smith" autocomplete="name" style="background:#f5f5f5;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 12px;font-size:13px;color:#333;outline:none;width:100%;box-sizing:border-box;" />',
    '    </div>',
    '    <div style="display:flex;flex-direction:column;gap:5px;">',
    '      <label style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;">Email Address</label>',
    '      <input id="iam-pc-email" type="email" placeholder="e.g. john@example.com" autocomplete="email" style="background:#f5f5f5;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 12px;font-size:13px;color:#333;outline:none;width:100%;box-sizing:border-box;" />',
    '    </div>',
    '  </div>',
    '  <div style="display:flex;gap:8px;padding:14px 18px;border-top:1px solid #eee;">',
    '    <button id="iam-prechat-skip" style="background:transparent;border:1.5px solid #ddd;color:#888;border-radius:8px;padding:10px 14px;font-size:13px;cursor:pointer;">Skip</button>',
    '    <button id="iam-prechat-submit" style="flex:1;background:' + COLOR + ';color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;">Start Chat →</button>',
    '  </div>',
    '</div>',
    '<div id="iam-messages"></div>',
    '<div id="iam-input-area">',
    '  <input id="iam-input" placeholder="Type a message…" autocomplete="off" />',
    '  <button id="iam-send">↑</button>',
    '</div>',
    '<div id="iam-new-conv-confirm">',
    '  <p>Start a new conversation?</p>',
    '  <small>Your current chat history will no longer be visible.</small>',
    '  <div class="iam-ncbns">',
    '    <button id="iam-btn-cancel-nc">Cancel</button>',
    '    <button id="iam-btn-confirm-nc">New Chat</button>',
    '  </div>',
    '</div>',
  ].join('');

  if (IS_INLINE) {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) { console.warn('[IAM] Container #' + CONTAINER_ID + ' not found'); return; }
    container.appendChild(win);
  } else {
    document.body.appendChild(win);
  }

  var msgsEl    = document.getElementById('iam-messages');
  var input     = document.getElementById('iam-input');
  var preChatEl = document.getElementById('iam-prechat');
  var pcNameEl  = document.getElementById('iam-pc-name');
  var pcEmailEl = document.getElementById('iam-pc-email');
  var pcSubmit  = document.getElementById('iam-prechat-submit');
  var pcSkip    = document.getElementById('iam-prechat-skip');

  // Hide close button in inline mode
  if (IS_INLINE) {
    var closeBtn = document.getElementById('iam-btn-close');
    if (closeBtn) closeBtn.style.display = 'none';
  }

  // ── Apply bot config ───────────────────────────────────────────────
  function applyBotConfig(cfg) {
    var c = cfg.color || COLOR;
    var header = document.getElementById('iam-header');
    var avatar = document.getElementById('iam-bot-avatar');
    var nameEl = document.getElementById('iam-bot-name');
    var sendEl = document.getElementById('iam-send');
    var ncBtn  = document.getElementById('iam-btn-confirm-nc');
    if (header) header.style.background = c;
    if (sendEl) sendEl.style.background = c;
    if (ncBtn)  ncBtn.style.background = c;
    if (launcher) launcher.style.background = c;
    if (nameEl && (cfg.displayName || cfg.name)) nameEl.textContent = cfg.displayName || cfg.name;
    var initial = (cfg.displayName || cfg.name || 'B').charAt(0).toUpperCase();
    if (avatar) {
      if (cfg.avatarUrl) {
        avatar.innerHTML = '<img src="' + cfg.avatarUrl + '" alt="" onerror="this.parentNode.textContent=\'' + initial + '\'" />';
        if (launcher) launcher.innerHTML = '<img src="' + cfg.avatarUrl + '" alt="" onerror="this.style.display=\'none\'" />';
      } else {
        avatar.textContent = initial;
        if (launcher) {
          launcher.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        }
      }
    }
    // Update greeting popup text once config loads
    if (greetingPopup && (cfg.greeting || cfg.displayName || cfg.name)) {
      greetingPopup.textContent = cfg.greeting || botConfig.greeting;
    }
  }

  function loadBotConfig(cb) {
    fetch(API_BASE + '/api/bot/config?bot_id=' + BOT_ID)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data) { botConfig = data; applyBotConfig(data); }
        if (cb) cb();
      })
      .catch(function() { if (cb) cb(); });
  }

  // ── Markdown ──────────────────────────────────────────────────────
  function md(text) {
    if (!text) return '';
    var h = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    h = h.replace(/^#{1,3} (.+)$/gm,'<strong>$1</strong>');
    h = h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
    h = h.replace(/\*(.+?)\*/g,'<em>$1</em>');
    h = h.replace(/^[ ]*[-*] (.+)$/gm,'<li>$1</li>');
    h = h.replace(/(<li>[\s\S]*?<\/li>)/g,'<ul style="margin:4px 0;padding-left:16px;">$1</ul>');
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>');
    return h;
  }

  // ── Message helpers ───────────────────────────────────────────────
  function appendBot(c)   { var d=document.createElement('div'); d.className='iam-msg bot'; d.innerHTML=md(c); msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight; }
  function appendUser(c)  { var d=document.createElement('div'); d.className='iam-msg user'; d.textContent=c; msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight; }
  function appendAgent(c) {
    var wrap=document.createElement('div'); wrap.className='iam-agent-wrap';
    var lbl=document.createElement('div'); lbl.className='iam-agent-label'; lbl.textContent='Support Agent';
    var bbl=document.createElement('div'); bbl.className='iam-agent-bubble'; bbl.textContent=c;
    wrap.appendChild(lbl); wrap.appendChild(bbl); msgsEl.appendChild(wrap); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function appendSystem(c) {
    var n = botConfig.displayName || botConfig.name || 'Bot';
    var label = c === 'agent_joined' ? '● A live agent has joined' : n + ' has resumed';
    var d=document.createElement('div'); d.className='iam-system';
    d.innerHTML='<span>'+label+'</span>'; msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function showTyping() {
    if (document.getElementById('iam-typing')) return;
    var d=document.createElement('div'); d.className='iam-typing'; d.id='iam-typing';
    d.innerHTML='<span></span><span></span><span></span>'; msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function hideTyping() { var t=document.getElementById('iam-typing'); if(t) t.remove(); }

  // ── HITL Polling ──────────────────────────────────────────────────
  // Polls /api/conversation/messages every 2s during HITL only
  function startPolling(cId) {
    if (_pollInterval) return; // already polling — never start twice
    _hitlActive = true;
    stopStatusCheck(); // upgrade from status check to active HITL polling

    _pollInterval = setInterval(function() {
      var url = API_BASE + '/api/conversation/messages?conversation_id=' + cId;
      if (_lastMsgAt) url += '&after=' + encodeURIComponent(_lastMsgAt);
      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.messages) return;
          data.messages.forEach(function(m) {
            if (!_lastMsgAt || m.created_at > _lastMsgAt) _lastMsgAt = m.created_at;
            if (m.role === 'human-agent') {
              if (_shownMsgIds[m.id]) return;
              _shownMsgIds[m.id] = true;
              appendAgent(m.content);
              isSending = false;
            }
            if (m.role === 'system') {
              if (_shownSysMsgs[m.content]) return;
              _shownSysMsgs[m.content] = true;
              appendSystem(m.content);
              if (m.content === 'agent_left') { _hitlActive = false; stopPolling(); startStatusCheck(cId); }
            }
            if (m.role === 'bot') {
              if (_shownMsgIds[m.id]) return;
              _shownMsgIds[m.id] = true;
              hideTyping();
              appendBot(m.content);
              isSending = false;
            }
          });
          if (data.hitl_active === false && _hitlActive) { _hitlActive = false; stopPolling(); startStatusCheck(cId); }
        })
        .catch(function(e) { console.warn('[IAM] Poll error:', e); });
    }, 2000);
    console.log('[IAM] HITL polling started for conv:', cId);
  }

  function stopPolling() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; console.log('[IAM] HITL polling stopped'); }
  }

  // ── Background status check ────────────────────────────────────────
  // Runs every 5s to detect when agent takes over, even if user is idle
  function startStatusCheck(cId) {
    stopStatusCheck();
    _statusInterval = setInterval(function() {
      if (_pollInterval) { stopStatusCheck(); return; }
      fetch(API_BASE + '/api/conversation/messages?conversation_id=' + cId)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.hitl_active && !_pollInterval) {
            _shownSysMsgs['agent_joined'] = true; // mark before polling so poll won't re-show
            appendSystem('agent_joined');
            startPolling(cId);
          }
        })
        .catch(function() {});
    }, 5000);
  }

  function stopStatusCheck() {
    if (_statusInterval) { clearInterval(_statusInterval); _statusInterval = null; }
  }

  // ── Create / resume conversation ──────────────────────────────────
  function createConversation(cb) {
    fetch(API_BASE + '/api/conversation/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: BOT_ID, user_id: getVisitorId(), page_url: window.location.href,
        referrer_url: document.referrer || null, page_title: document.title || null,
        browser_language: navigator.language || null,
        user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        device_type: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
        user_platform: navigator.platform || null
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      convId = data.conversation_id;
      // If pre-chat was submitted before convId was ready, save lead now
      if (_preChatDone && (_preChatName || _preChatEmail)) {
        savePrechatLead(_preChatName, _preChatEmail);
      }

      if (data.returning) {
        // Returning visitor — load history first, then check HITL status
        fetch(API_BASE + '/api/conversation/messages?conversation_id=' + convId)
          .then(function(r) { return r.json(); })
          .then(function(d) {
            msgsEl.innerHTML = '';
            _shownMsgIds = {}; _shownSysMsgs = {};
            if (d.messages && d.messages.length) {
              d.messages.forEach(function(m) {
                if (m.id) _shownMsgIds[m.id] = true;
                if (m.role === 'system') { _shownSysMsgs[m.content] = true; appendSystem(m.content); }
                else if (m.role === 'human-agent') appendAgent(m.content);
                else if (m.role === 'bot')  appendBot(m.content);
                else if (m.role === 'user') appendUser(m.content);
                if (!_lastMsgAt || m.created_at > _lastMsgAt) _lastMsgAt = m.created_at;
              });
            }
            if (d.hitl_active) {
              // Agent currently active — jump straight to HITL polling
              startPolling(convId);
            } else {
              // Normal — start background status check
              startStatusCheck(convId);
            }
            if (cb) cb();
          }).catch(function() { startStatusCheck(convId); if (cb) cb(); });

      } else {
        // New visitor
        msgsEl.innerHTML = '';
        _shownMsgIds = {}; _shownSysMsgs = {};
        _lastMsgAt = new Date().toISOString();
        appendBot(botConfig.greeting);
        startStatusCheck(convId);
        // Show pre-chat form before they can type
        if (!_preChatDone) {
          showPreChat();
        }
        if (cb) cb();
      }
    })
    .catch(function(e) { console.error('[IAM] Conv create failed:', e); if (cb) cb(); });
  }

  // ── Send message ──────────────────────────────────────────────────
  function sendMessage() {
    var text = input.value.trim();
    if (!text || isSending) return;
    isSending = true;
    appendUser(text);
    input.value = '';
    showTyping();
    fetch(API_BASE + '/api/bot/respond', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, bot_id: BOT_ID, conversation_id: convId })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideTyping();
      if (data.hitl_active) {
        // Agent is handling — start polling if not already
        if (!_hitlActive && !_pollInterval) {
          _shownSysMsgs['agent_joined'] = true; // prevent duplicate notification
          startPolling(convId);
        }
        isSending = false;
        return;
      }
      if (data.response) appendBot(data.response);
      isSending = false;
    })
    .catch(function() { hideTyping(); appendBot('Sorry, something went wrong.'); isSending = false; });
  }

  // ── New conversation ──────────────────────────────────────────────
  function showNewConvConfirm()  { document.getElementById('iam-new-conv-confirm').style.display = 'flex'; }
  function hideNewConvConfirm()  { document.getElementById('iam-new-conv-confirm').style.display = 'none'; }
  function startNewConversation() {
    hideNewConvConfirm();
    stopPolling(); stopStatusCheck();
    convId = null; isSending = false;
    _lastMsgAt = null; _shownMsgIds = {}; _shownSysMsgs = {}; _hitlActive = false;
    // Generate fresh visitor ID for new conversation
    var newVid = 'vis_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2,9);
    localStorage.setItem('iam_visitor_id', newVid);
    msgsEl.innerHTML = '';
    appendBot(botConfig.greeting);
    createConversation(function() { input.focus(); });
  }

  // ── Open / close ──────────────────────────────────────────────────
  function showPreChat() {
    if (preChatEl) { preChatEl.style.display = 'flex'; preChatEl.style.flexDirection = 'column'; }
    if (msgsEl)    msgsEl.style.display = 'none';
    [pcNameEl, pcEmailEl].forEach(function(el) { if (!el) return; el.onfocus=function(){el.style.borderColor=COLOR;}; el.onblur=function(){el.style.borderColor='#e0e0e0';}; });
    if (pcSubmit)  pcSubmit.onclick = submitPreChat;
    if (pcSkip)    pcSkip.onclick   = skipPreChat;
    if (pcEmailEl) pcEmailEl.onkeydown = function(e) { if (e.key === 'Enter') submitPreChat(); };
    if (pcNameEl)  pcNameEl.onkeydown  = function(e) { if (e.key === 'Enter' && pcEmailEl) pcEmailEl.focus(); };
    setTimeout(function() { if (pcNameEl) pcNameEl.focus(); }, 150);
  }

  function skipPreChat() {
    _preChatDone = true;
    if (preChatEl) preChatEl.style.display = 'none';
    if (msgsEl) {
      msgsEl.style.display = 'flex';
      setTimeout(function() { msgsEl.scrollTop = msgsEl.scrollHeight; }, 30);
    }
    input.focus();
  }

  function submitPreChat() {
    _preChatName  = pcNameEl  ? pcNameEl.value.trim()  : '';
    _preChatEmail = pcEmailEl ? pcEmailEl.value.trim() : '';
    _preChatDone  = true;
    if (_preChatName || _preChatEmail) {
      savePrechatLead(_preChatName, _preChatEmail);
    }
    skipPreChat();
  }

  function savePrechatLead(name, email) {
    if (!convId) return; // convId not ready yet — will be called again after conversation created
    fetch(API_BASE + '/api/conversation/capture-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: BOT_ID, conversation_id: convId, name: name || null, email: email || null })
    }).then(function(r) { return r.json(); })
      .then(function(d) { console.log('[IAM] Lead saved:', d.action); })
      .catch(function(e) { console.warn('[IAM] Lead save failed:', e); });
  }

  function openWidget() {
    // Hide greeting popup
    if (greetingPopup) greetingPopup.style.display = 'none';
    win.style.display = 'flex';
    if (launcher) launcher.style.display = 'none';
    if (!convId) {
      loadBotConfig(function() { createConversation(function() { input.focus(); }); });
    } else {
      // Already have a conversation — just focus
      if (_hitlActive && !_pollInterval) startPolling(convId);
      input.focus();
    }
  }
  function closeWidget() {
    if (IS_INLINE) return;
    win.style.display = 'none';
    if (launcher) launcher.style.display = 'flex';
    hideNewConvConfirm();
    // Show greeting popup again after closing
    if (greetingPopup && !convId) {
      greetingPopup.textContent = botConfig.greeting;
      greetingPopup.style.display = 'block';
    }
  }

  // ── Events ────────────────────────────────────────────────────────
  if (launcher) launcher.addEventListener('click', openWidget);
  var closeBtn2 = document.getElementById('iam-btn-close');
  if (closeBtn2) closeBtn2.addEventListener('click', closeWidget);
  document.getElementById('iam-btn-new').addEventListener('click', showNewConvConfirm);
  document.getElementById('iam-btn-cancel-nc').addEventListener('click', hideNewConvConfirm);
  document.getElementById('iam-btn-confirm-nc').addEventListener('click', startNewConversation);
  document.getElementById('iam-send').addEventListener('click', sendMessage);
  input.addEventListener('keydown', function(e) { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} });

  // Auto-open in inline mode; preload bot config for floating mode
  if (IS_INLINE) {
    loadBotConfig(function() { createConversation(function() {}); });
  } else {
    // Pre-load bot config so greeting popup has the right text
    loadBotConfig(function() {
      if (greetingPopup) greetingPopup.textContent = botConfig.greeting;
    });
  }

})(window, document);
