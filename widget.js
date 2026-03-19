/* ═══════════════════════════════════════════════════════════════════
   IAM Platform — Embeddable Widget
   Place this file at: public/widget.js in your repo
   It will be served at: https://your-vercel-domain.vercel.app/widget.js
   ═══════════════════════════════════════════════════════════════════ */

(function (window, document) {
  'use strict';

  // ── Config from the snippet ────────────────────────────────────────
  var cfg = window.IAMConfig || {};
  var BOT_ID    = cfg.botId;
  var COLOR     = cfg.color    || '#6c63ff';
  var POSITION  = cfg.position || 'bottom-right';

  // ── API base — same domain as widget.js is served from ────────────
  // Reads the script src so the widget always calls the right backend
  var SCRIPT_SRC = (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].src && scripts[i].src.indexOf('widget.js') !== -1) {
        return scripts[i].src;
      }
    }
    return window.location.origin;
  })();
  var API_BASE = SCRIPT_SRC.replace('/widget.js', '');

  // ── Supabase (for realtime) ────────────────────────────────────────
  var SUPA_URL = 'https://ekdsfvjsbhoxjszciquq.supabase.co';
  var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrZHNmdmpzYmhveGpzemNpcXVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MTM1ODcsImV4cCI6MjA4OTE4OTU4N30.otpg9pOci8B9nN33APefE0ulHAlfJ-nVMvNSvrIf_xQ';

  if (!BOT_ID) { console.warn('[IAM] No botId set in IAMConfig'); return; }

  // ── State ──────────────────────────────────────────────────────────
  var convId       = null;
  var isSending    = false;
  var realtimeSub  = null;
  var supaClient   = null;
  var isOpen       = false;

  // ── Visitor ID ────────────────────────────────────────────────────
  function getVisitorId() {
    var key = 'iam_visitor_id';
    var id  = localStorage.getItem(key);
    if (!id) {
      id = 'vis_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem(key, id);
    }
    return id;
  }

  // ── Position styles ───────────────────────────────────────────────
  var posStyles = {
    'bottom-right': 'bottom:24px;right:24px;',
    'bottom-left':  'bottom:24px;left:24px;',
    'top-right':    'top:24px;right:24px;',
    'top-left':     'top:24px;left:24px;',
  };
  var pos = posStyles[POSITION] || posStyles['bottom-right'];

  // ── Inject styles ─────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#iam-launcher{position:fixed;' + pos + 'width:58px;height:58px;background:' + COLOR + ';border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 4px 24px rgba(0,0,0,0.22);cursor:pointer;z-index:2147483647;border:none;transition:transform .2s,box-shadow .2s;}',
    '#iam-launcher:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(0,0,0,0.28);}',
    '#iam-window{position:fixed;' + pos + 'width:360px;height:520px;background:#fff;border-radius:18px;box-shadow:0 12px 48px rgba(0,0,0,0.18);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;transform-origin:bottom right;animation:iamOpen .25s cubic-bezier(.34,1.56,.64,1);}',
    '@keyframes iamOpen{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}',
    '#iam-header{background:' + COLOR + ';padding:14px 16px;display:flex;align-items:center;gap:10px;color:#fff;flex-shrink:0;}',
    '#iam-avatar{width:36px;height:36px;background:rgba(255,255,255,.2);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}',
    '#iam-header-info{flex:1;}',
    '#iam-header-name{font-weight:700;font-size:14px;}',
    '#iam-header-status{font-size:11px;opacity:.85;margin-top:1px;}',
    '#iam-close{width:28px;height:28px;background:rgba(255,255,255,.2);border:none;border-radius:50%;color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '#iam-messages{flex:1;padding:14px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;background:#fafafa;}',
    '#iam-messages::-webkit-scrollbar{width:4px;}',
    '#iam-messages::-webkit-scrollbar-thumb{background:#ddd;border-radius:4px;}',
    '.iam-msg{max-width:82%;padding:9px 13px;border-radius:16px;font-size:13px;line-height:1.5;word-break:break-word;}',
    '.iam-msg.bot{background:#fff;border:1px solid #eee;border-bottom-left-radius:4px;align-self:flex-start;color:#333;box-shadow:0 1px 3px rgba(0,0,0,.05);}',
    '.iam-msg.bot a{color:' + COLOR + ';text-decoration:underline;}',
    '.iam-msg.user{background:' + COLOR + ';color:#fff;border-bottom-right-radius:4px;align-self:flex-end;}',
    '.iam-agent-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:2px;}',
    '.iam-agent-label{font-size:10px;color:#10b981;margin-left:4px;font-weight:600;}',
    '.iam-agent-bubble{background:#fff;border:1px solid #eee;border-left:3px solid #10b981;border-bottom-left-radius:4px;align-self:flex-start;color:#333;max-width:82%;padding:9px 13px;border-radius:16px;font-size:13px;line-height:1.5;}',
    '.iam-system{display:flex;justify-content:center;margin:6px 0;}',
    '.iam-system span{font-size:10px;color:#888;background:#f0f0f0;border-radius:20px;padding:3px 12px;}',
    '.iam-typing{display:flex;align-items:center;gap:3px;padding:6px 2px;align-self:flex-start;}',
    '.iam-typing span{width:5px;height:5px;border-radius:50%;animation:iamWave 1.3s ease-in-out infinite;}',
    '.iam-typing span:nth-child(1){background:#c0c0c0;animation-delay:0s;}',
    '.iam-typing span:nth-child(2){background:#808080;animation-delay:.18s;}',
    '.iam-typing span:nth-child(3){background:#303030;animation-delay:.36s;}',
    '@keyframes iamWave{0%,60%,100%{transform:translateY(0);opacity:.6}30%{transform:translateY(-4px);opacity:1}}',
    '#iam-input-area{padding:10px 12px;border-top:1px solid #eee;display:flex;gap:8px;align-items:center;background:#fff;flex-shrink:0;}',
    '#iam-input{flex:1;border:1px solid #e5e5e5;border-radius:20px;padding:8px 14px;font-size:13px;outline:none;color:#333;background:#f8f8f8;font-family:inherit;transition:border-color .15s;}',
    '#iam-input:focus{border-color:' + COLOR + ';}',
    '#iam-send{width:34px;height:34px;background:' + COLOR + ';border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;flex-shrink:0;}',
    '#iam-send:hover{opacity:.85;}',
  ].join('');
  document.head.appendChild(style);

  // ── Launcher button ───────────────────────────────────────────────
  var launcher = document.createElement('button');
  launcher.id = 'iam-launcher';
  launcher.innerHTML = '💬';
  launcher.title = 'Chat with us';
  document.body.appendChild(launcher);

  // ── Chat window ───────────────────────────────────────────────────
  var win = document.createElement('div');
  win.id = 'iam-window';
  win.style.display = 'none';
  win.innerHTML = [
    '<div id="iam-header">',
    '  <div id="iam-avatar">🤖</div>',
    '  <div id="iam-header-info">',
    '    <div id="iam-header-name">Assistant</div>',
    '    <div id="iam-header-status">⬤ Online · Ready to help</div>',
    '  </div>',
    '  <button id="iam-close" title="Close">✕</button>',
    '</div>',
    '<div id="iam-messages"></div>',
    '<div id="iam-input-area">',
    '  <input id="iam-input" placeholder="Type a message…" autocomplete="off" />',
    '  <button id="iam-send">↑</button>',
    '</div>',
  ].join('');
  document.body.appendChild(win);

  var msgsEl  = document.getElementById('iam-messages');
  var input   = document.getElementById('iam-input');

  // ── Markdown renderer (lightweight) ──────────────────────────────
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

  // ── Append messages ───────────────────────────────────────────────
  function appendBot(content) {
    var div = document.createElement('div');
    div.className = 'iam-msg bot';
    div.innerHTML = md(content);
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function appendUser(content) {
    var div = document.createElement('div');
    div.className = 'iam-msg user';
    div.textContent = content;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function appendAgent(content) {
    var wrap = document.createElement('div');
    wrap.className = 'iam-agent-wrap';
    var label = document.createElement('div');
    label.className = 'iam-agent-label';
    label.textContent = 'Support Agent';
    var bubble = document.createElement('div');
    bubble.className = 'iam-agent-bubble';
    bubble.textContent = content;
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    msgsEl.appendChild(wrap);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function appendSystem(content) {
    var label = content === 'agent_joined' ? '👤 A live agent has joined' : 'Bot has resumed';
    var div = document.createElement('div');
    div.className = 'iam-system';
    div.innerHTML = '<span>' + label + '</span>';
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function showTyping() {
    var t = document.getElementById('iam-typing');
    if (t) return;
    var div = document.createElement('div');
    div.className = 'iam-typing';
    div.id = 'iam-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function hideTyping() {
    var t = document.getElementById('iam-typing');
    if (t) t.remove();
  }

  // ── Realtime subscription ─────────────────────────────────────────
  function startRealtime(cId) {
    if (realtimeSub) { try { realtimeSub.unsubscribe(); } catch(e) {} realtimeSub = null; }
    if (!cId || !supaClient) return;
    realtimeSub = supaClient
      .channel('iam_widget_' + cId)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: 'conversation_id=eq.' + cId
      }, function(payload) {
        var msg = payload.new;
        if (msg.role === 'human-agent') {
          hideTyping();
          appendAgent(msg.content);
          isSending = false;
        }
        if (msg.role === 'system') {
          appendSystem(msg.content);
        }
        if (msg.role === 'bot') {
          // Only show via realtime if we didn't already show it via direct API response
          // Check last bot message to avoid duplicate
          var botMsgs = msgsEl.querySelectorAll('.iam-msg.bot');
          var lastBot = botMsgs[botMsgs.length - 1];
          var alreadyShown = lastBot && lastBot.textContent.trim() === msg.content.trim();
          if (!alreadyShown) {
            hideTyping();
            appendBot(msg.content);
            isSending = false;
          }
        }
      })
      .subscribe(function(status) {
        console.log('[IAM] Realtime:', status);
      });
  }

  function initSupabase(cb) {
    if (supaClient) { cb(); return; }
    if (window.supabase && window.supabase.createClient) {
      supaClient = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
        auth: { storageKey: 'iam-widget', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
      cb();
    } else {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = function() {
        supaClient = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
          auth: { storageKey: 'iam-widget', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
        });
        cb();
      };
      document.head.appendChild(s);
    }
  }

  // ── Create conversation ───────────────────────────────────────────
  function createConversation(cb) {
    fetch(API_BASE + '/api/conversation/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id:           BOT_ID,
        user_id:          getVisitorId(),
        page_url:         window.location.href,
        referrer_url:     document.referrer || null,
        page_title:       document.title || null,
        browser_language: navigator.language || null,
        user_timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        device_type:      /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
        user_platform:    navigator.platform || null,
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      convId = data.conversation_id;
      initSupabase(function() { startRealtime(convId); });

      // Load history for returning visitors
      if (data.returning) {
        fetch(API_BASE + '/api/conversation/messages?conversation_id=' + convId)
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.messages && d.messages.length) {
              msgsEl.innerHTML = '';
              d.messages.forEach(function(m) {
                if (m.role === 'system')       { appendSystem(m.content); }
                else if (m.role === 'human-agent') { appendAgent(m.content); }
                else if (m.role === 'bot')     { appendBot(m.content); }
                else if (m.role === 'user')    { appendUser(m.content); }
              });
            }
          })
          .catch(function() {});
      }
      if (cb) cb();
    })
    .catch(function(e) { console.error('[IAM] Conversation create failed:', e); });
  }

  // ── Load bot config (name, greeting, avatar) ──────────────────────
  function loadBotConfig() {
    // We rely on the greeting being in the first DB message, or use defaults
    // Optionally fetch bot config here if you add a public /api/bot/config endpoint
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, bot_id: BOT_ID, conversation_id: convId })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideTyping();
      if (data.hitl_active) {
        // Human agent taking over — realtime will deliver their messages
        isSending = false;
        return;
      }
      if (data.response) { appendBot(data.response); }
      isSending = false;
    })
    .catch(function(e) {
      hideTyping();
      appendBot('Sorry, something went wrong. Please try again.');
      console.error('[IAM] Send failed:', e);
      isSending = false;
    });
  }

  // ── Open / close ──────────────────────────────────────────────────
  function openWidget() {
    isOpen = true;
    launcher.style.display = 'none';
    win.style.display = 'flex';
    if (!convId) {
      createConversation(function() { input.focus(); });
    } else {
      initSupabase(function() { startRealtime(convId); });
      input.focus();
    }
  }
  function closeWidget() {
    isOpen = false;
    win.style.display = 'none';
    launcher.style.display = 'flex';
  }

  // ── Event listeners ───────────────────────────────────────────────
  launcher.addEventListener('click', openWidget);
  document.getElementById('iam-close').addEventListener('click', closeWidget);
  document.getElementById('iam-send').addEventListener('click', sendMessage);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

})(window, document);
