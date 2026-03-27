/* ═══════════════════════════════════════════════════════════════════
   IAM Platform — Embeddable Widget v3
   ═══════════════════════════════════════════════════════════════════ */
(function (window, document) {
  'use strict';

  var cfg          = window.IAMConfig || {};
  var BOT_ID       = cfg.botId;
  var COLOR        = cfg.color       || '#6c63ff';
  var POSITION     = cfg.position    || 'bottom-right';
  var CONTAINER_ID = cfg.containerId || null;
  var IS_INLINE    = POSITION === 'inline' && CONTAINER_ID;

  if (!BOT_ID) { console.warn('[IAM] No botId'); return; }

  var API_BASE = (function () {
    var tags = document.getElementsByTagName('script');
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].src && tags[i].src.indexOf('widget.js') !== -1)
        return tags[i].src.replace('/widget.js', '');
    }
    return window.location.origin;
  })();

  // ── State ────────────────────────────────────────────────────────────
  var convId         = null;
  var isSending      = false;
  var botConfig      = { name:'Assistant', color:COLOR, avatarUrl:'', greeting:'Hi! How can I help you today?' };
  var _pollInterval  = null;
  var _statusInterval= null;
  var _lastMsgAt     = null;
  var _hitlActive    = false;
  var _shownSysMsgs  = {};
  var _shownMsgIds   = {};
  var _shownBotTexts = {};
  var _preChatDone   = false;
  var _preChatName   = '';
  var _preChatEmail  = '';

  function getVisitorId() {
    var k = 'iam_visitor_id', id = localStorage.getItem(k);
    if (!id) { id = 'vis_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2,9); localStorage.setItem(k,id); }
    return id;
  }

  // ── Styles ───────────────────────────────────────────────────────────
  var POS = { 'bottom-right':'bottom:24px;right:24px;','bottom-left':'bottom:24px;left:24px;','top-right':'top:24px;right:24px;','top-left':'top:24px;left:24px;' };
  var pos = IS_INLINE ? '' : (POS[POSITION] || POS['bottom-right']);

  var css = document.createElement('style');
  css.textContent = [
    IS_INLINE?'':'#iam-launcher{position:fixed;'+pos+'width:58px;height:58px;background:'+COLOR+';border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 24px rgba(0,0,0,.22);cursor:pointer;z-index:2147483647;border:none;transition:transform .2s;overflow:hidden;}',
    IS_INLINE?'':'#iam-launcher:hover{transform:scale(1.08);}',
    IS_INLINE?'':(function(){ var r=POSITION.indexOf('right')!==-1,t=POSITION.indexOf('top')!==-1; return '#iam-greeting-popup{position:fixed;'+(t?'top:90px;':'bottom:90px;')+(r?'right:24px;':'left:24px;')+'background:#fff;border-radius:12px;padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,.15);max-width:230px;font-size:13px;color:#333;z-index:2147483646;cursor:pointer;line-height:1.4;animation:iamPopIn .3s ease;}'; })(),
    IS_INLINE?'':(function(){ var r=POSITION.indexOf('right')!==-1,t=POSITION.indexOf('top')!==-1; return '#iam-greeting-popup::after{content:"";position:absolute;'+(t?'top:-6px;border-bottom:6px solid #fff;':'bottom:-6px;border-top:6px solid #fff;')+(r?'right:18px;':'left:18px;')+'width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;}'; })(),
    IS_INLINE?'':'@keyframes iamPopIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
    IS_INLINE
      ?'#iam-window{position:relative;width:100%;height:100%;background:#fff;display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
      :'#iam-window{position:fixed;'+pos+'width:360px;height:530px;background:#fff;border-radius:18px;box-shadow:0 12px 48px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;animation:iamOpen .25s cubic-bezier(.34,1.56,.64,1);}',
    '@keyframes iamOpen{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}',
    '#iam-header{padding:14px 16px;display:flex;align-items:center;gap:10px;color:#fff;flex-shrink:0;}',
    '#iam-bot-avatar{width:36px;height:36px;background:rgba(255,255,255,.2);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0;overflow:hidden;color:#fff;}',
    '#iam-bot-avatar img{width:100%;height:100%;object-fit:cover;border-radius:8px;}',
    '#iam-header-info{flex:1;min-width:0;}',
    '#iam-bot-name{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#iam-bot-status{font-size:11px;opacity:.85;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.iam-hbtn{width:28px;height:28px;background:rgba(255,255,255,.2);border:none;border-radius:50%;color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.iam-hbtn:hover{background:rgba(255,255,255,.35);}',
    '#iam-messages{flex:1;padding:14px;display:flex;flex-direction:column;gap:4px;overflow-y:auto;background:#fafafa;}',
    '#iam-messages::-webkit-scrollbar{width:4px;}#iam-messages::-webkit-scrollbar-thumb{background:#ddd;border-radius:4px;}',
    '.iam-msg{max-width:82%;padding:9px 13px;border-radius:16px;font-size:13px;line-height:1.5;word-break:break-word;}',
    '.iam-msg.bot{position:relative;background:#fff;border:1px solid #eee;border-bottom-left-radius:4px;align-self:flex-start;color:#333;box-shadow:0 1px 2px rgba(0,0,0,.05);}',
    '.iam-msg.bot a{color:'+COLOR+';text-decoration:underline;}',
    '.iam-msg.user{background:'+COLOR+';color:#fff;border-bottom-right-radius:4px;align-self:flex-end;}',
    '.iam-msg-status{font-size:10px;color:'+COLOR+';margin-top:2px;text-align:right;}',
    '.iam-bot-wrap{display:flex;flex-direction:column;align-items:flex-start;max-width:82%;margin-bottom:16px;}',
    '.iam-fb{position:absolute;bottom:-14px;right:12px;display:flex;gap:6px;background:#fff;border:1px solid #e5e5e5;border-radius:18px;padding:3px 6px;box-shadow:0 3px 6px rgba(0,0,0,.06);z-index:2;transition:opacity .2s;}',
    '.iam-fb-btn{background:transparent;border:none;padding:2px;cursor:pointer;color:#6b7280;display:flex;align-items:center;justify-content:center;transition:all 0.2s;}',
    '.iam-fb-btn:hover{background:#f0f0f0;}',
    '.iam-fb-form{display:none;flex-direction:column;gap:4px;margin-top:4px;width:100%;}',
    '.iam-fb-form textarea{width:100%;font-size:12px;padding:6px;border:1px solid #ddd;border-radius:6px;resize:none;font-family:inherit;}',
    '.iam-fb-form button{background:'+COLOR+';color:#fff;border:none;border-radius:6px;padding:6px;font-size:11px;font-weight:600;cursor:pointer;}',
    '.iam-agent-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:2px;margin-bottom:8px;}',
    '.iam-agent-label{font-size:10px;color:#10b981;margin-left:4px;font-weight:600;}',
    '.iam-agent-bubble{background:#fff;border:1px solid #eee;border-left:3px solid #10b981;border-radius:16px;border-bottom-left-radius:4px;max-width:82%;padding:9px 13px;font-size:13px;line-height:1.5;color:#333;}',
    '.iam-agent-bubble a{color:#10b981;text-decoration:underline;}',
    '.iam-system{display:flex;justify-content:center;margin:4px 0;}',
    '.iam-system span{font-size:10px;color:#888;background:#f0f0f0;border-radius:20px;padding:3px 12px;}',
    '.iam-typing{background:#f0f0f0;padding:12px 16px;border-radius:16px;border-bottom-left-radius:4px;display:inline-flex;align-items:center;gap:4px;margin-bottom:12px;align-self:flex-start;}',
    '.iam-typing span{width:6px;height:6px;background:#888;border-radius:50%;animation:iamBounce 1.4s infinite ease-in-out both;}',
    '.iam-typing span:nth-child(1){animation-delay:-0.32s;}',
    '.iam-typing span:nth-child(2){animation-delay:-0.16s;}',
    '@keyframes iamBounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}',
    '.iam-spinner{width:24px;height:24px;border:3px solid #f3f3f3;border-top:3px solid '+COLOR+';border-radius:50%;animation:iamSpin 1s linear infinite;}',
    '@keyframes iamSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}',
    '.iam-date-sep{display:flex;align-items:center;gap:8px;margin:10px 0;color:#aaa;font-size:11px;}',
    '.iam-date-sep::before,.iam-date-sep::after{content:"";flex:1;height:1px;background:#e8e8e8;}',
    '#iam-input-area{padding:10px 12px;border-top:1px solid #eee;display:none;gap:8px;align-items:center;background:#fff;flex-shrink:0;}',
    '#iam-input{flex:1;border:1px solid #e5e5e5;border-radius:20px;padding:8px 14px;font-size:13px;outline:none;color:#333;background:#f8f8f8;font-family:inherit;}',
    '#iam-input:focus{border-color:'+COLOR+';}',
    '#iam-input:disabled{opacity:.5;cursor:not-allowed;}',
    '#iam-send{width:34px;height:34px;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;flex-shrink:0;background:'+COLOR+';}',
    '#iam-send:disabled{opacity:.4;cursor:not-allowed;}',
    '#iam-new-conv-confirm{display:none;position:absolute;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:14px 16px;flex-direction:column;align-items:center;gap:10px;z-index:10;box-shadow:0 -4px 12px rgba(0,0,0,.08);}',
    '#iam-new-conv-confirm p{margin:0;font-size:13px;font-weight:600;color:#333;}',
    '#iam-new-conv-confirm small{margin:0;font-size:11px;color:#888;text-align:center;}',
    '.iam-ncbns{display:flex;gap:8px;width:100%;}',
    '.iam-ncbns button{flex:1;padding:8px;border-radius:10px;font-size:13px;cursor:pointer;border:none;}',
    '#iam-btn-cancel-nc{background:#f0f0f0;color:#333;}',
    '#iam-btn-confirm-nc{color:#fff;font-weight:600;background:'+COLOR+';}',
  ].join('');
  document.head.appendChild(css);

  // ── Launcher + popup ─────────────────────────────────────────────────
  var launcher = null, greetingPopup = null;
  if (!IS_INLINE) {
    launcher = document.createElement('button');
    launcher.id = 'iam-launcher';
    launcher.title = 'Chat with us';
    launcher.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    document.body.appendChild(launcher);

    greetingPopup = document.createElement('div');
    greetingPopup.id = 'iam-greeting-popup';
    greetingPopup.style.display = 'none';
    greetingPopup.addEventListener('click', openWidget);
    document.body.appendChild(greetingPopup);

    setTimeout(function() {
      if (!convId && greetingPopup) { greetingPopup.textContent = botConfig.greeting; greetingPopup.style.display = 'block'; }
    }, 2000);
  }

  // ── Window HTML ───────────────────────────────────────────────────────
  // IMPORTANT: #iam-prechat lives PERMANENTLY inside #iam-messages.
  // NEVER use msgsEl.innerHTML='' — always use safeClear() which skips #iam-prechat.
  var win = document.createElement('div');
  win.id = 'iam-window';
  win.style.display = IS_INLINE ? 'flex' : 'none';
  win.innerHTML = [
    '<div id="iam-header" style="background:'+COLOR+'">',
    '  <div id="iam-bot-avatar">A</div>',
    '  <div id="iam-header-info">',
    '    <div id="iam-bot-name">Assistant</div>',
    '    <div id="iam-bot-status"><span style="color:#10b981;">&#9679;</span> Online &middot; Ready to help</div>',
    '  </div>',
    '  <div style="position:relative;display:flex;align-items:center;margin-right:8px;min-width:36px;">',
    '    <div id="iam-lang-disp" style="color:#fff;font-size:13px;font-weight:600;display:flex;align-items:center;gap:4px;pointer-events:none;">auto <svg fill="#ffffff" height="16" viewBox="0 0 24 24" width="16"><path d="M7 10l5 5 5-5z"/></svg></div>',
    '    <select id="iam-language-select" title="Select your preferred language" style="position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;cursor:pointer;appearance:none;-webkit-appearance:none;">',
    '      <option value="auto">&nbsp;&nbsp;auto</option>',
    '      <option value="english">&nbsp;&nbsp;english</option>',
    '      <option value="spanish">&nbsp;&nbsp;spanish</option>',
    '      <option value="french">&nbsp;&nbsp;french</option>',
    '      <option value="german">&nbsp;&nbsp;german</option>',
    '      <option value="italian">&nbsp;&nbsp;italian</option>',
    '      <option value="portuguese">&nbsp;&nbsp;portuguese</option>',
    '      <option value="dutch">&nbsp;&nbsp;dutch</option>',
    '      <option value="russian">&nbsp;&nbsp;russian</option>',
    '      <option value="arabic">&nbsp;&nbsp;arabic</option>',
    '      <option value="chinese">&nbsp;&nbsp;chinese</option>',
    '      <option value="japanese">&nbsp;&nbsp;japanese</option>',
    '      <option value="korean">&nbsp;&nbsp;korean</option>',
    '    </select>',
    '  </div>',
    '  <button class="iam-hbtn" id="iam-btn-new" title="New conversation">&#8635;</button>',
    IS_INLINE ? '' : '  <button class="iam-hbtn" id="iam-btn-close" title="Close">&#10005;</button>',
    '</div>',
    '<div id="iam-messages">',
    '  <div id="iam-prechat" style="display:none;margin:4px 2px 6px;background:#fff;border:1.5px solid #e8e8f0;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(108,99,255,.08);">',
    '    <div style="background:'+COLOR+'18;padding:12px 16px 10px;border-bottom:1px solid #eee;">',
    '      <div style="font-weight:700;font-size:13px;color:#333;">Quick intro</div>',
    '      <div style="font-size:12px;color:#888;margin-top:2px;">Completely optional \u2014 feel free to skip.</div>',
    '    </div>',
    '    <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;">',
    '      <input id="iam-pc-name" placeholder="Your name" autocomplete="name" style="background:#f7f7f9;border:1.5px solid #e8e8f0;border-radius:8px;padding:9px 12px;font-size:13px;color:#333;outline:none;width:100%;box-sizing:border-box;font-family:inherit;" />',
    '      <input id="iam-pc-email" type="email" placeholder="Email address" autocomplete="email" style="background:#f7f7f9;border:1.5px solid #e8e8f0;border-radius:8px;padding:9px 12px;font-size:13px;color:#333;outline:none;width:100%;box-sizing:border-box;font-family:inherit;" />',
    '      <div style="display:flex;gap:8px;">',
    '        <button id="iam-prechat-skip" style="background:transparent;border:1.5px solid #e0e0e0;color:#999;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-family:inherit;">Skip</button>',
    '        <button id="iam-prechat-submit" style="flex:1;background:'+COLOR+';color:#fff;border:none;border-radius:8px;padding:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Start Chat &#8594;</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div id="iam-input-area">',
    '  <input id="iam-input" placeholder="Type a message\u2026" autocomplete="off" />',
    '  <button id="iam-send">&#8593;</button>',
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
    if (!container) { console.warn('[IAM] Container not found: '+CONTAINER_ID); return; }
    container.appendChild(win);
  } else {
    document.body.appendChild(win);
  }

  // ── Element refs (grabbed AFTER win is in DOM) ───────────────────────
  var msgsEl    = document.getElementById('iam-messages');
  var input     = document.getElementById('iam-input');
  var sendBtn   = document.getElementById('iam-send');
  var preChatEl = document.getElementById('iam-prechat');
  var pcNameEl  = document.getElementById('iam-pc-name');
  var pcEmailEl = document.getElementById('iam-pc-email');
  var pcSubmit  = document.getElementById('iam-prechat-submit');
  var pcSkip    = document.getElementById('iam-prechat-skip');

  if (IS_INLINE) { var closeBtnInline = document.getElementById('iam-btn-close'); if(closeBtnInline) closeBtnInline.style.display='none'; }

  // ── Bot config ────────────────────────────────────────────────────────
  function applyBotConfig(cfg) {
    var c = cfg.color || COLOR;
    var header = document.getElementById('iam-header');
    var avatar = document.getElementById('iam-bot-avatar');
    var nameEl = document.getElementById('iam-bot-name');
    var ncBtn  = document.getElementById('iam-btn-confirm-nc');
    if (header) header.style.background = c;
    if (sendBtn) sendBtn.style.background = c;
    if (ncBtn)  ncBtn.style.background  = c;
    if (launcher) launcher.style.background = c;
    if (pcSubmit) pcSubmit.style.background = c;
    var initial = (cfg.displayName || cfg.name || 'B').charAt(0).toUpperCase();
    if (nameEl && (cfg.displayName || cfg.name)) nameEl.textContent = cfg.displayName || cfg.name;
    if (avatar) {
      if (cfg.avatarUrl) {
        avatar.innerHTML = '<img src="'+cfg.avatarUrl+'" alt="" onerror="this.parentNode.textContent=\''+initial+'\'" />';
        if (launcher) launcher.innerHTML = '<img src="'+cfg.avatarUrl+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="" onerror="this.style.display=\'none\'" />';
      } else {
        avatar.textContent = initial;
        if (launcher) launcher.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      }
    }
    if (greetingPopup && cfg.greeting) greetingPopup.textContent = cfg.greeting;
  }

  function loadBotConfig(cb) {
    fetch(API_BASE+'/api/bot/config?bot_id='+BOT_ID)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ if(d){ botConfig=d; applyBotConfig(d); } if(cb) cb(); })
      .catch(function(){ if(cb) cb(); });
  }

  // ── Markdown + URL + Citation renderer ─────────────────────────────────
  function md(text) {
    if (!text) return '';
    // Step 1: HTML-escape before any processing
    var h = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Step 2: Parse source citations like [Source 1: document.pdf]\n or [Source 1: https://...]
    // Must run BEFORE URL auto-link so we can pull the link out cleanly.
    var citationsHtml = '';
    var citations = [];
    h = h.replace(/\[Source (\d+): ([^\]]+)\]/g, function(_, num, ref) {
      var isUrl = /^https?:\/\//i.test(ref.trim());
      var isPdf = /\.pdf$/i.test(ref.trim());
      var icon  = isPdf ? '📄' : (isUrl ? '🔗' : '📋');
      var href  = isUrl ? ref.trim() : (isPdf ? (API_BASE + '/api/kb/file?path=' + encodeURIComponent(ref.trim())) : null);
      var pill  = href
        ? '<a href="' + href + '" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;background:rgba(108,99,255,.1);color:' + COLOR + ';border:1px solid rgba(108,99,255,.25);border-radius:20px;padding:2px 8px;text-decoration:none;margin:2px 2px 0;">' + icon + ' Source ' + num + '</a>'
        : '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;background:#f0f0f0;color:#666;border-radius:20px;padding:2px 8px;margin:2px 2px 0;">' + icon + ' ' + ref.trim() + '</span>';
      citations.push(pill);
      return ''; // remove from body text, collect to append below
    });
    if (citations.length) {
      citationsHtml = '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;border-top:1px solid #eee;padding-top:6px;">' + citations.join('') + '</div>';
    }

    // Step 3: Markdown links [text](url) → <a> (convert directly, before auto-link)
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Step 4: Auto-link raw URLs not already inside href="..."
    h = h.replace(/(?<!href=")https?:\/\/[^\s"'<>\[\]]+/gi, function(url) {
      var trailing = '';
      if (/[.,;!?]+$/.test(url)) {
        var match = url.match(/[.,;!?]+$/);
        trailing = match[0];
        url = url.slice(0, -trailing.length);
      }
      return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>' + trailing;
    });

    // Step 6: Basic markdown formatting
    h = h.replace(/^#{1,3} (.+)$/gm,'<strong>$1</strong>');
    h = h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
    h = h.replace(/\*(.+?)\*/g,'<em>$1</em>');
    h = h.replace(/`([^`]+)`/g,'<code style="background:#f4f4f4;padding:1px 5px;border-radius:4px;font-size:12px;">$1</code>');
    h = h.replace(/^[ ]*[-*] (.+)$/gm,'<li>$1</li>');
    h = h.replace(/(<li>[\s\S]*?<\/li>)/g,'<ul style="margin:4px 0;padding-left:16px;">$1</ul>');
    h = h.replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>');

    return h + citationsHtml;
  }

  // ── Timestamp & date separator helpers ─────────────────────────────────
  var _lastShownDate = null;
  function fmtTime(d) {
    var h=d.getHours(), m=d.getMinutes(), ampm=h>=12?'pm':'am';
    h=h%12||12; m=m<10?'0'+m:m;
    return h+':'+m+ampm;
  }
  function fmtDateLabel(d) {
    var now=new Date(), today=now.toDateString(), yesterday=new Date(now-86400000).toDateString();
    if(d.toDateString()===today) return 'today';
    if(d.toDateString()===yesterday) return 'yesterday';
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
  }
  function maybeShowDateSep(ts) {
    var d=ts?new Date(ts):new Date();
    var label=fmtDateLabel(d);
    if(label===_lastShownDate) return;
    _lastShownDate=label;
    var sep=document.createElement('div'); sep.className='iam-date-sep'; sep.textContent=label;
    msgsEl.appendChild(sep);
  }

  // ── Message helpers ───────────────────────────────────────────────────
  function appendBot(c, ts) {
    if(c) _shownBotTexts[c.trim()]=true;
    maybeShowDateSep(ts);
    var w=document.createElement('div'); w.className='iam-bot-wrap';
    var d=document.createElement('div'); d.className='iam-msg bot'; d.style.maxWidth='100%';
    d.innerHTML=md(c);
    var thu='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>';
    var thd='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path></svg>';
    var fb=document.createElement('div'); fb.className='iam-fb'; fb.innerHTML='<button class="iam-fb-btn iam-fb-up" title="Helpful">'+thu+'</button><button class="iam-fb-btn iam-fb-down" title="Needs improvement">'+thd+'</button>';
    var fbF=document.createElement('div'); fbF.className='iam-fb-form'; fbF.innerHTML='<textarea placeholder="Help us improve" rows="2"></textarea><button>Send Feedback</button>';
    d.appendChild(fb);
    w.appendChild(d); w.appendChild(fbF);
    msgsEl.appendChild(w); msgsEl.scrollTop=msgsEl.scrollHeight;

    var upBtn=fb.querySelector('.iam-fb-up'), downBtn=fb.querySelector('.iam-fb-down'), sBtn=fbF.querySelector('button'), txt=fbF.querySelector('textarea'), fbId=null;
    function sb(r,cm){if(!convId)return;fetch(API_BASE+'/api/bot/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:fbId,bot_id:BOT_ID,conversation_id:convId,message_text:c,rating:r,comment:cm})}).then(function(x){return x.json()}).then(function(d){if(d.id)fbId=d.id;}).catch(function(){});}
    upBtn.onclick=function(){
      upBtn.style.background='#e0f2fe'; downBtn.style.background='transparent';
      fbF.style.display='none'; txt.value='';
      // Reset feedback form state in case switching from thumbs down
      sBtn.textContent='Send Feedback'; sBtn.disabled=false;
      sb('positive','');
    };
    downBtn.onclick=function(){
      downBtn.style.background='#fee2e2'; upBtn.style.background='transparent';
      fbF.style.display='flex';
      sb('negative','');
    };
    sBtn.onclick=function(){var v=txt.value.trim();if(!v)return;sBtn.textContent='Saving...';sBtn.disabled=true;sb('negative',v);setTimeout(function(){fbF.innerHTML='<span style="font-size:11px;color:#10b981;font-weight:600;">Thanks for your feedback!</span>';},500);};
  }
  function appendUser(c, ts) {
    maybeShowDateSep(ts);
    var w=document.createElement('div'); w.style.cssText='display:flex;flex-direction:column;align-items:flex-end;margin-bottom:2px;';
    var d=document.createElement('div'); d.className='iam-msg user'; d.textContent=c;
    var status=document.createElement('div'); status.className='iam-msg-status'; status.innerHTML='&#10003;';
    w.appendChild(d); w.appendChild(status);
    msgsEl.appendChild(w); msgsEl.scrollTop=msgsEl.scrollHeight;
    return status;
  }
  function appendAgent(c, ts) {
    maybeShowDateSep(ts);
    var w=document.createElement('div'); w.className='iam-agent-wrap';
    var l=document.createElement('div'); l.className='iam-agent-label'; l.textContent='Support Agent';
    var b=document.createElement('div'); b.className='iam-agent-bubble'; b.innerHTML=md(c);
    var tEl=document.createElement('div'); tEl.className='iam-ts bot-ts'; tEl.textContent=fmtTime(ts?new Date(ts):new Date());
    w.appendChild(l); w.appendChild(b); w.appendChild(tEl); msgsEl.appendChild(w); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function appendSystem(c) {
    var n = botConfig.displayName||botConfig.name||'Bot';
    var lbl = c==='agent_joined' ? 'A live agent has joined' : 'Live agent ended';
    var d=document.createElement('div'); d.className='iam-system';
    d.innerHTML='<span>'+lbl+'</span>'; msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function showTyping() {
    if (document.getElementById('iam-typing')) return;
    var d=document.createElement('div'); d.className='iam-typing'; d.id='iam-typing';
    d.innerHTML='<span></span><span></span><span></span>'; msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function hideTyping() { var t=document.getElementById('iam-typing'); if(t) t.remove(); }

  // ── Safe clear — NEVER removes #iam-prechat ───────────────────────────
  function safeClear() {
    _lastShownDate = null; // reset date separators
    Array.from(msgsEl.children).forEach(function(c) {
      if (c.id !== 'iam-prechat') c.remove();
    });
  }

  // ── Input lock/unlock ─────────────────────────────────────────────────
  function lockInput() {
    var area = document.getElementById('iam-input-area');
    if (area) area.style.display = 'none';
  }
  function unlockInput() {
    var area = document.getElementById('iam-input-area');
    if (area) area.style.display = 'flex';
    input.disabled = false;
    input.placeholder = 'Type a message\u2026';
    sendBtn.disabled = false;
    input.focus();
  }

  // ── Pre-chat form — single clean implementation ───────────────────────
  function showPreChat() {
    if (!preChatEl) return;
    preChatEl.style.display = 'block';
    lockInput();
    [pcNameEl, pcEmailEl].forEach(function(el) {
      if (!el) return;
      el.onfocus = function(){ el.style.borderColor = COLOR; };
      el.onblur  = function(){ el.style.borderColor = '#e8e8f0'; };
    });
    pcSubmit.onclick = submitPreChat;
    pcSkip.onclick   = skipPreChat;
    pcEmailEl.onkeydown = function(e){ if(e.key==='Enter') submitPreChat(); };
    pcNameEl.onkeydown  = function(e){ if(e.key==='Enter') pcEmailEl.focus(); };
    setTimeout(function(){ pcNameEl.focus(); }, 150);
  }

  function hidePreChatForm() {
    if (preChatEl) preChatEl.style.display = 'none';
    unlockInput();
  }

  function skipPreChat() {
    _preChatDone = true;
    hidePreChatForm();
    appendBot(botConfig.greeting);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function submitPreChat() {
    _preChatName  = pcNameEl  ? pcNameEl.value.trim()  : '';
    _preChatEmail = pcEmailEl ? pcEmailEl.value.trim() : '';
    _preChatDone  = true;
    if (_preChatName || _preChatEmail) savePrechatLead(_preChatName, _preChatEmail);
    hidePreChatForm();
    var base  = botConfig.greeting || 'Hi! How can I help you today?';
    var greet = base;
    if (_preChatName) {
      greet = base.replace(/^(hi|hello|hey)[\s!,]*/i, 'Hi ' + _preChatName + ', ');
      if (greet === base) greet = 'Hi ' + _preChatName + '! ' + base;
    }
    appendBot(greet);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function savePrechatLead(name, email) {
    if (!convId) return;
    fetch(API_BASE+'/api/conversation/capture-lead', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ bot_id:BOT_ID, conversation_id:convId, name:name||null, email:email||null })
    }).then(function(r){ return r.json(); })
      .then(function(d){ console.log('[IAM] Lead saved:', d.action); })
      .catch(function(e){ console.warn('[IAM] Lead save failed:', e); });
  }

  // ── HITL polling ──────────────────────────────────────────────────────
  function startPolling(cId) {
    if (_pollInterval) return;
    _hitlActive = true;
    stopStatusCheck();
    _pollInterval = setInterval(function() {
      var url = API_BASE+'/api/conversation/messages?conversation_id='+cId;
      if (_lastMsgAt) url += '&after='+encodeURIComponent(_lastMsgAt);
      fetch(url).then(function(r){ return r.json(); }).then(function(data) {
        if (!data.messages) return;
        data.messages.forEach(function(m) {
          if (!_lastMsgAt || m.created_at > _lastMsgAt) _lastMsgAt = m.created_at;
          if (m.role==='human-agent') { if(_shownMsgIds[m.id]) return; _shownMsgIds[m.id]=true; appendAgent(m.content); isSending=false; }
          if (m.role==='system')      { if(_shownSysMsgs[m.content]) return; _shownSysMsgs[m.content]=true; appendSystem(m.content); if(m.content==='agent_left'){ _hitlActive=false; stopPolling(); startStatusCheck(cId); } }
          if (m.role==='bot')         { if(_shownMsgIds[m.id]) return; _shownMsgIds[m.id]=true; if(_shownBotTexts[m.content.trim()]) return; hideTyping(); appendBot(m.content); isSending=false; }
        });
        if (data.hitl_active===false && _hitlActive) { _hitlActive=false; stopPolling(); startStatusCheck(cId); }
      }).catch(function(){});
    }, 2000);
  }
  function stopPolling() { if(_pollInterval){ clearInterval(_pollInterval); _pollInterval=null; } }

  function startStatusCheck(cId) {
    stopStatusCheck();
    _statusInterval = setInterval(function() {
      if (_pollInterval) { stopStatusCheck(); return; }
      fetch(API_BASE+'/api/conversation/messages?conversation_id='+cId)
        .then(function(r){ return r.json(); })
        .then(function(data) {
          if (data.hitl_active && !_pollInterval) { _shownSysMsgs['agent_joined']=true; appendSystem('agent_joined'); startPolling(cId); }
        }).catch(function(){});
    }, 5000);
  }
  function stopStatusCheck() { if(_statusInterval){ clearInterval(_statusInterval); _statusInterval=null; } }

  // ── Create / resume conversation ──────────────────────────────────────
  function createConversation(cb) {
    if (convId) { if(cb) cb(); return; }

    safeClear();
    var loader = document.createElement('div');
    loader.id = 'iam-init-loader';
    loader.style.cssText = 'display:flex;justify-content:center;padding:24px;';
    loader.innerHTML = '<div class="iam-spinner"></div>';
    msgsEl.appendChild(loader);

    fetch(API_BASE+'/api/conversation/create', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        bot_id:BOT_ID, user_id:getVisitorId(),
        page_url:window.location.href, referrer_url:document.referrer||null,
        page_title:document.title||null, browser_language:navigator.language||null,
        user_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||null,
        device_type:/Mobi|Android/i.test(navigator.userAgent)?'mobile':'desktop',
        user_platform:navigator.platform||null
      })
    })
    .then(function(r){ return r.json(); })
    .then(function(data) {
      convId = data.conversation_id;
      // If form was submitted before convId was ready, save lead now
      if (_preChatDone && (_preChatName || _preChatEmail)) savePrechatLead(_preChatName, _preChatEmail);

      var l = document.getElementById('iam-init-loader'); if(l) l.remove();
      
      if (data.returning) {
        _preChatDone = true;
        hidePreChatForm();
        fetch(API_BASE+'/api/conversation/messages?conversation_id='+convId)
          .then(function(r){ return r.json(); })
          .then(function(d) {
            safeClear();
            _shownMsgIds={}; _shownSysMsgs={};
            if (d.messages && d.messages.length) {
              d.messages.forEach(function(m) {
                if(m.id) _shownMsgIds[m.id]=true;
                if(m.role==='system'){ _shownSysMsgs[m.content]=true; appendSystem(m.content); }
                else if(m.role==='human-agent') appendAgent(m.content, m.created_at);
                else if(m.role==='bot')  appendBot(m.content, m.created_at);
                else if(m.role==='user') appendUser(m.content, m.created_at);
                if(!_lastMsgAt||m.created_at>_lastMsgAt) _lastMsgAt=m.created_at;
              });
            }
            d.hitl_active ? startPolling(convId) : startStatusCheck(convId);
            isSending = false; // ensure send is never stuck for returning users
            unlockInput();
            if(cb) cb();
          }).catch(function(){ startStatusCheck(convId); unlockInput(); if(cb) cb(); });

      } else {
        // New visitor — reveal the prechat form now
        _shownMsgIds={}; _shownSysMsgs={};
        _lastMsgAt = new Date().toISOString();
        startStatusCheck(convId);
        
        if (!_preChatDone) showPreChat();

        // If they bypass prechat, append greeting. Otherwise wait for submitPreChat
        if (_preChatDone && !document.querySelector('.iam-msg.bot')) {
          appendBot(botConfig.greeting);
        }
        if(cb) cb();
      }
    })
    .catch(function(e){ console.error('[IAM] Conv create failed:', e); if(cb) cb(); });
  }

  // ── Send message ───────────────────────────────────────────────────────
  function sendMessage() {
    if (!_preChatDone) return; // blocked until form is dismissed
    var text = input.value.trim();
    if (!text || isSending) return;
    var message = text;
    var userLanguage = document.getElementById('iam-language-select').value;
    var statusEl = appendUser(message);
    input.value = '';
    msgsEl.scrollTop = msgsEl.scrollHeight;

    isSending = true;
    showTyping();
    fetch(API_BASE+'/api/bot/respond', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ bot_id:BOT_ID, conversation_id:convId, message:message, user_language:userLanguage })
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      if(statusEl) statusEl.innerHTML='&#10003;&#10003;';
      hideTyping();
      if (data.hitl_active) {
        if (!_hitlActive && !_pollInterval) { _shownSysMsgs['agent_joined']=true; startPolling(convId); }
        isSending=false; return;
      }
      if (data.action === 'redirect' && data.url) {
        appendActionCard(data.url);
      } else if (data.response) {
        appendBot(data.response);
      }
      isSending=false;
    })
    .catch(function(){ hideTyping(); appendBot('Sorry, something went wrong.'); isSending=false; });
  }

  // ── Action Redirect Card ───────────────────────────────────────────────
  function appendActionCard(url) {
    maybeShowDateSep(new Date().toISOString());
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;margin:16px 16px 2px 16px;';
    
    var bubble = document.createElement('div');
    bubble.className = 'iam-msg bot';
    bubble.style.cssText = 'background:var(--bg-elevated, #fff); color:var(--text, #111827); box-shadow:0 3px 12px rgba(0,0,0,0.06); border:1px solid #e5e7eb; padding:16px; border-radius:16px; border-bottom-left-radius:4px; max-width:88%; font-family:inherit; font-size:14px; line-height:1.5; text-align:center;';
    
    bubble.innerHTML = 
      '<div style="font-weight:600; margin-bottom:8px; color:#111827;">Here are your results!</div>' +
      '<div style="font-size:13px; color:#6b7280; margin-bottom:12px;">I\'ve gathered exactly what you are looking for.</div>' +
      '<a href="' + url + '" target="_blank" style="display:inline-block; background:' + (botConfig.color || '#000') + '; color:#fff; text-decoration:none; padding:10px 18px; border-radius:8px; font-weight:600; font-size:13px; transition:opacity 0.2s;">' +
      '  View Results' +
      '</a>';
    
    wrapper.appendChild(bubble);
    msgsEl.appendChild(wrapper);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ── New conversation ───────────────────────────────────────────────────
  function showNewConvConfirm() { document.getElementById('iam-new-conv-confirm').style.display='flex'; }
  function hideNewConvConfirm() { document.getElementById('iam-new-conv-confirm').style.display='none'; }
  function startNewConversation() {
    hideNewConvConfirm();
    stopPolling(); stopStatusCheck();
    convId=null; isSending=false; _hitlActive=false; _lastMsgAt=null;
    _shownMsgIds={}; _shownSysMsgs={};
    _preChatDone=false; _preChatName=''; _preChatEmail='';
    localStorage.setItem('iam_visitor_id', 'vis_'+Date.now().toString(36)+'_'+Math.random().toString(36).substr(2,9));
    safeClear();
    createConversation(function(){});
  }

  // ── Open / close ───────────────────────────────────────────────────────
  function openWidget() {
    if (greetingPopup) greetingPopup.style.display = 'none';
    win.style.display = 'flex';
    if (launcher) launcher.style.display = 'none';
    if (!convId) {
      loadBotConfig(function(){ createConversation(function(){}); });
    } else {
      if (_hitlActive && !_pollInterval) startPolling(convId);
      if (!_preChatDone) showPreChat(); else input.focus();
    }
  }

  function closeWidget() {
    if (IS_INLINE) return;
    win.style.display = 'none';
    if (launcher) launcher.style.display = 'flex';
    hideNewConvConfirm();
    if (greetingPopup) { greetingPopup.textContent = botConfig.greeting; greetingPopup.style.display = 'block'; }
  }

  // Auto-detect browser language and map it to the dropdown options
  (function(){
    var sel = document.getElementById('iam-language-select');
    if (!sel) return;
    var code = (navigator.language || navigator.userLanguage || '').substr(0, 2).toLowerCase();
    var langMap = { 'en':'english', 'es':'spanish', 'fr':'french', 'de':'german', 'it':'italian', 'pt':'portuguese', 'nl':'dutch', 'ru':'russian', 'ar':'arabic', 'zh':'chinese', 'ja':'japanese', 'ko':'korean' };
    var userLangName = langMap[code];
    if (userLangName && sel) {
      var opts = sel.options;
      for (var i=0; i<opts.length; i++) { if (opts[i].value===userLangName) { sel.selectedIndex=i; break; } }
    }
    
    if (sel) {
      var updateLangDisp = function() {
        var v = sel.value;
        var dispMap = { 'auto':'auto', 'english':'en', 'spanish':'es', 'french':'fr', 'german':'de', 'italian':'it', 'portuguese':'pt', 'dutch':'nl', 'russian':'ru', 'arabic':'ar', 'chinese':'zh', 'japanese':'ja', 'korean':'ko' };
        var short = dispMap[v] || v;
        document.getElementById('iam-lang-disp').innerHTML = short + ' <svg fill="#ffffff" height="16" viewBox="0 0 24 24" width="16"><path d="M7 10l5 5 5-5z"/></svg>';
      };
      sel.addEventListener('change', updateLangDisp);
      updateLangDisp(); // init run
    }
  })();

  // ── Wire events ────────────────────────────────────────────────────────
  if (launcher) launcher.addEventListener('click', openWidget);
  var closeBtnEl = document.getElementById('iam-btn-close');
  if (closeBtnEl) closeBtnEl.addEventListener('click', closeWidget);
  document.getElementById('iam-btn-new').addEventListener('click', showNewConvConfirm);
  document.getElementById('iam-btn-cancel-nc').addEventListener('click', hideNewConvConfirm);
  document.getElementById('iam-btn-confirm-nc').addEventListener('click', startNewConversation);
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); } });

  // ── Init ───────────────────────────────────────────────────────────────
  if (IS_INLINE) {
    loadBotConfig(function(){ createConversation(function(){}); });
  } else {
    loadBotConfig(function(){ if(greetingPopup) greetingPopup.textContent = botConfig.greeting; });
  }

})(window, document);
