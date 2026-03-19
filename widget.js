/* ═══════════════════════════════════════════════════════════════════
   IAM Platform — Embeddable Widget v2
   Place at: widget.js in your repo root
   ═══════════════════════════════════════════════════════════════════ */

(function (window, document) {
  'use strict';

  var cfg      = window.IAMConfig || {};
  var BOT_ID      = cfg.botId;
  var COLOR       = cfg.color      || '#6c63ff';
  var POSITION    = cfg.position   || 'bottom-right';
  var CONTAINER_ID = cfg.containerId || null;
  var IS_INLINE   = POSITION === 'inline' && CONTAINER_ID;

  if (!BOT_ID) { console.warn('[IAM] No botId in IAMConfig'); return; }

  // ── API base — auto-detected from script src ───────────────────────
  var API_BASE = (function () {
    var tags = document.getElementsByTagName('script');
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].src && tags[i].src.indexOf('widget.js') !== -1) {
        return tags[i].src.replace('/widget.js', '');
      }
    }
    return window.location.origin;
  })();

  var SUPA_URL = 'https://ekdsfvjsbhoxjszciquq.supabase.co';
  var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrZHNmdmpzYmhveGpzemNpcXVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MTM1ODcsImV4cCI6MjA4OTE4OTU4N30.otpg9pOci8B9nN33APefE0ulHAlfJ-nVMvNSvrIf_xQ';

  // ── State ──────────────────────────────────────────────────────────
  var convId      = null;
  var isSending   = false;
  var realtimeSub = null;
  var supaClient  = null;
  var botConfig   = { name: 'Assistant', color: COLOR, avatarUrl: '', greeting: 'Hi! How can I help you today?' };

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

  // ── Position (floating mode only) ─────────────────────────────────
  var POS = { 'bottom-right': 'bottom:24px;right:24px;', 'bottom-left': 'bottom:24px;left:24px;', 'top-right': 'top:24px;right:24px;', 'top-left': 'top:24px;left:24px;' };
  var pos = IS_INLINE ? '' : (POS[POSITION] || POS['bottom-right']);

  // ── Styles ─────────────────────────────────────────────────────────
  var css = document.createElement('style');
  css.textContent = [
    IS_INLINE ? '' : '#iam-launcher{position:fixed;' + pos + 'width:58px;height:58px;background:' + COLOR + ';border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 4px 24px rgba(0,0,0,.22);cursor:pointer;z-index:2147483647;border:none;transition:transform .2s,box-shadow .2s;overflow:hidden;}',
    IS_INLINE ? '' : '#iam-launcher:hover{transform:scale(1.08);}',
    IS_INLINE ? '' : '#iam-launcher img{width:100%;height:100%;object-fit:cover;border-radius:50%;}',
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
    '#iam-send{width:34px;height:34px;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;flex-shrink:0;}',
    '#iam-new-conv-confirm{display:none;position:absolute;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:14px 16px;flex-direction:column;align-items:center;gap:10px;z-index:10;box-shadow:0 -4px 12px rgba(0,0,0,.08);}',
    '#iam-new-conv-confirm p{margin:0;font-size:13px;font-weight:600;color:#333;}',
    '#iam-new-conv-confirm small{margin:0;font-size:11px;color:#888;text-align:center;}',
    '.iam-ncbns{display:flex;gap:8px;width:100%;}',
    '.iam-ncbns button{flex:1;padding:8px;border-radius:10px;font-size:13px;cursor:pointer;border:none;}',
    '#iam-btn-cancel-nc{background:#f0f0f0;color:#333;}',
    '#iam-btn-confirm-nc{color:#fff;font-weight:600;}',
  ].join('');
  document.head.appendChild(css);

  // ── Launcher (floating mode only) ────────────────────────────────
  var launcher = null;
  if (!IS_INLINE) {
    launcher = document.createElement('button');
    launcher.id = 'iam-launcher';
    launcher.title = 'Chat with us';
    launcher.innerHTML = '💬';
    document.body.appendChild(launcher);
  }

  // ── Chat window ───────────────────────────────────────────────────
  var win = document.createElement('div');
  win.id = 'iam-window';
  // In floating mode, start hidden; in inline mode, always visible
  win.style.display = IS_INLINE ? 'flex' : 'none';
  win.innerHTML = [
    '<div id="iam-header" style="background:' + COLOR + '">',
    '  <div id="iam-bot-avatar">🤖</div>',
    '  <div id="iam-header-info">',
    '    <div id="iam-bot-name">Assistant</div>',
    '    <div id="iam-bot-status">⬤ Online · Ready to help</div>',
    '  </div>',
    '  <button class="iam-hbtn" id="iam-btn-new" title="New conversation">&#8635;</button>',
    '  <button class="iam-hbtn" id="iam-btn-close" title="Close">✕</button>',
    '</div>',
    '<div id="iam-messages"></div>',
    '<div id="iam-input-area">',
    '  <input id="iam-input" placeholder="Type a message…" autocomplete="off" />',
    '  <button id="iam-send" style="background:' + COLOR + '">↑</button>',
    '</div>',
    '<div id="iam-new-conv-confirm">',
    '  <p>Start a new conversation?</p>',
    '  <small>Your current chat history will no longer be visible.</small>',
    '  <div class="iam-ncbns">',
    '    <button id="iam-btn-cancel-nc">Cancel</button>',
    '    <button id="iam-btn-confirm-nc" style="background:' + COLOR + '">New Chat</button>',
    '  </div>',
    '</div>',
  ].join('');
  // Mount into container div (inline) or body (floating)
  if (IS_INLINE) {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) { console.warn('[IAM] Container #' + CONTAINER_ID + ' not found'); return; }
    container.appendChild(win);
  } else {
    document.body.appendChild(win);
  }

  var msgsEl = document.getElementById('iam-messages');
  var input  = document.getElementById('iam-input');

  // ── Apply bot config to UI ─────────────────────────────────────────
  function applyBotConfig(cfg) {
    var c = cfg.color || COLOR;
    var header = document.getElementById('iam-header');
    var avatar = document.getElementById('iam-bot-avatar');
    var name   = document.getElementById('iam-bot-name');
    var send   = document.getElementById('iam-send');
    var ncBtn  = document.getElementById('iam-btn-confirm-nc');
    if (header) header.style.background = c;
    if (send)   send.style.background = c;
    if (ncBtn)  ncBtn.style.background = c;
    launcher.style.background = c;
    if (name && (cfg.displayName || cfg.name)) name.textContent = cfg.displayName || cfg.name;
    var initial = (cfg.displayName || cfg.name || 'B').charAt(0).toUpperCase();
    if (avatar) {
      if (cfg.avatarUrl) {
        avatar.innerHTML = '<img src="' + cfg.avatarUrl + '" alt="" onerror="this.parentNode.textContent=\'' + initial + '\'" />';
      } else {
        avatar.textContent = initial;
      }
    }
    if (cfg.avatarUrl) {
      launcher.innerHTML = '<img src="' + cfg.avatarUrl + '" alt="" onerror="this.parentNode.innerHTML=\'💬\'" />';
    }
  }

  // ── Fetch bot config ───────────────────────────────────────────────
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

  // ── Append helpers ────────────────────────────────────────────────
  function appendBot(c)   { var d=document.createElement('div'); d.className='iam-msg bot'; d.innerHTML=md(c); msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight; }
  function appendUser(c)  { var d=document.createElement('div'); d.className='iam-msg user'; d.textContent=c; msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight; }
  function appendAgent(c) {
    var w=document.createElement('div'); w.className='iam-agent-wrap';
    var l=document.createElement('div'); l.className='iam-agent-label'; l.textContent='Support Agent';
    var b=document.createElement('div'); b.className='iam-agent-bubble'; b.textContent=c;
    w.appendChild(l); w.appendChild(b); msgsEl.appendChild(w); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function appendSystem(c) {
    var n = botConfig.displayName || botConfig.name || 'Bot';
    var label = c === 'agent_joined' ? '👤 A live agent has joined' : n + ' has resumed';
    var d=document.createElement('div'); d.className='iam-system';
    d.innerHTML='<span>'+label+'</span>'; msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function showTyping() {
    if (document.getElementById('iam-typing')) return;
    var d=document.createElement('div'); d.className='iam-typing'; d.id='iam-typing';
    d.innerHTML='<span></span><span></span><span></span>'; msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function hideTyping() { var t=document.getElementById('iam-typing'); if(t) t.remove(); }

  // ── Realtime ──────────────────────────────────────────────────────
  var convRowSub = null; // second channel: conversation row changes

  function startRealtime(cId) {
    if (realtimeSub) { try { realtimeSub.unsubscribe(); } catch(e) {} realtimeSub = null; }
    if (convRowSub) { try { convRowSub.unsubscribe(); } catch(e) {} convRowSub = null; }
    if (!cId || !supaClient) return;

    // Channel 1: new messages
    realtimeSub = supaClient
      .channel('iam_msgs_' + cId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + cId }, function(payload) {
        var msg = payload.new;
        if (msg.role === 'human-agent') { hideTyping(); appendAgent(msg.content); isSending = false; }
        if (msg.role === 'system')      { appendSystem(msg.content); }
        if (msg.role === 'bot') {
          var bots = msgsEl.querySelectorAll('.iam-msg.bot');
          var last = bots[bots.length - 1];
          if (!last || last.textContent.trim() !== msg.content.trim()) { hideTyping(); appendBot(msg.content); isSending = false; }
        }
      })
      .subscribe(function(s) { console.log('[IAM] Messages realtime:', s); });

    // Channel 2: conversation row changes — typing indicator + HITL status
    convRowSub = supaClient
      .channel('iam_conv_' + cId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations', filter: 'id=eq.' + cId }, function(payload) {
        var conv = payload.new;

        // Agent typing indicator
        if (conv.agent_typing) {
          showAgentTyping();
        } else {
          hideAgentTyping();
        }

        // hitl_active flipped to false — bot has resumed
        // The system message (agent_left) will also arrive via messages channel,
        // but this gives instant feedback from the row change
        if (conv.hitl_active === false) {
          hideAgentTyping();
          // Only show pill if not already shown by system message
          var existing = msgsEl.querySelectorAll('.iam-system span');
          var name = botConfig.displayName || botConfig.name || 'Bot';
          var resumeLabel = name + ' has resumed';
          var alreadyShown = false;
          existing.forEach(function(el) { if (el.textContent === resumeLabel) alreadyShown = true; });
          if (!alreadyShown) appendSystem('agent_left');
        }
      })
      .subscribe(function(s) { console.log('[IAM] Conv realtime:', s); });
  }

  function showAgentTyping() {
    if (document.getElementById('iam-agent-typing')) return;
    var wrap = document.createElement('div');
    wrap.id = 'iam-agent-typing';
    wrap.className = 'iam-agent-wrap';
    var label = document.createElement('div');
    label.className = 'iam-agent-label';
    label.textContent = 'Support Agent';
    var dots = document.createElement('div');
    dots.className = 'iam-typing';
    dots.innerHTML = '<span></span><span></span><span></span>';
    wrap.appendChild(label);
    wrap.appendChild(dots);
    msgsEl.appendChild(wrap);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function hideAgentTyping() {
    var el = document.getElementById('iam-agent-typing');
    if (el) el.remove();
  }

  function initSupabase(cb) {
    if (supaClient) { cb(); return; }
    var opts = { auth: { storageKey: 'iam-widget-' + BOT_ID, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    function make() { supaClient = window.supabase.createClient(SUPA_URL, SUPA_KEY, opts); cb(); }
    if (window.supabase && window.supabase.createClient) { make(); }
    else {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = make; document.head.appendChild(s);
    }
  }

  // ── Create conversation ───────────────────────────────────────────
  function createConversation(cb) {
    fetch(API_BASE + '/api/conversation/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: BOT_ID, user_id: getVisitorId(), page_url: window.location.href,
        referrer_url: document.referrer || null, page_title: document.title || null,
        browser_language: navigator.language || null,
        user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        device_type: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
        user_platform: navigator.platform || null })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      convId = data.conversation_id;
      initSupabase(function() { startRealtime(convId); });
      if (data.returning) {
        fetch(API_BASE + '/api/conversation/messages?conversation_id=' + convId)
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.messages && d.messages.length) {
              msgsEl.innerHTML = '';
              d.messages.forEach(function(m) {
                if (m.role === 'system') appendSystem(m.content);
                else if (m.role === 'human-agent') appendAgent(m.content);
                else if (m.role === 'bot')  appendBot(m.content);
                else if (m.role === 'user') appendUser(m.content);
              });
            }
          }).catch(function(){});
      } else if (botConfig.greeting) {
        // Show greeting from config for new visitors
        msgsEl.innerHTML = '';
        appendBot(botConfig.greeting);
      }
      if (cb) cb();
    })
    .catch(function(e) { console.error('[IAM] Conv create failed:', e); });
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
      if (data.hitl_active) { isSending = false; return; }
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
    if (realtimeSub) { try { realtimeSub.unsubscribe(); } catch(e) {} realtimeSub = null; }
    if (convRowSub) { try { convRowSub.unsubscribe(); } catch(e) {} convRowSub = null; }
    var newVid = 'vis_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2,9);
    localStorage.setItem('iam_visitor_id', newVid);
    convId = null; isSending = false; msgsEl.innerHTML = '';
    if (botConfig.greeting) appendBot(botConfig.greeting);
    createConversation(function() { input.focus(); });
  }

  // Hide close button in inline mode — user can't "close" an embedded widget
  if (IS_INLINE) {
    var closeBtn = document.getElementById('iam-btn-close');
    if (closeBtn) closeBtn.style.display = 'none';
  }

  // ── Open / close ──────────────────────────────────────────────────
  function openWidget() {
    win.style.display = 'flex';
    if (launcher) launcher.style.display = 'none';
    if (!convId) {
      loadBotConfig(function() { createConversation(function() { input.focus(); }); });
    } else {
      initSupabase(function() { startRealtime(convId); });
      input.focus();
    }
  }
  function closeWidget() {
    if (IS_INLINE) return; // can't close inline widget
    win.style.display = 'none';
    if (launcher) launcher.style.display = 'flex';
    hideNewConvConfirm();
  }

  // ── Events ────────────────────────────────────────────────────────
  if (launcher) launcher.addEventListener('click', openWidget);
  document.getElementById('iam-btn-close').addEventListener('click', closeWidget);
  document.getElementById('iam-btn-new').addEventListener('click', showNewConvConfirm);
  document.getElementById('iam-btn-cancel-nc').addEventListener('click', hideNewConvConfirm);
  document.getElementById('iam-btn-confirm-nc').addEventListener('click', startNewConversation);
  document.getElementById('iam-send').addEventListener('click', sendMessage);
  input.addEventListener('keydown', function(e) { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} });

  // Auto-open immediately in inline mode
  if (IS_INLINE) openWidget();

})(window, document);
