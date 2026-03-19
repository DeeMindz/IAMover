/* ═══════════════════════════════════════════════════════════════════
   IAM Platform — Main App JS
   ═══════════════════════════════════════════════════════════════════ */

import { Auth, Bots, KnowledgeBases, Conversations, Leads, Analytics, supabase } from './supabase.js';

/* ─── Persistent Storage (LocalDB) ───────────────────────────────── */
const LocalDB = {
  set(key, value) {
    try {
      localStorage.setItem(`iam_${key}`, JSON.stringify({
        value,
        savedAt: Date.now()
      }))
    } catch (e) { }
  },

  get(key) {
    try {
      const raw = localStorage.getItem(`iam_${key}`)
      if (!raw) return null
      return JSON.parse(raw).value
    } catch (e) { return null }
  },

  getSavedAt(key) {
    try {
      const raw = localStorage.getItem(`iam_${key}`)
      if (!raw) return null
      return JSON.parse(raw).savedAt
    } catch (e) { return null }
  },

  clear(key) {
    if (key) localStorage.removeItem(`iam_${key}`)
    else Object.keys(localStorage)
      .filter(k => k.startsWith('iam_'))
      .forEach(k => localStorage.removeItem(k))
  }
}

/* ─── Reactive Store ─────────────────────────────────────────────── */
const Store = {
  _listeners: {},

  on(key, callback) {
    if (!this._listeners[key]) this._listeners[key] = []
    this._listeners[key].push(callback)
  },

  off(key, callback) {
    if (!this._listeners[key]) return
    this._listeners[key] = this._listeners[key].filter(cb => cb !== callback)
  },

  set(key, value) {
    AppState[key] = value
    LocalDB.set(key, value)
    if (this._listeners[key]) {
      this._listeners[key].forEach(cb => cb(value))
    }
  },

  get(key) {
    return AppState[key]
  },

  updateItem(key, id, updates) {
    const arr = AppState[key] || []
    const index = arr.findIndex(item => item.id === id)
    if (index === -1) return
    arr[index] = { ...arr[index], ...updates }
    this.set(key, [...arr])
  },

  removeItem(key, id) {
    const arr = AppState[key] || []
    this.set(key, arr.filter(item => item.id !== id))
  },

  addItem(key, item) {
    const arr = AppState[key] || []
    this.set(key, [item, ...arr])
  }
}


/* ─── Cache ──────────────────────────────────────────────────────── */
const Cache = {
  data: {},
  ttl: 60000, // 1 minute

  set(key, value) {
    this.data[key] = { value, timestamp: Date.now() }
  },

  get(key) {
    const entry = this.data[key]
    if (!entry) return null
    if (Date.now() - entry.timestamp > this.ttl) {
      delete this.data[key]
      return null
    }
    return entry.value
  },

  clear(key) {
    if (key) delete this.data[key]
    else this.data = {}
  }
};

/* ─── Preview State (persists across widget/fullpage mode switches) ─── */
const PreviewState = {
  convId: null,
  messages: [],  // { role: 'user'|'bot', content: string }[]
};

/* ─── App State ──────────────────────────────────────────────────── */
const AppState = {
  currentPage: 'home',
  currentBot: null,
  currentUser: null,
  bots: [],
  knowledgeBases: [],
  leads: [],
  conversations: [],
  activeConversation: null,
  hitlActive: false,
};

// Expose AppState globally for inline onclick handlers
window.AppState = AppState;

/* ─── Initialization & Auth Guard ────────────────────────────────── */
async function initApp() {
  // Step 1: Load cached data FIRST — renders instantly from localStorage
  loadFromLocalStorage();

  // Step 2: Check cached session (avoids Supabase round-trip on every refresh)
  const cachedUser = LocalDB.get('session_user');
  if (cachedUser) {
    AppState.currentUser = cachedUser;
    registerReactiveListeners();
    setupEventListeners();
    setupLivePreviews();
    setUserUI(cachedUser);
    const wsEl = document.getElementById('sidebar-workspace-name');
    if (wsEl && cachedUser.profile) wsEl.textContent = cachedUser.profile.workspace_name || 'My Workspace';
    updateSidebarUsage(AppState.bots);
    // Render immediately from cache
    navigate('home');
    // Then verify session is still valid in background
    verifySessionInBackground();
    return;
  }

  // Step 3: No cached session — must hit Supabase to check auth
  const user = await Auth.getUser();
  if (!user) {
    window.location.href = 'auth.html';
    return;
  }

  AppState.currentUser = user;
  registerReactiveListeners();
  setupEventListeners();
  setupLivePreviews();

  // Load profile then render
  await loadUserProfile();
  navigate('home');
  syncInBackground();
}

async function verifySessionInBackground() {
  try {
    const user = await Auth.getUser();
    if (!user) {
      // Session expired
      LocalDB.clear();
      window.location.href = 'auth.html';
      return;
    }
    // Session valid — sync if stale
    syncInBackground();
  } catch (e) {
    console.warn('Session verify failed:', e);
  }
}

document.addEventListener('DOMContentLoaded', initApp);

/* ─── Persistent Visitor ID — managed by parent window ───────────────── */
// iframe cannot access localStorage so parent manages visitor ID
function getOrCreateVisitorId() {
  let vid = localStorage.getItem('iam_visitor_id');
  if (!vid) {
    vid = 'vis_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('iam_visitor_id', vid);
  }
  return vid;
}

/* ─── PostMessage Bridge for Preview Iframe ───────────────────────── */
// Listen for messages from preview iframe to call API (avoids CORS)
window.addEventListener('message', async function (e) {
  console.log('[IAM Bridge] Received message:', e.data);

  // Security: verify origin in production
  if (!e.data || !e.data.type) return;

  // Handle conversation creation
  if (e.data.type === 'IAM_CONV_CREATE') {
    console.log('[IAM Bridge] Creating conversation for bot:', e.data.bot_id);
    try {
      // Parent window manages visitor ID — iframe cannot access localStorage
      const visitor_id = getOrCreateVisitorId();

      const res = await fetch('/api/conversation/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_id: e.data.bot_id,
          user_id: visitor_id,
          page_url: window.location.href,
          referrer_url: document.referrer || null,
          page_title: document.title || null,
          browser_language: navigator.language || null,
          user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          device_type: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
          user_platform: navigator.platform || null,
        })
      });
      console.log('[IAM Bridge] /api/conversation/create response status:', res.status, res.statusText);
      const text = await res.text();
      console.log('[IAM Bridge] /api/conversation/create raw response:', text);
      if (!res.ok) {
        console.error('[IAM Bridge] API error:', res.status, text);
        e.source.postMessage({ type: 'IAM_CONV_ERROR', error: 'API error: ' + res.status }, '*');
        return;
      }
      const data = JSON.parse(text);
      console.log('[IAM Bridge] Created conversation:', data);
      e.source.postMessage({
        type: 'IAM_CONV_CREATED',
        conv_id: data.conversation_id,
        returning: data.returning
      }, '*');
      // Save conv ID to PreviewState for persistence across mode switches
      if (data.conversation_id) {
        PreviewState.convId = data.conversation_id;
        // Start real-time subscription immediately for this conversation
        // This ensures agent messages and HITL notifications always reach the widget
        startWidgetRealtimeSubscription(e.source, data.conversation_id);
      }
      // Load history for returning visitors
      if (data.returning && data.conversation_id) {
        try {
          const msgsRes = await fetch('/api/conversation/messages?conversation_id=' + data.conversation_id);
          if (msgsRes.ok) {
            const msgsData = await msgsRes.json();
            if (msgsData.messages && msgsData.messages.length > 0) {
              e.source.postMessage({ type: 'IAM_LOAD_HISTORY', messages: msgsData.messages }, '*');
            }
          }
        } catch(err) { console.warn('[IAM Bridge] History load failed:', err); }
      }
    } catch (err) {
      console.error('[IAM Bridge] Exception creating conversation:', err);
      e.source.postMessage({ type: 'IAM_CONV_ERROR', error: err.message }, '*');
    }
  }

  // Handle new conversation request from widget
  if (e.data.type === 'IAM_NEW_CONV') {
    console.log('[IAM Bridge] New conversation requested for bot:', e.data.bot_id);
    // Stop existing real-time subscription
    if (_widgetRealtimeSub) {
      _widgetRealtimeSub.unsubscribe();
      _widgetRealtimeSub = null;
    }
    PreviewState.convId = null;
    PreviewState.messages = [];
    // Create new conversation
    try {
      const visitor_id = getOrCreateVisitorId();
      const res = await fetch('/api/conversation/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_id: e.data.bot_id,
          user_id: visitor_id + '_new_' + Date.now(), // new visitor ID for fresh conv
          page_url: window.location.href,
        })
      });
      const data = await res.json();
      if (data.conversation_id) {
        PreviewState.convId = data.conversation_id;
        e.source.postMessage({ type: 'IAM_CONV_CREATED', conv_id: data.conversation_id, returning: false }, '*');
        startWidgetRealtimeSubscription(e.source, data.conversation_id);
      }
    } catch(err) { console.warn('[IAM Bridge] New conv create failed:', err); }
  }

  // Handle bot response request
  if (e.data.type === 'IAM_BOT_REQUEST') {
    const { message, bot_id, conv_id } = e.data;
    console.log('[IAM Bridge] Bot request:', { message, bot_id, conv_id });
    // Save user message to PreviewState
    if (message) {
      PreviewState.messages.push({ role: 'user', content: message });
    }
    try {
      const res = await fetch('/api/bot/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, bot_id, conversation_id: conv_id })
      });
      console.log('[IAM Bridge] /api/bot/respond response status:', res.status, res.statusText);
      const text = await res.text();
      console.log('[IAM Bridge] /api/bot/respond raw response:', text);
      if (!res.ok) {
        console.error('[IAM Bridge] API error:', res.status, text);
        e.source.postMessage({
          type: 'IAM_BOT_RESPONSE',
          response: 'API Error: ' + res.status + ' - ' + text
        }, '*');
        return;
      }
      const data = JSON.parse(text);
      console.log('[IAM Bridge] Bot response:', data);
      // If HITL is active, do not send any response to widget — human agent is handling it
      if (data.hitl_active) {
        console.log('[IAM Bridge] HITL active — suppressing bot response in widget');
        // Subscribe to real-time messages so agent messages reach the widget
        if (data.conversation_id || conv_id) {
          startWidgetRealtimeSubscription(e.source, data.conversation_id || conv_id);
        }
        return;
      }
      if (data.response) {
        e.source.postMessage({
          type: 'IAM_BOT_RESPONSE',
          response: data.response,
          conv_id: data.conversation_id
        }, '*');
        PreviewState.messages.push({ role: 'bot', content: data.response });
      }
    } catch (err) {
      console.error('[IAM Bridge] Exception in bot request:', err);
      e.source.postMessage({
        type: 'IAM_BOT_RESPONSE',
        response: 'Error: ' + err.message
      }, '*');
    }
  }
});

// Real-time subscription so agent messages reach the widget during HITL
let _widgetRealtimeSub = null;
function startWidgetRealtimeSubscription(iframeSource, convId) {
  if (_widgetRealtimeSub) {
    _widgetRealtimeSub.unsubscribe();
    _widgetRealtimeSub = null;
  }
  if (!convId) return;
  console.log('[IAM Bridge] Starting real-time widget subscription for conv:', convId);
  _widgetRealtimeSub = supabase
    .channel('widget_conv_' + convId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
      filter: 'conversation_id=eq.' + convId
    }, (payload) => {
      const msg = payload.new;
      console.log('[IAM Bridge] Real-time message received:', msg);

      // Helper to find active preview iframes
      const getIframes = () => {
        const iframes = [];
        const m = document.getElementById('preview-iframe');
        const i = document.getElementById('preview-iframe-inline');
        if (m && m.contentWindow) iframes.push(m.contentWindow);
        if (i && i.contentWindow) iframes.push(i.contentWindow);
        return iframes;
      };

      if (msg.role === 'human-agent') {
        // Push agent message to all preview iframes
        getIframes().forEach(w => w.postMessage({
          type: 'IAM_AGENT_MESSAGE',
          content: msg.content,
          time: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }, '*'));

        // Also show in dashboard conversation panel if open
        const convMsgsEl = document.getElementById('conv-messages');
        if (convMsgsEl && AppState.activeConversation === convId) {
          // Check if already rendered (optimistic) — avoid duplicate
          const existing = convMsgsEl.querySelectorAll('.message.bot');
          const lastBot = existing[existing.length - 1];
          const alreadyShown = lastBot && lastBot.querySelector('.msg-bubble')?.textContent === msg.content;
          if (!alreadyShown) {
            const div = document.createElement('div');
            div.className = 'message bot';
            const t = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            div.innerHTML = `<div class="msg-avatar" style="background:#10b98133;">👤</div>
              <div><div style="font-size:10px;color:#10b981;margin-bottom:2px;">Support Agent</div>
              <div class="msg-bubble" style="border-left:3px solid #10b981;">\${msg.content}</div>
              <div class="msg-time">\${t}</div></div>`;
            convMsgsEl.appendChild(div);
            convMsgsEl.scrollTop = convMsgsEl.scrollHeight;
          }
        }
      }

      if (msg.role === 'system') {
        getIframes().forEach(w => w.postMessage({
          type: 'IAM_SYSTEM_MESSAGE',
          content: msg.content,
        }, '*'));
        if (msg.content === 'agent_left') {
          if (_widgetRealtimeSub) {
            _widgetRealtimeSub.unsubscribe();
            _widgetRealtimeSub = null;
          }
        }
      }
    })
    .subscribe();
}
window.startWidgetRealtimeSubscription = startWidgetRealtimeSubscription;

function setupEventListeners() {
  // Add some initial inline styling so the bot features start hidden if we launch on home
  $$('.nav-item[data-bot-feature="true"]').forEach(n => n.style.display = 'none');
  const dataSec = document.getElementById('sidebar-section-data');
  if (dataSec) dataSec.style.display = 'none';

  // Modal close on overlay click
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // Panel close on overlay click
  $$('.panel-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // Agent message send on Enter
  const agentInput = document.getElementById('agent-input');
  if (agentInput) {
    agentInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgentMessage(); }
    });
  }

  // Upload zone drag events
  $$('.upload-zone').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const files = [...e.dataTransfer.files];
      if (files.length) showToast(`${files.length} file(s) uploaded`, 'success');
    });
  });
}

function loadFromLocalStorage() {
  const bots = LocalDB.get('bots');
  const leads = LocalDB.get('leads');
  const kbs = LocalDB.get('knowledge_bases');

  if (bots) AppState.bots = bots;
  if (leads) AppState.leads = leads;
  // Sync both key forms so Store.get('knowledge_bases') and AppState.knowledgeBases both work
  if (kbs) {
    AppState.knowledgeBases = kbs;
    AppState['knowledge_bases'] = kbs;
  }
}

async function loadUserProfile() {
  try {
    const user = AppState.currentUser;
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    const enrichedUser = { ...user, profile: profile || {} };

    if (profile) {
      const workspaceEl = document.getElementById('sidebar-workspace-name');
      if (workspaceEl) workspaceEl.textContent = profile.workspace_name || 'My Workspace';
    } else {
      // Auto-create profile for new users
      await supabase.from('profiles').insert({
        id: user.id,
        email: user.email,
        full_name: user.user_metadata?.full_name || user.email,
        workspace_name: 'My Workspace',
      });
    }

    Store.set('currentUser', enrichedUser);
    // Cache the full user+profile so next load is instant
    LocalDB.set('session_user', enrichedUser);

  } catch (e) {
    console.warn('Profile load failed:', e);
    setUserUI(AppState.currentUser);
  }
}

async function syncInBackground() {
  const STALE_MS = 10 * 60 * 1000; // 10 minutes
  const lastSync = LocalDB.getSavedAt('bots');
  const kbLastSync = LocalDB.getSavedAt('knowledge_bases');
  const hasCachedData = AppState.bots && AppState.bots.length > 0;
  const hasKBCachedData = AppState.knowledgeBases && AppState.knowledgeBases.length > 0;
  const isStale = !lastSync || (Date.now() - lastSync > STALE_MS);
  const isKBStale = !kbLastSync || (Date.now() - kbLastSync > STALE_MS);

  const el = document.getElementById('sync-indicator');
  const shouldSkipBotsLeads = hasCachedData && !isStale;
  const shouldSkipKB = hasKBCachedData && !isKBStale;

  if (el) el.textContent = 'Syncing...';

  try {
    let bots, leads, kbs;

    if (shouldSkipBotsLeads && shouldSkipKB) {
      // All cached and not stale - skip all
      if (el) el.textContent = 'Up to date';
      return;
    } else if (shouldSkipBotsLeads) {
      // Only sync KB
      kbs = await KnowledgeBases.getAll();
      bots = AppState.bots;
      leads = AppState.leads;
    } else if (shouldSkipKB) {
      // Only sync bots and leads
      [bots, leads] = await Promise.all([Bots.getAll(), Leads.getAll()]);
      kbs = AppState.knowledgeBases;
    } else {
      // Fetch all three in parallel
      [bots, leads, kbs] = await Promise.all([
        Bots.getAll(),
        Leads.getAll(),
        KnowledgeBases.getAll(),
      ]);
    }

    // Only update Store (and trigger re-renders) if data actually changed
    const botsChanged = JSON.stringify(bots) !== JSON.stringify(AppState.bots);
    const leadsChanged = JSON.stringify(leads) !== JSON.stringify(AppState.leads);
    const kbsChanged = JSON.stringify(kbs) !== JSON.stringify(AppState.knowledgeBases);

    if (botsChanged) Store.set('bots', bots);
    else if (!shouldSkipBotsLeads) LocalDB.set('bots', bots);

    if (leadsChanged) Store.set('leads', leads);
    else if (!shouldSkipBotsLeads) LocalDB.set('leads', leads);

    if (kbsChanged) Store.set('knowledge_bases', kbs);
    else if (!shouldSkipKB) LocalDB.set('knowledge_bases', kbs);

    // Update messages sidebar counter (lightweight — head-only count query)
    try {
      const { count: msgCount } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'user');
      const msgEl  = document.getElementById('messages-used');
      const msgBar = document.getElementById('messages-bar');
      if (msgEl)  msgEl.textContent  = formatNum(msgCount || 0);
      if (msgBar) msgBar.style.width = `${Math.min((msgCount || 0) / 10, 100)}%`;
    } catch (_) { /* non-critical */ }

    updateSyncIndicator();
  } catch (e) {
    console.warn('Background sync failed:', e);
    if (el) el.textContent = 'Offline';
  }
}

function registerReactiveListeners() {
  Store.on('bots', (bots) => {
    if (AppState.currentPage === 'home') renderHome();
    updateSidebarUsage(bots);
    updateSyncIndicator();
  });

  Store.on('leads', (leads) => {
    if (AppState.currentPage === 'leads') renderLeads();
    updateSyncIndicator();
  });

  Store.on('knowledge_bases', (kbs) => {
    if (AppState.currentPage === 'knowledge') renderKnowledge();
    updateSyncIndicator();
  });

  Store.on('currentUser', (user) => {
    setUserUI(user);
    const profile = user.profile || {};
    const workspaceEl = document.getElementById('sidebar-workspace-name');
    if (workspaceEl) workspaceEl.textContent = profile.workspace_name || 'My Workspace';

    // Update settings form if on settings page
    if (AppState.currentPage === 'settings') {
      const nameInp = document.getElementById('settings-profile-name');
      const workInp = document.getElementById('settings-workspace-name');
      if (nameInp) nameInp.value = profile.full_name || '';
      if (workInp) workInp.value = profile.workspace_name || '';
    }
  });

  Store.on('currentBot', (bot) => {
    if (!bot) return;
    if (AppState.currentPage === 'bot-config') {
      $$('.bc-bot-name-link, #bc-bot-name, #bc-bot-config-name, #conv-bot-name').forEach(el => el.textContent = bot.name);
      fillBotForm(bot);
    }
    renderEmbedCode(bot);
  });
}


function updateSidebarUsage(bots) {
  const count = (bots || []).length;
  const el = document.getElementById('bots-used');
  const bar = document.getElementById('bots-bar');
  if (el) el.textContent = `${count} bot${count !== 1 ? 's' : ''}`;
  if (bar) bar.style.width = `${Math.min(count * 10, 100)}%`;
}

function updateSyncIndicator() {
  const el = document.getElementById('sync-indicator');
  const savedAt = LocalDB.getSavedAt('bots');
  if (!el || !savedAt) return;
  const mins = Math.floor((Date.now() - savedAt) / 60000);
  el.textContent = mins === 0 ? 'Synced just now' : `Synced ${mins}m ago`;
}

function setUserUI(user) {
  const profile = user.profile || {};
  const meta = user.user_metadata || {};

  // Priority: Profile Name -> Metadata Name -> Email as fallback
  const fullName = profile.full_name || meta.full_name || '';
  const initial = (fullName || user.email).charAt(0).toUpperCase();

  const avatarEl = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-menu-name');
  const emailEl = document.getElementById('user-menu-email');

  if (avatarEl) avatarEl.textContent = initial;
  if (nameEl) {
    nameEl.textContent = fullName || 'New User';
    nameEl.style.color = fullName ? 'var(--text-primary)' : 'var(--text-muted)';
  }
  if (emailEl) emailEl.textContent = user.email;

  // Update Settings page owner info
  const ownerAvatar = document.getElementById('owner-avatar');
  const ownerEmail = document.getElementById('owner-email');
  if (ownerAvatar) ownerAvatar.textContent = initial;
  if (ownerEmail) ownerEmail.textContent = user.email;
}

/* ─── Auth Actions ───────────────────────────────────────────────── */
async function saveWorkspaceSettings() {
  const profileName = document.getElementById('settings-profile-name')?.value.trim();
  const workspaceName = document.getElementById('settings-workspace-name')?.value.trim();

  try {
    const user = AppState.currentUser;
    const { error } = await supabase.from('profiles').update({
      full_name: profileName,
      workspace_name: workspaceName
    }).eq('id', user.id);

    if (error) throw error;

    // Update Store
    Store.set('currentUser', {
      ...user,
      profile: { ...user.profile, full_name: profileName, workspace_name: workspaceName }
    });

    showToast('Settings saved successfully', 'success');
  } catch (e) {
    console.error(e);
    showToast('Failed to save settings', 'error');
  }
}
window.saveWorkspaceSettings = saveWorkspaceSettings;

function setupLivePreviews() {
  // Bot name live update
  const nameInput = document.getElementById('cfg-bot-name');
  if (nameInput) {
    nameInput.addEventListener('input', (e) => {
      const nameEl = document.getElementById('bot-config-name');
      if (nameEl) nameEl.textContent = e.target.value;
      if (AppState.currentBot) {
        AppState.currentBot.name = e.target.value;
        renderEmbedCode(AppState.currentBot);
        renderLivePreview(AppState.currentBot);
      }
    });
  }

  // Primary color live update
  const colorInput = document.getElementById('cfg-primary-color');
  if (colorInput) {
    colorInput.addEventListener('input', (e) => {
      const val = e.target.value;
      // Sync the hex text input next to the color swatch
      const hexInput = colorInput.nextElementSibling;
      if (hexInput && hexInput.type !== 'color') hexInput.value = val;
      const bubble = document.getElementById('cfg-preview-bubble');
      if (bubble) bubble.style.background = val;
      if (AppState.currentBot) {
        if (!AppState.currentBot.theme) AppState.currentBot.theme = {};
        AppState.currentBot.theme.primaryColor = val;
        renderEmbedCode(AppState.currentBot);
        renderLivePreview(AppState.currentBot);
      }
    });
  }

  // Greeting message live update
  const greetingInput = document.getElementById('cfg-greeting');
  if (greetingInput) {
    greetingInput.addEventListener('input', (e) => {
      if (AppState.currentBot) {
        AppState.currentBot.greeting_message = e.target.value;
        renderLivePreview(AppState.currentBot);
      }
    });
  }

  // Widget position live update
  const positionSelect = document.getElementById('cfg-widget-position');
  if (positionSelect) {
    positionSelect.addEventListener('change', (e) => {
      if (AppState.currentBot) {
        if (!AppState.currentBot.theme) AppState.currentBot.theme = {};
        AppState.currentBot.theme.position = e.target.value;
        renderLivePreview(AppState.currentBot);
      }
    });
  }

  // Bot display name live update
  const displayNameInput = document.getElementById('cfg-display-name');
  if (displayNameInput) {
    displayNameInput.addEventListener('input', (e) => {
      if (AppState.currentBot) {
        if (!AppState.currentBot.theme) AppState.currentBot.theme = {};
        AppState.currentBot.theme.displayName = e.target.value;
        renderLivePreview(AppState.currentBot);
      }
    });
  }
}

function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  if (!menu) return;
  const isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';
}
window.toggleUserMenu = toggleUserMenu;

document.addEventListener('click', (e) => {
  const avatar = document.getElementById('user-avatar');
  const menu = document.getElementById('user-menu');
  if (!menu || menu.style.display === 'none') return;
  if (!menu.contains(e.target) && e.target !== avatar) {
    menu.style.display = 'none';
  }
});

async function handleSignOut() {
  try {
    await Auth.signOut();
  } catch (e) {
    console.warn('Sign out error:', e);
  } finally {
    LocalDB.clear(); // clears session_user, bots, leads, kbs, everything
    window.location.href = 'auth.html';
  }
}
window.handleSignOut = handleSignOut;


/* ─── System Variables ─────────────────────────────────────────── */
// Runtime system variables available for bot conversations
const SystemVars = {
  // Get all system variables as an object
  getAll: function () {
    return {
      current_timestamp: Date.now(),
      page_url: window.location.href,
      browser_language: navigator.language || 'en',
      page_title: document.title,
      user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      user_platform: navigator.platform,
      user_origin: document.referrer || 'direct'
    };
  },

  // Replace {{variable}} placeholders in text
  replaceInText: function (text) {
    const vars = this.getAll();
    let result = text;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return result;
  }
};

window.SystemVars = SystemVars;

/* ─── Utils ──────────────────────────────────────────────────────── */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'none';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    el.style.transition = 'all 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('open');
}
window.openModal = openModal;

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
}
window.closeModal = closeModal;

function openPanel(id) {
  const overlay = document.getElementById(id);
  if (overlay) overlay.classList.add('open');
}

function closePanel(id) {
  const overlay = document.getElementById(id);
  if (overlay) overlay.classList.remove('open');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

// Lightweight markdown renderer for the dashboard conversation panel
// Handles bold, italic, headers, bullet lists, numbered lists, links, code, hr
function formatDashboardMarkdown(text) {
  if (!text) return '';
  let h = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Headers → bold
  h = h.replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>');
  // Bold
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/_(.+?)_/g, '<em>$1</em>');
  // Inline code
  h = h.replace(/`([^`]+)`/g, '<code style="background:var(--bg-elevated);padding:1px 5px;border-radius:4px;font-size:12px;">$1</code>');
  // Links
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;">$1</a>');
  // Horizontal rule
  h = h.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:8px 0;">');
  // Unordered lists
  h = h.replace(/^[ \t]*[-*] (.+)$/gm, '<li style="margin:2px 0;margin-left:16px;">$1</li>');
  // Numbered lists
  h = h.replace(/^[ \t]*\d+\. (.+)$/gm, '<li style="margin:2px 0;margin-left:16px;">$1</li>');
  // Wrap consecutive <li> in <ul>
  h = h.replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul style="margin:6px 0;padding:0;list-style:disc;">$&</ul>');
  // Newlines → <br>
  h = h.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
  return h;
}

function getColorForId(id) {
  const colors = ['#6c63ff', '#00e5a0', '#38bdf8', '#ff4d6a', '#ffb547', '#f472b6', '#a78bfa'];
  let hash = 0;
  for (let c of id) hash = ((hash << 5) - hash) + c.charCodeAt(0);
  return colors[Math.abs(hash) % colors.length];
}

function initials(name) {
  return name.split(/[\s@]/)[0].slice(0, 2).toUpperCase();
}

/* ─── Navigation ─────────────────────────────────────────────────── */
function navigate(page, extra = {}) {
  AppState.currentPage = page;

  if (page === 'home') {
    AppState.currentBot = null;
  } else if (extra.botId) {
    AppState.currentBot = AppState.bots.find(b => b.id === extra.botId) || null;
  }

  // Hide all pages
  $$('.page-content').forEach(p => p.classList.add('hidden'));

  // Show target page
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.remove('hidden');

  // Update nav items
  $$('.nav-item').forEach(n => {
    // If it's a bot feature, only show it if a bot is active
    if (n.dataset.botFeature === 'true') {
      n.style.display = AppState.currentBot ? 'flex' : 'none';
      n.classList.toggle('active', n.dataset.page === page);
    } else {
      // For global feature like 'home', show 'Dashboard' when a bot is active
      if (n.dataset.page === 'home') {
        const txt = document.getElementById('nav-home-text');
        if (txt) txt.textContent = AppState.currentBot ? 'Home' : 'Bots & Agents';
        n.classList.toggle('active', page === 'home');
      } else {
        n.classList.toggle('active', n.dataset.page === page);
      }
    }
  });

  // Toggle "BOT TOOLS" section label visibility
  const botToolsSection = document.getElementById('sidebar-section-bot-tools');
  if (botToolsSection) botToolsSection.style.display = AppState.currentBot ? 'block' : 'none';

  // Unsubscribe if leaving conversations
  if (AppState.currentPage === 'conversations' && page !== 'conversations') {
    unsubscribeAll();
  }

  // Update breadcrumb
  updateBreadcrumb(page, extra);
  document.title = (extra.botName || page.charAt(0).toUpperCase() + page.slice(1)) + " — IAM Platform";

  // Render page-specific content
  renderPage(page, extra);

  if (page === 'analytics') {
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (typeof window.initAnalyticsCharts === 'function') {
          window.initAnalyticsCharts();
        }
      }, 100);
    });
  }
}
window.navigate = navigate;

function updateBreadcrumb(page, extra) {
  const el = document.getElementById('breadcrumb');
  if (!el) return;
  const labels = {
    home: ['Home'],
    analytics: ['Analytics'],
    conversations: AppState.currentBot ? ['Home', AppState.currentBot.name, 'Conversations'] : ['Conversations'],
    knowledge: AppState.currentBot ? ['Home', AppState.currentBot.name, 'Knowledge Base'] : ['Knowledge Base'],
    leads: AppState.currentBot ? ['Home', AppState.currentBot.name, 'Leads'] : ['Leads'],
    integrations: AppState.currentBot ? ['Home', AppState.currentBot.name, 'Integrations'] : ['Integrations'],
    settings: ['Settings'],
    'bot-config': AppState.currentBot ? ['Home', AppState.currentBot.name] : (extra.botId ? ['Home', extra.botName || 'Bot Config'] : ['Bot Config']),
  };
  const parts = labels[page] || [page];
  el.innerHTML = parts.map((p, i) => {
    const isLast = i === parts.length - 1;
    let clickAttr = '';

    if (p === 'Home') {
      clickAttr = `onclick="navigate('home')" style="cursor:pointer;"`;
    } else if (i === 1 && AppState.currentBot && p === AppState.currentBot.name) {
      clickAttr = `onclick="navigate('bot-config', {botId:'${AppState.currentBot.id}', botName:'${AppState.currentBot.name}'})" style="cursor:pointer;"`;
    } else if (i === 1 && page === 'bot-config' && extra.botId) {
      clickAttr = `onclick="navigate('bot-config', {botId:'${extra.botId}', botName:'${extra.botName}'})" style="cursor:pointer;"`;
    }

    return isLast
      ? `<span class="breadcrumb-current">${p}</span>`
      : `<span ${clickAttr}>${p}</span><span class="breadcrumb-sep">›</span>`;
  }).join('');
}

function handleConversationsNav() {
  if (AppState.currentBot) {
    navigate('conversations');
  } else {
    navigate('home');
  }
}
window.handleConversationsNav = handleConversationsNav;

/* ─── Page Renderers ─────────────────────────────────────────────── */
function renderPage(page, extra) {
  switch (page) {
    case 'home': renderHome(); break;
    case 'analytics':
      const filterId = (extra && extra.botId) || (AppState.currentBot ? AppState.currentBot.id : 'all');
      renderAnalytics(filterId);
      break;
    case 'conversations': renderConversations(); break;
    case 'knowledge': renderKnowledge(); break;
    case 'leads': renderLeads(); break;
    case 'integrations': break;
    case 'settings':
      const user = AppState.currentUser;
      if (user && user.profile) {
        const nameInp = document.getElementById('settings-profile-name');
        const workInp = document.getElementById('settings-workspace-name');
        if (nameInp) nameInp.value = user.profile.full_name || '';
        if (workInp) workInp.value = user.profile.workspace_name || '';
      }
      break;
    case 'bot-config': renderBotConfig(extra); break;
  }
}

/* ── HOME ── */
function renderHome() {
  const grid = document.getElementById('bots-grid');
  if (!grid) return;

  const bots = AppState.bots || [];

  if (bots.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="empty-icon">🤖</div>
        <div class="empty-title">No bots yet</div>
        <div class="empty-text">Create your first AI chatbot to get started</div>
        <button class="btn btn-primary" onclick="openModal('modal-create-bot')" style="margin-top:8px;">
          + Create your first bot
        </button>
      </div>`;
  } else {
    grid.innerHTML = bots.map(bot => {
      // Support both Supabase field names (snake_case) and legacy camelCase
      const color = bot.color || '#6c63ff';
      const model = bot.model || 'gemini-2.5-flash';
      const status = bot.status || 'unpublished';
      const isLive = status === 'live';
      return `
        <div class="bot-card" onclick="navigate('bot-config', {botId:'${bot.id}', botName:'${bot.name}'})">
          <div class="bot-card-header">
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="bot-avatar" style="background:${color}22; font-size:16px; font-weight:800; color:${color}">${initials(bot.name)}</div>
              <div>
                <div class="bot-name">${bot.name}</div>
                <div class="bot-meta">Model: ${model}</div>
              </div>
            </div>
            <div class="bot-status ${isLive ? 'live' : 'draft'}">
              <div class="bot-status-dot" style="${!isLive ? 'background:#ccc; box-shadow:none;' : ''}"></div>
              ${isLive ? 'Live' : 'Draft'}
            </div>
          </div>
          <div class="bot-stats">
            <div class="bot-stat-item">
              <div class="bot-stat-num">—</div>
              <div class="bot-stat-lbl">Messages</div>
            </div>
            <div class="bot-stat-item">
              <div class="bot-stat-num">—</div>
              <div class="bot-stat-lbl">Sessions</div>
            </div>
            <div class="bot-stat-item">
              <div class="bot-stat-num">—</div>
              <div class="bot-stat-lbl">Users</div>
            </div>
            <div class="bot-stat-item">
              <div class="bot-stat-num" style="color:var(--accent-2)">0</div>
              <div class="bot-stat-lbl">Errors</div>
            </div>
          </div>
          <div class="bot-actions" onclick="event.stopPropagation()">
            <button class="btn btn-secondary btn-sm" onclick="navigate('bot-config', {botId:'${bot.id}', botName:'${bot.name}'})">⚙️ Config</button>
            <button class="btn btn-secondary btn-sm" onclick="navigate('conversations', {botId:'${bot.id}', botName:'${bot.name}'})">💬 Chats</button>
            <button class="btn btn-primary btn-sm" onclick="openEmbedForBot('${bot.id}')">⟨/⟩ Embed</button>
            <button class="btn btn-danger btn-sm" onclick="confirmDeleteBot('${bot.id}', '${bot.name}')">🗑</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Usage widget — no hardcoded limits
  const usedEl = document.getElementById('bots-used');
  const barEl = document.getElementById('bots-bar');
  if (usedEl) usedEl.textContent = `${bots.length} bot${bots.length !== 1 ? 's' : ''}`;
  if (barEl) barEl.style.width = `${Math.min(bots.length * 10, 100)}%`;
}

/* ── ANALYTICS ── */
async function renderAnalytics(filterBotId = 'all') {
  // Dynamic bot tabs
  const tabContainer = document.getElementById('analytics-bot-tabs');
  if (tabContainer) {
    const bots = Store.get('bots') || [];
    tabContainer.innerHTML = [
      `<div class="tab-btn ${filterBotId === 'all' ? 'active' : ''}" onclick="renderAnalytics('all')">All Bots</div>`,
      ...bots.map(b => `<div class="tab-btn ${filterBotId === b.id ? 'active' : ''}" onclick="renderAnalytics('${b.id}')">${b.name}</div>`)
    ].join('');
  }

  const cacheKey = `analytics_summary_${filterBotId}`;
  const cached = Cache.get(cacheKey);

  let summary;
  if (cached) {
    summary = cached;
  } else {
    try {
      summary = await Analytics.getSummary(filterBotId === 'all' ? null : filterBotId);
      Cache.set(cacheKey, summary);
    } catch (e) {
      console.error(e);
      summary = { totalBots: 0, totalConversations: 0, totalMessages: 0, totalLeads: 0 };
    }
  }

  const msgStat = document.getElementById('stat-messages');
  const convStat = document.getElementById('stat-sessions');
  const leadStat = document.getElementById('stat-users');
  const botStat = document.getElementById('stat-errors');
  if (msgStat) msgStat.textContent = formatNum(summary.totalMessages || 0);
  if (convStat) convStat.textContent = formatNum(summary.totalConversations || 0);
  if (leadStat) leadStat.textContent = formatNum(summary.totalLeads || 0);
  if (botStat) botStat.textContent = summary.totalBots || 0;

  // Render dynamic bot legend
  const legendEl = document.getElementById('chart-bot-legend');
  if (legendEl) {
    const bots = Store.get('bots') || [];
    const colors = ['#6c63ff', '#00e5a0', '#38bdf8', '#ff4d6a', '#ffb547'];
    legendEl.innerHTML = bots.map((b, i) => `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:10px;height:10px;border-radius:50%;background:${b.color || colors[i % colors.length]};display:inline-block;flex-shrink:0;"></span>
        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;">${b.name}</span>
      </div>
    `).join('');
  }

  renderMiniCharts(summary);
}

function renderMiniCharts(summary) {
  // Draw simple SVG spark charts for analytics
  // If we have no data, don't show a mock sparkline
  const hasData = summary && (summary.totalMessages > 0 || summary.totalConversations > 0);
  const chartData = hasData ? [12, 28, 15, 42, 38, 60, 75, 58, 82, 95, 78, 110, 88, 120] : [];

  const charts = $$('.spark-chart');
  charts.forEach(canvas => {
    const color = canvas.dataset.color || '#6c63ff';
    const w = canvas.clientWidth || 320;
    const h = 60;

    if (chartData.length === 0) {
      canvas.innerHTML = '';
      return;
    }

    const max = Math.max(...chartData);
    const pts = chartData.map((v, i) => {
      const x = (i / (chartData.length - 1)) * w;
      const y = h - (v / max) * h * 0.85 - 4;
      return `${x},${y}`;
    }).join(' ');
    const fillPts = `0,${h} ${pts} ${w},${h}`;
    canvas.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:100%;">
        <defs>
          <linearGradient id="grad${color.replace('#', '')}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <polygon points="${fillPts}" fill="url(#grad${color.replace('#', '')})" />
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  });
}

/* ── CONVERSATIONS ── */
async function renderConversations() {
  const list = document.getElementById('conv-list-items');
  const topbarName = document.getElementById('conv-bot-name');
  if (!list || !AppState.currentBot) return;

  if (topbarName) topbarName.textContent = AppState.currentBot.name;

  // Always fetch fresh from DB — no caching to avoid stale/duplicate data
  try {
    const dbConvs = await Conversations.getAll(AppState.currentBot.id);

    // Deduplicate by id just in case
    const seen = new Set();
    const mappedConvs = dbConvs
      .filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
      .map(c => ({
        id: c.id,
        botId: c.bot_id,
        user: c.user_id && !c.user_id.startsWith('vis_') && !c.user_id.startsWith('anonymous_')
          ? c.user_id
          : 'Anonymous Visitor',
        time: new Date(c.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        date: new Date(c.updated_at).toLocaleDateString(),
        status: (Date.now() - new Date(c.updated_at).getTime() < 3600000) ? 'active' : 'closed',
        hitl_active: c.hitl_active || false,
        msgs: c.messages?.[0]?.count || 0,
        messages: []
      }));

    // Restore HITL state from DB after page refresh
    const activeHITL = mappedConvs.find(c => c.hitl_active);
    if (activeHITL && AppState.activeConversation === activeHITL.id) {
      AppState.hitlActive = true;
    }

    AppState.conversations = mappedConvs;

  } catch (e) {
    console.error('Failed to load conversations:', e);
  }

  const botConvs = AppState.conversations;

  if (botConvs.length === 0) {
    list.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;font-size:13px;">No conversations yet.</div>';
    return;
  }

  list.innerHTML = botConvs.map(c => {
    const color = getColorForId(c.id);
    const isActive = c.id === AppState.activeConversation;
    return `
      <div class="conv-item ${isActive ? 'active' : ''}"
           onclick="selectConversation('${c.id}')">
        <div class="conv-avatar" style="background:${color}33; color:${color}">${initials(c.user || 'AN')}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div class="conv-name">${c.user}</div>
            <div class="conv-time">${c.time}</div>
          </div>
          <div class="conv-preview" id="conv-preview-${c.id}">${c.msgs > 0 ? c.msgs + ' message' + (c.msgs !== 1 ? 's' : '') : 'No messages yet'}</div>
        </div>
        ${c.status === 'active' ? '<div class="conv-unread"></div>' : ''}
      </div>
    `;
  }).join('');
}

// Separate click handler — does NOT re-render full list (prevents disappearing)
async function selectConversation(convId) {
  // Update active state visually without full re-render
  $$('.conv-item').forEach(el => el.classList.remove('active'));
  const clicked = document.querySelector(`[onclick="selectConversation('${convId}')"]`);
  if (clicked) clicked.classList.add('active');

  AppState.activeConversation = convId;
  await loadConversationMessages(convId);
}
window.selectConversation = selectConversation;

function renderConvDetail(id) {
  const conv = AppState.conversations.find(c => c.id === id);
  if (!conv) return;

  const nameEl = document.getElementById('conv-detail-name');
  const statusEl = document.getElementById('conv-detail-status');
  const msgsEl = document.getElementById('conv-messages');
  const hitlEl = document.getElementById('hitl-banner');
  const inputBar = document.getElementById('chat-input-area');

  const botObj = AppState.bots.find(b => b.id === conv.botId);
  const botName = botObj ? botObj.name : 'Unknown Bot';

  if (nameEl) nameEl.textContent = conv.user;
  if (statusEl) statusEl.innerHTML = `<span class="badge ${conv.status === 'active' ? 'badge-green' : 'badge-gray'}">${conv.status}</span> · ${botName}`;

  if (msgsEl) {
    msgsEl.innerHTML = conv.messages.map(m => {
      // System notification messages — small centered pills
      if (m.role === 'system') {
        const isJoined = m.text === 'agent_joined';
        const label = isJoined
          ? '👤 A live agent has joined the conversation'
          : '🤖 AI assistant has resumed';
        return `<div style="display:flex;align-items:center;justify-content:center;margin:10px 0;">
          <span style="font-size:11px;color:var(--text-muted);background:var(--bg-elevated);border:1px solid var(--border);border-radius:20px;padding:4px 14px;white-space:nowrap;">${label}</span>
        </div>`;
      }
      // Escape and optionally format message content
      const isAgent = m.role === 'human-agent';
      const isBot   = m.role === 'bot';
      const isUser  = m.role === 'user';
      // Escape HTML for user messages; render light markdown for bot/agent
      const safeText = isUser
        ? String(m.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        : formatDashboardMarkdown(m.text || '');
      return `
      <div class="message ${isAgent ? 'bot' : m.role}">
        <div class="msg-avatar" style="background:${isBot ? 'var(--accent-dim)' : isAgent ? '#10b98133' : '#333'}">
          ${isBot ? '🤖' : isAgent ? '👤' : ''}
        </div>
        <div>
          ${isAgent ? '<div style="font-size:10px;color:#10b981;margin-bottom:2px;">Support Agent</div>' : ''}
          <div class="msg-bubble" style="${isAgent ? 'border-left:3px solid #10b981;' : ''}">${safeText}</div>
          <div class="msg-time">${m.time}</div>
        </div>
      </div>`;
    }).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  if (hitlEl) {
    if (AppState.hitlActive) {
      hitlEl.style.display = 'flex';
      hitlEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <span>🟢</span>
          <span>You are now handling this conversation</span>
        </div>
        <button class="btn btn-sm btn-secondary" onclick="endHITL()">Resume AI</button>
      `;
    } else {
      hitlEl.style.display = 'none';
    }
  }

  if (inputBar) inputBar.style.display = AppState.hitlActive ? 'flex' : 'none';

  const takeoverBtn = document.getElementById('btn-takeover');
  if (takeoverBtn) {
    // Show only if we have a conversation and HITL is not yet active for us
    takeoverBtn.style.display = (id && !AppState.hitlActive) ? 'inline-flex' : 'none';
  }
}

/* ── LOAD CONVERSATION MESSAGES FROM DB ── */
async function loadConversationMessages(convId) {
  const msgsEl = document.getElementById('conv-messages');
  if (!msgsEl) return;

  // Show the detail panel immediately with loading state
  const conv = AppState.conversations.find(c => c.id === convId);
  if (conv) {
    const nameEl = document.getElementById('conv-detail-name');
    const statusEl = document.getElementById('conv-detail-status');
    const botObj = AppState.bots.find(b => b.id === conv.botId);
    const botName = botObj ? botObj.name : 'Unknown Bot';
    if (nameEl) nameEl.textContent = conv.user;
    if (statusEl) statusEl.innerHTML = `<span class="badge ${conv.status === 'active' ? 'badge-green' : 'badge-gray'}">${conv.status}</span> · ${botName}`;
    const takeoverBtn = document.getElementById('btn-takeover');
    if (takeoverBtn) takeoverBtn.style.display = (convId && !AppState.hitlActive) ? 'inline-flex' : 'none';
    const inputBar = document.getElementById('chat-input-area');
    if (inputBar) inputBar.style.display = AppState.hitlActive ? 'flex' : 'none';
  }

  msgsEl.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">Loading messages...</div>';

  try {
    const { data: messages, error } = await supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    if (!messages || messages.length === 0) {
      msgsEl.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;font-size:13px;">No messages in this conversation yet.</div>';
      return;
    }

    // Update conversation object with fetched messages
    if (conv) {
      conv.messages = messages.map(m => ({
        role: m.role,
        text: m.content,
        time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }));

      // Update preview snippet in sidebar
      const lastMsg = conv.messages[conv.messages.length - 1];
      const previewEl = document.getElementById(`conv-preview-${convId}`);
      if (previewEl && lastMsg) {
        previewEl.textContent = lastMsg.text.slice(0, 60) + (lastMsg.text.length > 60 ? '…' : '');
      }
    }

    // Render all messages using renderConvDetail which handles all roles including system
    renderConvDetail(convId);

  } catch (e) {
    console.error('Failed to load messages:', e);
    msgsEl.innerHTML = '<div style="padding:20px;color:var(--danger);font-size:13px;">Failed to load messages.</div>';
  }
}
window.loadConversationMessages = loadConversationMessages;

/* ── REALTIME SUBSCRIPTIONS ── */
let activeSubscription = null;

function subscribeToConversation(conversationId) {
  // Unsubscribe from previous
  if (activeSubscription) {
    activeSubscription.unsubscribe();
    activeSubscription = null;
  }
  // Only subscribe during HITL
  if (AppState.hitlActive) {
    activeSubscription = Conversations.subscribeToMessages(
      conversationId,
      (newMessage) => {
        const conv = AppState.conversations.find(c => c.id === conversationId);
        if (conv) {
          conv.messages.push({
            role: newMessage.role,
            text: newMessage.content,
            time: new Date(newMessage.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });

          // Invalidate cache so it persists locally
          Cache.set(`messages_${conversationId}`, conv.messages);

          if (AppState.activeConversation === conversationId) {
            renderConvDetail(conversationId);
          }
        }
      }
    );
  }
}

function unsubscribeAll() {
  if (activeSubscription) {
    activeSubscription.unsubscribe();
    activeSubscription = null;
  }
}

async function interceptConversation() {
  const convId = AppState.activeConversation;
  if (!convId) return;

  AppState.hitlActive = true;

  try {
    // Mark conversation as HITL active in DB
    await supabase.from('conversations')
      .update({ hitl_active: true, updated_at: new Date().toISOString() })
      .eq('id', convId);

    // Insert system notification message
    await supabase.from('messages').insert({
      conversation_id: convId,
      role: 'system',
      content: 'agent_joined'
    });

    // Add to local state for immediate display
    const conv = AppState.conversations.find(c => c.id === convId);
    if (conv) {
      conv.messages.push({
        role: 'system',
        text: 'agent_joined',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }
  } catch (e) {
    console.error('HITL takeover failed:', e);
  }

  // Subscribe to real-time messages for dashboard
  subscribeToConversation(convId);
  // Start real-time for widget so it receives agent messages
  startWidgetRealtimeSubscription(null, convId);
  // Append system message directly without full re-render
  const msgsEl = document.getElementById('conv-messages');
  if (msgsEl) {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;justify-content:center;margin:10px 0;';
    div.innerHTML = '<span style="font-size:11px;color:var(--text-muted);background:var(--bg-elevated);border:1px solid var(--border);border-radius:20px;padding:4px 14px;">👤 A live agent has joined the conversation</span>';
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  // Show HITL banner and input bar
  const hitlEl = document.getElementById('hitl-banner');
  if (hitlEl) {
    hitlEl.style.display = 'flex';
    hitlEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span>🟢</span>
        <span>You are now handling this conversation</span>
      </div>
      <button class="btn btn-sm btn-secondary" onclick="endHITL()">Resume AI</button>`;
  }
  const inputBar = document.getElementById('chat-input-area');
  if (inputBar) inputBar.style.display = 'flex';
  const takeoverBtn = document.getElementById('btn-takeover');
  if (takeoverBtn) takeoverBtn.style.display = 'none';
  showToast('You have taken control of this conversation', 'success');
}
window.interceptConversation = interceptConversation;

async function endHITL() {
  const convId = AppState.activeConversation;
  if (!convId) return;

  AppState.hitlActive = false;
  unsubscribeAll();

  try {
    await supabase.from('conversations')
      .update({ hitl_active: false, updated_at: new Date().toISOString() })
      .eq('id', convId);

    await supabase.from('messages').insert({
      conversation_id: convId,
      role: 'system',
      content: 'agent_left'
    });

    const conv = AppState.conversations.find(c => c.id === convId);
    if (conv) {
      conv.messages.push({
        role: 'system',
        text: 'agent_left',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }
  } catch (e) {
    console.error('HITL resume failed:', e);
  }

  // Append system message directly without full re-render
  const msgsEl = document.getElementById('conv-messages');
  if (msgsEl) {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;justify-content:center;margin:10px 0;';
    div.innerHTML = '<span style="font-size:11px;color:var(--text-muted);background:var(--bg-elevated);border:1px solid var(--border);border-radius:20px;padding:4px 14px;">🤖 AI assistant has resumed</span>';
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  // Update HITL banner and input bar
  const hitlEl = document.getElementById('hitl-banner');
  if (hitlEl) hitlEl.style.display = 'none';
  const inputBar = document.getElementById('chat-input-area');
  if (inputBar) inputBar.style.display = 'none';
  const takeoverBtn = document.getElementById('btn-takeover');
  if (takeoverBtn) takeoverBtn.style.display = 'inline-flex';
  showToast('AI has resumed the conversation', 'info');
}
window.endHITL = endHITL;

async function sendAgentMessage() {
  const input = document.getElementById('agent-input');
  if (!input || !input.value.trim()) return;
  const convId = AppState.activeConversation;
  if (!convId) return;

  const text = input.value.trim();
  input.value = '';

  const conv = AppState.conversations.find(c => c.id === convId);
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Optimistic UI — append directly to DOM without full re-render
  const msgsEl = document.getElementById('conv-messages');
  if (msgsEl) {
    const div = document.createElement('div');
    div.className = 'message bot';
    div.innerHTML = `
      <div class="msg-avatar" style="background:#10b98133;">👤</div>
      <div>
        <div style="font-size:10px;color:#10b981;margin-bottom:2px;">Support Agent</div>
        <div class="msg-bubble" style="border-left:3px solid #10b981;">\${text}</div>
        <div class="msg-time">\${time}</div>
      </div>`;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  // Also update local state
  if (conv) conv.messages.push({ role: 'human-agent', text, time });

  try {
    // Save agent message to DB — user will see it via real-time subscription
    await supabase.from('messages').insert({
      conversation_id: convId,
      role: 'human-agent',
      content: text
    });
    // Update conversation timestamp
    await supabase.from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convId);
  } catch (e) {
    console.error('Failed to send agent message:', e);
    showToast('Failed to send message', 'error');
  }
}
window.sendAgentMessage = sendAgentMessage;

/* ── KNOWLEDGE BASE ── */
async function renderKnowledge() {
  const grid = document.getElementById('kb-grid');
  if (!grid) return;

  // Check both key forms — Store uses 'knowledge_bases', localStorage uses 'knowledgeBases'
  let kbs = Store.get('knowledge_bases') || AppState.knowledgeBases || [];

  // If still empty, fetch immediately — don't wait for background sync
  if (kbs.length === 0) {
    try {
      kbs = await KnowledgeBases.getAll();
      Store.set('knowledge_bases', kbs);
    } catch (e) {
      console.error('KB fetch failed:', e);
    }
  }

  // Update summary stats — counts only, no limits
  const totalCountEl = document.getElementById('kb-total-count');
  const totalFilesEl = document.getElementById('kb-total-files');
  const fileCountEl = document.getElementById('kb-file-count');
  const totalFiles = kbs.reduce((s, kb) => s + (kb.kb_files?.[0]?.count ?? 0), 0);
  if (totalCountEl) totalCountEl.textContent = kbs.length;
  if (fileCountEl) fileCountEl.textContent = totalFiles;
  if (totalFilesEl) totalFilesEl.textContent = `${totalFiles} file${totalFiles !== 1 ? 's' : ''} across ${kbs.length} knowledge base${kbs.length !== 1 ? 's' : ''}`;

  if (kbs.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="empty-icon">📚</div>
        <div class="empty-title">No knowledge bases yet</div>
        <div class="empty-text">Create a knowledge base to give your bot information to work with</div>
        <button class="btn btn-primary" onclick="openModal('modal-create-kb')" style="margin-top:8px;">+ New Knowledge Base</button>
      </div>`;
    return;
  }

  grid.innerHTML = kbs.map(kb => {
    const fileCount = kb.kb_files?.[0]?.count ?? 0;
    const date = new Date(kb.updated_at || kb.created_at || Date.now()).toLocaleDateString();
    return `
      <div class="card" style="cursor:pointer;" onclick="openKBDetail('${kb.id}')">
        <div class="card-body" style="padding:20px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;">
            <div style="font-size:28px;">📚</div>
            <div class="badge badge-purple">${fileCount} file${fileCount !== 1 ? 's' : ''}</div>
          </div>
          <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:4px;">${kb.name}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;">Updated ${date}</div>
          <div style="display:flex;gap:6px;" onclick="event.stopPropagation()">
            <button class="btn btn-secondary btn-sm" style="flex:1;" onclick="openKBDetail('${kb.id}')">📂 Open</button>
            <button class="btn btn-ghost btn-sm btn-icon" onclick="renameKB('${kb.id}','${kb.name.replace(/'/g, "\\'")}')">✏️</button>
            <button class="btn btn-ghost btn-sm btn-icon" onclick="confirmDeleteKB('${kb.id}')">🗑</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function openKBDetail(id) {
  const kbs = Store.get('knowledge_bases') || [];
  const kb = kbs.find(k => k.id === id);
  if (!kb) return;

  AppState.currentKBId = id;
  AppState.currentPage = 'kb-detail';

  const nameEl = document.getElementById('kb-detail-name');
  const subEl = document.getElementById('kb-detail-subtitle');
  if (nameEl) nameEl.textContent = kb.name;
  if (subEl) subEl.textContent = kb.description || 'Manage files and content';

  $$('.page-content').forEach(p => p.classList.add('hidden'));
  const page = document.getElementById('page-kb-detail');
  if (page) page.classList.remove('hidden');

  const breadcrumb = document.getElementById('breadcrumb');
  if (breadcrumb) {
    breadcrumb.innerHTML = `<span onclick="navigate('knowledge')" style="cursor:pointer;">Knowledge Bases</span><span class="breadcrumb-sep">›</span><span class="breadcrumb-current">${kb.name}</span>`;
  }
  document.title = kb.name + ' — IAM Platform';

  switchKBDetailTab('files');
  await loadKBDetailFiles();
}
window.openKBDetail = openKBDetail;

async function loadKBDetailFiles() {
  const id = AppState.currentKBId;
  if (!id) return;
  const listEl = document.getElementById('kb-detail-files-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">Loading files...</div>';
  try {
    const files = await KnowledgeBases.getFiles(id);
    if (!files || files.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:28px 0;">No files yet. Upload one above.</div>';
      return;
    }
    const icons = { pdf: '📄', docx: '📝', doc: '📝', txt: '📃', csv: '📊', xlsx: '📊', url: '🔗', text: '📋' };
    const statusBadge = {
      processed:  '<span style="font-size:10px;background:#00e5a022;color:#00e5a0;border:1px solid #00e5a044;border-radius:20px;padding:1px 8px;">✓ Ready</span>',
      processing: '<span style="font-size:10px;background:#ffb54722;color:#ffb547;border:1px solid #ffb54744;border-radius:20px;padding:1px 8px;">⏳ Processing</span>',
      failed:     '<span style="font-size:10px;background:#ff4d6a22;color:#ff4d6a;border:1px solid #ff4d6a44;border-radius:20px;padding:1px 8px;">✕ Failed</span>',
      empty:      '<span style="font-size:10px;background:#88888822;color:#888;border:1px solid #88888844;border-radius:20px;padding:1px 8px;">Empty</span>',
    };
    listEl.innerHTML = files.map(f => {
      const sizeKB = f.size_bytes ? Math.round(f.size_bytes / 1024) : 0;
      const sizeStr = sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : sizeKB > 0 ? `${sizeKB} KB` : '';
      const date = f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
      const icon = icons[f.type] || '📄';
      const badge = statusBadge[f.status] || '<span style="font-size:10px;background:#6c63ff22;color:#6c63ff;border:1px solid #6c63ff44;border-radius:20px;padding:1px 8px;">Saved</span>';
      const chunks = f.chunk_count ? `· ${f.chunk_count} chunks` : '';
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:22px;">${icon}</span>
            <div>
              <div style="font-weight:600;font-size:13px;">${escapeHtml(f.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:6px;margin-top:3px;">
                ${badge}
                <span>${[sizeStr, chunks, date].filter(Boolean).join(' · ')}</span>
              </div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="deleteKBFile('${f.id}','${id}')" style="color:var(--danger);">🗑</button>
        </div>`;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div style="color:var(--danger);font-size:13px;padding:8px 0;">Failed to load files.</div>';
  }
}
window.loadKBDetailFiles = loadKBDetailFiles;

function switchKBDetailTab(tab) {
  ['files', 'text', 'sitemap'].forEach(t => {
    const btn = document.getElementById(`kd-tab-${t}`);
    const panel = document.getElementById(`kb-detail-tab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
  });
}
window.switchKBDetailTab = switchKBDetailTab;

/* ─── KB Processing Pipeline ─────────────────────────────────────── */
// Called after any KB file is saved to DB — triggers backend to chunk & embed it
async function triggerKBProcessing(fileId, type = 'file') {
  try {
    const endpoint = type === 'url' ? '/api/kb/crawl' : '/api/kb/process';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kb_file_id: fileId })
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[KB] Processing failed for ${fileId}:`, err);
      showToast('File saved but processing failed — try re-uploading', 'error');
    } else {
      const data = await res.json();
      console.log('[KB] Processing complete:', data);
    }
  } catch (e) {
    console.warn('[KB] Processing request error:', e.message);
  }
}

async function uploadKBDetailFiles(input) {
  const files = [...input.files];
  if (!files.length) return;
  const kbId = AppState.currentKBId;
  if (!kbId) return;
  showToast(`Uploading ${files.length} file(s)…`, 'info');
  try {
    for (const file of files) {
      const saved = await KnowledgeBases.uploadFile(kbId, file);
      // Fire-and-forget processing — chunks & embeds the file for RAG
      if (saved?.id) triggerKBProcessing(saved.id, 'file');
    }
    showToast(`${files.length} file(s) uploaded — processing for AI…`, 'success');
    LocalDB.clear('knowledge_bases');
    await loadKBDetailFiles();
    const freshKBs = await KnowledgeBases.getAll();
    Store.set('knowledge_bases', freshKBs);
  } catch (e) {
    console.error(e);
    showToast('Upload failed', 'error');
  }
  input.value = '';
}
window.uploadKBDetailFiles = uploadKBDetailFiles;

async function saveKBRichText() {
  const title = document.getElementById('kb-text-title')?.value?.trim();
  const content = document.getElementById('kb-text-content')?.value?.trim();
  const kbId = AppState.currentKBId;
  if (!title || !content) { showToast('Please enter a title and content', 'error'); return; }
  if (!kbId) return;
  try {
    const saved = await KnowledgeBases.addFile(kbId, { name: title, type: 'text', size_bytes: new Blob([content]).size, content });
    if (saved?.id) triggerKBProcessing(saved.id, 'file');
    showToast('Content added — processing for AI…', 'success');
    document.getElementById('kb-text-title').value = '';
    document.getElementById('kb-text-content').value = '';
    LocalDB.clear('knowledge_bases');
    await loadKBDetailFiles();
    const freshKBs = await KnowledgeBases.getAll();
    Store.set('knowledge_bases', freshKBs);
  } catch (e) { showToast('Failed to save content', 'error'); }
}
window.saveKBRichText = saveKBRichText;

async function startKBCrawl() {
  const url = document.getElementById('kb-sitemap-url')?.value?.trim();
  if (!url) { showToast('Please enter a URL', 'error'); return; }
  const kbId = AppState.currentKBId;
  if (!kbId) return;
  try {
    const saved = await KnowledgeBases.addFile(kbId, { name: url, type: 'url', url, size_bytes: 0 });
    if (saved?.id) triggerKBProcessing(saved.id, 'url');
    showToast('Crawl started — this may take a minute…', 'info');
    document.getElementById('kb-sitemap-url').value = '';
    LocalDB.clear('knowledge_bases');
    await loadKBDetailFiles();
    const freshKBs = await KnowledgeBases.getAll();
    Store.set('knowledge_bases', freshKBs);
  } catch (e) { showToast('Failed to add URL', 'error'); }
}
window.startKBCrawl = startKBCrawl;

// KB side-panel file upload (used from panel-kb, not the KB detail page)
async function uploadKBPanelFiles(input) {
  const files = [...input.files];
  if (!files.length) return;
  const kbId = AppState.currentKBId;
  if (!kbId) { showToast('No knowledge base selected', 'error'); return; }
  showToast(`Uploading ${files.length} file(s)…`, 'info');
  try {
    for (const file of files) {
      const saved = await KnowledgeBases.uploadFile(kbId, file);
      if (saved?.id) triggerKBProcessing(saved.id, 'file');
    }
    showToast(`${files.length} file(s) uploaded — processing for AI…`, 'success');
    LocalDB.clear('knowledge_bases');
    // Refresh panel file list
    const panelFilesEl = document.getElementById('kb-panel-files');
    if (panelFilesEl) {
      const freshFiles = await KnowledgeBases.getFiles(kbId);
      const icons = { pdf:'📄', docx:'📝', doc:'📝', txt:'📃', csv:'📊', xlsx:'📊', url:'🔗', text:'📋' };
      panelFilesEl.innerHTML = freshFiles.length === 0
        ? '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;">No files yet.</div>'
        : freshFiles.map(f => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="font-size:18px;">${icons[f.type] || '📄'}</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${f.name}</div>
              <div style="font-size:11px;color:var(--text-muted);">${f.status || 'saved'}</div>
            </div>
          </div>`).join('');
    }
    const freshKBs = await KnowledgeBases.getAll();
    Store.set('knowledge_bases', freshKBs);
  } catch (e) {
    console.error(e);
    showToast('Upload failed', 'error');
  }
  input.value = '';
}
window.uploadKBPanelFiles = uploadKBPanelFiles;

function renameCurrentKB() { renameKB(AppState.currentKBId); }
window.renameCurrentKB = renameCurrentKB;

function renameKB(id, currentName) {
  AppState.currentKBId = id;
  if (!currentName) {
    const kbs = Store.get('knowledge_bases') || [];
    const kb = kbs.find(k => k.id === id);
    currentName = kb?.name || '';
  }
  const input = document.getElementById('rename-kb-input');
  if (input) input.value = currentName;
  openModal('modal-rename-kb');
}
window.renameKB = renameKB;

async function confirmRenameKB() {
  const newName = document.getElementById('rename-kb-input')?.value?.trim();
  const kbId = AppState.currentKBId;
  if (!newName || !kbId) { showToast('Please enter a name', 'error'); return; }
  try {
    await supabase.from('knowledge_bases').update({ name: newName }).eq('id', kbId);
    const kbs = Store.get('knowledge_bases') || [];
    const idx = kbs.findIndex(k => k.id === kbId);
    if (idx > -1) { kbs[idx] = { ...kbs[idx], name: newName }; Store.set('knowledge_bases', [...kbs]); }
    LocalDB.clear('knowledge_bases');
    closeModal('modal-rename-kb');
    showToast('Renamed!', 'success');
    const nameEl = document.getElementById('kb-detail-name');
    if (nameEl) nameEl.textContent = newName;
  } catch (e) { showToast('Failed to rename', 'error'); }
}
window.confirmRenameKB = confirmRenameKB;

function deleteCurrentKB() { confirmDeleteKB(AppState.currentKBId); }
window.deleteCurrentKB = deleteCurrentKB;

async function confirmDeleteKB(id) {
  if (!id) return;
  if (confirm('Delete this knowledge base and all its files? This cannot be undone.')) {
    await deleteKnowledgeBase(id);
  }
}

async function deleteKnowledgeBase(id) {
  try {
    Store.removeItem('knowledge_bases', id);
    LocalDB.clear('knowledge_bases');
    await KnowledgeBases.delete(id);
    showToast('Knowledge base deleted', 'success');
    if (AppState.currentKBId === id) {
      AppState.currentKBId = null;
      navigate('knowledge');
    }
  } catch (e) {
    console.error(e);
    showToast('Failed to delete', 'error');
  }
}

async function deleteKBFile(fileId, kbId) {
  if (!confirm('Delete this file?')) return;
  try {
    // Get storage path first
    const { data: file } = await supabase
      .from('kb_files')
      .select('storage_path')
      .eq('id', fileId)
      .single();

    // Delete from Supabase Storage if file has a storage path
    if (file?.storage_path) {
      const { error: storageErr } = await supabase.storage
        .from('knowledge-files')
        .remove([file.storage_path]);
      if (storageErr) console.warn('Storage delete error:', storageErr.message);
    }

    // Delete DB record — cascade handles kb_chunks for this file
    await supabase.from('kb_files').delete().eq('id', fileId);
    showToast('File deleted', 'info');
    LocalDB.clear('knowledge_bases');
    await loadKBDetailFiles();
    const freshKBs = await KnowledgeBases.getAll();
    Store.set('knowledge_bases', freshKBs);
  } catch (e) {
    console.error(e);
    showToast('Failed to delete file', 'error');
  }
}
window.deleteKBFile = deleteKBFile;

function renderAttachedKBs(bot) {
  const container = document.getElementById('bot-attached-kbs');
  if (!container) return;
  const allKBs = Store.get('knowledge_bases') || [];
  const botKBIds = bot.knowledge_base_ids || [];
  const attached = allKBs.filter(kb => botKBIds.includes(kb.id));
  if (attached.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No knowledge bases attached yet.</div>';
    return;
  }
  container.innerHTML = attached.map(kb => `
    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">
      <div style="display:flex;align-items:center;gap:10px;"><span>📚</span><span style="font-weight:500;">${kb.name}</span></div>
      <button class="btn btn-ghost btn-sm btn-icon" onclick="detachKB('${kb.id}')">✕</button>
    </div>
  `).join('');
}
window.renderAttachedKBs = renderAttachedKBs;

function openAttachKBModal() {
  const bot = AppState.currentBot;
  const allKBs = Store.get('knowledge_bases') || [];
  const attached = bot?.knowledge_base_ids || [];
  const listEl = document.getElementById('attach-kb-list');
  if (!listEl) return;
  if (allKBs.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No knowledge bases yet. Create one first.</div>';
  } else {
    listEl.innerHTML = allKBs.map(kb => {
      const isAttached = attached.includes(kb.id);
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">
          <div style="display:flex;align-items:center;gap:10px;"><span>📚</span><span style="font-weight:500;">${kb.name}</span></div>
          ${isAttached
          ? `<button class="btn btn-danger btn-sm" onclick="detachKB('${kb.id}')">Detach</button>`
          : `<button class="btn btn-primary btn-sm" onclick="attachKB('${kb.id}')">Attach</button>`}
        </div>`;
    }).join('');
  }
  openModal('modal-attach-kb');
}
window.openAttachKBModal = openAttachKBModal;

async function attachKB(kbId) {
  const bot = AppState.currentBot;
  if (!bot) return;
  try {
    await supabase.from('bot_knowledge_bases').insert({ bot_id: bot.id, kb_id: kbId });
    if (!bot.knowledge_base_ids) bot.knowledge_base_ids = [];
    bot.knowledge_base_ids.push(kbId);
    renderAttachedKBs(bot);
    openAttachKBModal();
    showToast('Knowledge base attached', 'success');
  } catch (e) { showToast('Failed to attach', 'error'); }
}
window.attachKB = attachKB;

async function detachKB(kbId) {
  const bot = AppState.currentBot;
  if (!bot) return;
  try {
    await supabase.from('bot_knowledge_bases').delete().eq('bot_id', bot.id).eq('kb_id', kbId);
    bot.knowledge_base_ids = (bot.knowledge_base_ids || []).filter(id => id !== kbId);
    renderAttachedKBs(bot);
    openAttachKBModal();
    showToast('Knowledge base detached', 'info');
  } catch (e) { showToast('Failed to detach', 'error'); }
}
window.detachKB = detachKB;

async function addKnowledgeBase() {
  const name = document.getElementById('new-kb-name')?.value?.trim();
  const desc = document.getElementById('new-kb-description')?.value?.trim() || '';
  if (!name) { showToast('Please enter a name', 'error'); return; }
  try {
    const newKB = await KnowledgeBases.create(name, desc);
    Store.addItem('knowledge_bases', newKB);
    LocalDB.clear('knowledge_bases');
    closeModal('modal-create-kb');
    const nameEl = document.getElementById('new-kb-name');
    const descEl = document.getElementById('new-kb-description');
    if (nameEl) nameEl.value = '';
    if (descEl) descEl.value = '';
    showToast(`"${name}" created!`, 'success');
    // Go straight to detail page to add content
    await openKBDetail(newKB.id);
  } catch (e) {
    console.error(e);
    showToast('Failed to create knowledge base', 'error');
  }
}

/* ── PREVIEW FEATURES ── */
let currentPreviewMode = 'widget';
let isPreviewExpanded = false;

function togglePreviewExpand() {
  const container = document.getElementById('preview-container-wrapper');
  const btn = document.getElementById('expand-preview-btn');
  if (!container || !btn) return;

  isPreviewExpanded = !isPreviewExpanded;

  if (isPreviewExpanded) {
    container.style.height = '600px';
    btn.textContent = '⛶ Collapse';
  } else {
    container.style.height = '380px';
    btn.textContent = '⛶ Expand';
  }
}
window.togglePreviewExpand = togglePreviewExpand;

function renderLivePreview(bot) {
  if (!bot) return;

  // Get values from form if available (ensures latest values are shown)
  const greetingInput = document.getElementById('cfg-greeting');
  const primaryColorInput = document.getElementById('cfg-primary-color');
  const displayNameInput = document.getElementById('cfg-display-name');
  const positionInput = document.getElementById('cfg-widget-position');

  const primaryColor = (primaryColorInput?.value) || bot.theme?.primaryColor || bot.color || '#6c63ff';
  const greeting = (greetingInput?.value?.trim()) || bot.greeting_message || bot.greetingMessage || 'Hi! How can I help you today?';
  const botName = (displayNameInput?.value?.trim()) || bot.theme?.displayName || bot.name || 'Assistant';
  const avatarUrl = bot.theme?.avatarUrl || '';
  const position = (positionInput?.value) || bot.theme?.position || 'bottom-right';
  const isWidgetMode = currentPreviewMode === 'widget';

  const avatarContent = avatarUrl
    ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" onerror="this.style.display='none';this.parentElement.textContent='🤖'" />`
    : '🤖';

  // Widget mode: starts as bubble, click opens chat, X closes back to bubble
  const widgetPreviewHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family:'Plus Jakarta Sans',sans-serif;
    background:#f0f0f5;
    height:100vh;
    overflow:hidden;
    position:relative;
  }
  .mock-page {
    position:absolute; inset:0;
    display:flex; align-items:center; justify-content:center;
    color:#aaa; font-size:13px; pointer-events:none;
    background: linear-gradient(135deg, #f5f5f5 0%, #ececec 100%);
  }
  .mock-page-lines {
    display:flex; flex-direction:column; gap:10px; width:60%; opacity:0.4;
  }
  .mock-line {
    height:12px; background:#ccc; border-radius:6px;
  }
  /* Launcher bubble */
  .launcher {
    position:fixed; bottom:24px; right:24px;
    width:58px; height:58px;
    background:${primaryColor};
    border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    font-size:26px;
    box-shadow:0 4px 24px rgba(0,0,0,0.22);
    cursor:pointer; z-index:100;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }
  .launcher:hover { transform:scale(1.08); box-shadow:0 6px 28px rgba(0,0,0,0.28); }
  /* Unread badge on launcher */
  .launcher-badge {
    position:absolute; top:-2px; right:-2px;
    width:18px; height:18px;
    background:#ff4d6a; color:#fff;
    border-radius:50%; font-size:10px; font-weight:700;
    display:flex; align-items:center; justify-content:center;
    border:2px solid #f0f0f5;
  }
  /* Greeting popup above launcher */
  .greeting-popup {
    position:fixed; bottom:96px; right:24px;
    background:#fff;
    border-radius:14px 14px 4px 14px;
    padding:12px 16px;
    max-width:220px;
    font-size:13px; line-height:1.5; color:#333;
    box-shadow:0 4px 20px rgba(0,0,0,0.12);
    z-index:99;
    animation: popIn 0.3s ease;
  }
  .greeting-popup::after {
    content:'';
    position:absolute; bottom:-8px; right:20px;
    width:0; height:0;
    border-left:8px solid transparent;
    border-right:8px solid transparent;
    border-top:8px solid #fff;
  }
  @keyframes popIn {
    from { opacity:0; transform:translateY(8px) scale(0.95); }
    to   { opacity:1; transform:translateY(0) scale(1); }
  }
  /* Chat window */
  .chat-window {
    position:fixed; bottom:24px; right:24px;
    width:340px; height:480px;
    background:#fff;
    border-radius:18px;
    box-shadow:0 12px 48px rgba(0,0,0,0.18);
    display:flex; flex-direction:column;
    overflow:hidden; z-index:100;
    transform-origin:bottom right;
    animation: openChat 0.25s cubic-bezier(0.34,1.56,0.64,1);
  }
  @keyframes openChat {
    from { opacity:0; transform:scale(0.7); }
    to   { opacity:1; transform:scale(1); }
  }
  .chat-header {
    background:${primaryColor};
    padding:14px 16px;
    display:flex; align-items:center; gap:10px;
    color:#fff; flex-shrink:0;
  }
  .chat-header-avatar {
    width:36px; height:36px;
    background:rgba(255,255,255,0.2);
    border-radius:10px;
    display:flex; align-items:center; justify-content:center;
    font-size:18px; flex-shrink:0; overflow:hidden;
  }
  .chat-header-info { flex:1; }
  .chat-header-info .name { font-weight:700; font-size:14px; }
  .chat-header-info .status { font-size:11px; opacity:0.85; margin-top:1px; }
  .close-btn {
    width:28px; height:28px;
    background:rgba(255,255,255,0.2);
    border:none; border-radius:50%;
    color:#fff; font-size:16px; font-weight:300;
    cursor:pointer; display:flex; align-items:center; justify-content:center;
    flex-shrink:0; line-height:1;
    transition:background 0.15s;
  }
  .close-btn:hover { background:rgba(255,255,255,0.35); }
  .chat-messages {
    flex:1; padding:14px;
    display:flex; flex-direction:column; gap:10px;
    overflow-y:auto; background:#fafafa;
  }
  .chat-messages::-webkit-scrollbar { width:4px; }
  .chat-messages::-webkit-scrollbar-thumb { background:#ddd; border-radius:4px; }
  .msg { max-width:82%; padding:9px 13px; border-radius:16px; font-size:13px; line-height:1.5; }
  .msg.bot {
    background:#fff; border:1px solid #eee;
    border-bottom-left-radius:4px; align-self:flex-start;
    color:#333; box-shadow:0 1px 3px rgba(0,0,0,0.05);
  }
  .msg.bot a { color:#6c63ff; text-decoration:underline; }
  .msg.bot a:hover { color:#5a52d9; }
  .msg.user {
    background:${primaryColor}; color:#fff;
    border-bottom-right-radius:4px; align-self:flex-end;
  }
  .typing-dots {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 6px 2px;
    align-self: flex-start;
  }
  .typing-dots span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    animation: wave 1.3s ease-in-out infinite;
  }
  .typing-dots span:nth-child(1) {
    background: #c0c0c0;
    animation-delay: 0s;
  }
  .typing-dots span:nth-child(2) {
    background: #808080;
    animation-delay: 0.18s;
  }
  .typing-dots span:nth-child(3) {
    background: #303030;
    animation-delay: 0.36s;
  }
  @keyframes wave {
    0%,60%,100% { transform:translateY(0); opacity:0.6; }
    30% { transform:translateY(-4px); opacity:1; }
  }
  .chat-input-area {
    padding:10px 12px; border-top:1px solid #eee;
    display:flex; gap:8px; align-items:center; background:#fff;
    flex-shrink:0;
  }
  .chat-input {
    flex:1; border:1px solid #e5e5e5; border-radius:20px;
    padding:8px 14px; font-size:13px; outline:none;
    color:#333; background:#f8f8f8; font-family:inherit;
    transition:border-color 0.15s;
  }
  .chat-input:focus { border-color:${primaryColor}; }
  .send-btn {
    width:34px; height:34px; background:${primaryColor};
    border:none; border-radius:50%; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    color:#fff; font-size:15px; flex-shrink:0;
    transition:opacity 0.15s;
  }
  .send-btn:hover { opacity:0.85; }
  .hidden { display:none !important; }
</style>
</head>
<body>
  <!-- Mock website background -->
  <div class="mock-page">
    <div class="mock-page-lines">
      <div class="mock-line" style="width:80%"></div>
      <div class="mock-line" style="width:60%"></div>
      <div class="mock-line" style="width:90%"></div>
      <div class="mock-line" style="width:50%"></div>
      <div class="mock-line" style="width:75%"></div>
    </div>
  </div>

  <!-- Greeting popup (shown with bubble) -->
  <div class="greeting-popup" id="greeting-popup">${greeting}</div>

  <!-- Launcher bubble -->
  <div class="launcher" id="launcher" onclick="openChat()">
    💬
    <div class="launcher-badge">1</div>
  </div>

  <!-- Chat window (hidden initially) -->
  <div class="chat-window hidden" id="chat-window">
    <div class="chat-header">
      <div class="chat-header-avatar">${avatarContent}</div>
      <div class="chat-header-info">
        <div class="name">${botName}</div>
        <div class="status">⬤ Online · Ready to help</div>
      </div>
      <button class="close-btn" onclick="showNewConvConfirm()" title="New conversation" style="margin-right:4px;font-size:14px;">&#8635;</button>
      <button class="close-btn" onclick="closeChat()">✕</button>
    </div>
    <div class="chat-messages" id="chat-messages">
      <div class="msg bot">${greeting}</div>
    </div>
    <div class="chat-input-area">
      <input class="chat-input" id="chat-input" placeholder="Type a message…" onkeydown="handleKey(event)" />
      <button class="send-btn" onclick="sendMsg()">↑</button>
    </div>
    <!-- New conversation confirm footer — hidden by default -->
    <div id="new-conv-confirm" style="display:none;position:absolute;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:14px 16px;display:none;flex-direction:column;align-items:center;gap:10px;z-index:10;box-shadow:0 -4px 12px rgba(0,0,0,0.08);">
      <div style="font-size:13px;font-weight:600;color:#333;">Start a new conversation?</div>
      <div style="font-size:11px;color:#888;text-align:center;">Your current chat history will no longer be visible.</div>
      <div style="display:flex;gap:8px;width:100%;">
        <button onclick="cancelNewConv()" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:10px;background:#fff;font-size:13px;cursor:pointer;">Cancel</button>
        <button onclick="confirmNewConv()" style="flex:1;padding:8px;border:none;border-radius:10px;background:#6c63ff;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">New Chat</button>
      </div>
    </div>
  </div>

<script>
  let isSending = false;

  function openChat() {
    document.getElementById('launcher').classList.add('hidden');
    document.getElementById('greeting-popup').classList.add('hidden');
    document.getElementById('chat-window').classList.remove('hidden');

    // Create conversation only if not already created
    // Parent window will attach visitor ID from localStorage
    if (!window._previewConvId) {
      window.parent.postMessage({ 
        type:   'IAM_CONV_CREATE', 
        bot_id: '${bot.id}',
      }, '*');
    }
  }
  function closeChat() {
    document.getElementById('chat-window').classList.add('hidden');
    document.getElementById('launcher').classList.remove('hidden');
  }
  // Markdown renderer
  function formatMarkdown(text) {
    if (!text) return '';
    let h = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    h = h.replace(/^### (.+)$/gm, '<strong>$1</strong>');
    h = h.replace(/^## (.+)$/gm, '<strong>$1</strong>');
    h = h.replace(/^# (.+)$/gm, '<strong>$1</strong>');
    h = h.replace(/[*][*](.+?)[*][*]/g, '<strong>$1</strong>');
    h = h.replace(/__(.+?)__/g, '<strong>$1</strong>');
    h = h.replace(/[*](.+?)[*]/g, '<em>$1</em>');
    h = h.replace(/^[ ]*[-][ ]+(.+)$/gm, '<li style="margin:2px 0;">$1</li>');
    h = h.replace(/^[ ]*[0-9]+[.][ ]+(.+)$/gm, '<li style="margin:2px 0;">$1</li>');
    h = h.replace(/<li/g, function(m,o,s){ var prev=s.lastIndexOf('<ul',o); var prevEnd=s.lastIndexOf('</ul>',o); if(prev===-1||prevEnd>prev) return '<ul style="margin:6px 0;padding-left:18px;"><li'; return m; });
    h = h.replace(/(<[/]li>)(?![\s\S]*?<li)/g, '$1</ul>');
    var nl = String.fromCharCode(10); h = h.split(nl+nl).join('<br><br>'); h = h.split(nl).join('<br>');
    return h;
  }

  function sendMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || isSending) return;
  isSending = true;

  const msgs = document.getElementById('chat-messages');
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  userMsg.textContent = text;
  msgs.appendChild(userMsg);
  input.value = '';
  msgs.scrollTop = msgs.scrollHeight;

  // Show typing indicator
  const typing = document.createElement('div');
  typing.className = 'typing-dots';
  typing.id = 'typing-indicator';
  typing.innerHTML = '<span></span><span></span><span></span>';
  msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;

  // Send to parent window to make the API call - avoids CORS
  window.parent.postMessage({
    type: 'IAM_BOT_REQUEST',
    message: text,
    bot_id: '${bot.id}',
    conv_id: window._previewConvId || null
  }, '*');
}

// Listen for response from parent
window.addEventListener('message', function (e) {
  if (!e.data) return;

  if (e.data.type === 'IAM_CONV_CREATED') {
    window._previewConvId = e.data.conv_id;
  }

  // Load previous chat history
  if (e.data.type === 'IAM_LOAD_HISTORY' && e.data.messages?.length) {
    const msgs = document.getElementById('chat-messages');
    msgs.innerHTML = '';
    e.data.messages.forEach(function(m) {
      if (m.role === 'system') {
        addSystemMsg(m.content);
      } else {
        var div = document.createElement('div');
        div.className = 'msg ' + (m.role === 'bot' || m.role === 'human-agent' ? 'bot' : 'user');
        div.textContent = m.content;
        msgs.appendChild(div);
      }
    });
    msgs.scrollTop = msgs.scrollHeight;
  }

  // Bot AI response
  if (e.data.type === 'IAM_BOT_RESPONSE') {
    var msgs = document.getElementById('chat-messages');
    var t = document.getElementById('typing-indicator');
    if (t) t.remove();
    if (e.data.response) {
      var botMsg = document.createElement('div');
      botMsg.className = 'msg bot';
      botMsg.innerHTML = formatMarkdown(e.data.response);
      msgs.appendChild(botMsg);
      msgs.scrollTop = msgs.scrollHeight;
    }
    if (e.data.conv_id) window._previewConvId = e.data.conv_id;
    isSending = false;
  }

  // Human agent message — show like a bot message (same side) but with agent label
  if (e.data.type === 'IAM_AGENT_MESSAGE') {
    var msgs = document.getElementById('chat-messages');
    var t = document.getElementById('typing-indicator');
    if (t) t.remove();
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:2px;';
    var label = document.createElement('div');
    label.textContent = 'Support Agent';
    label.style.cssText = 'font-size:10px;color:#888;margin-left:4px;';
    var agentMsg = document.createElement('div');
    agentMsg.className = 'msg bot';
    agentMsg.style.borderLeft = '3px solid #10b981';
    agentMsg.textContent = e.data.content;
    wrap.appendChild(label);
    wrap.appendChild(agentMsg);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
    isSending = false;
  }

  // System notification message
  if (e.data.type === 'IAM_SYSTEM_MESSAGE') {
    var msgs = document.getElementById('chat-messages');
    addSystemMsg(e.data.content);
    msgs.scrollTop = msgs.scrollHeight;
  }
});

function addSystemMsg(content) {
  var msgs = document.getElementById('chat-messages');
  var label = content === 'agent_joined'
    ? '&#128100; A live agent has joined'
    : '&#129302; AI assistant has resumed';
  var div = document.createElement('div');
  div.style.cssText = 'display:flex;justify-content:center;margin:8px 0;';
  div.innerHTML = '<span style="font-size:10px;color:#888;background:#f0f0f0;border-radius:20px;padding:3px 12px;">' + label + '</span>';
  msgs.appendChild(div);
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
}

function showNewConvConfirm() {
  var footer = document.getElementById('new-conv-confirm');
  if (footer) { footer.style.display = 'flex'; }
}
function cancelNewConv() {
  var footer = document.getElementById('new-conv-confirm');
  if (footer) { footer.style.display = 'none'; }
}
function confirmNewConv() {
  var footer = document.getElementById('new-conv-confirm');
  if (footer) { footer.style.display = 'none'; }
  window._previewConvId = null;
  var msgs = document.getElementById('chat-messages');
  msgs.innerHTML = '<div class="msg bot">${greeting}</div>';
  window.parent.postMessage({ type: 'IAM_NEW_CONV', bot_id: '${bot.id}' }, '*');
}
<\/script>
</body >
</html > `;

  // Full page / inline embed mode
  const fullPageHTML = `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          * {margin:0; padding:0; box-sizing:border-box; }
          body {
            font - family:'Plus Jakarta Sans',sans-serif;
          background:#0a0a0f;
          height:100vh; display:flex; overflow:hidden;
  }
          .chat-window {
            width:100%; height:100vh;
          background:#fff;
          display:flex; flex-direction:column; overflow:hidden;
  }
          .chat-header {
            background:${primaryColor};
          padding:16px 20px;
          display:flex; align-items:center; gap:12px;
          color:#fff; flex-shrink:0;
  }
          .chat-header-avatar {
            width:40px; height:40px;
          background:rgba(255,255,255,0.2);
          border-radius:12px;
          display:flex; align-items:center; justify-content:center;
          font-size:20px; flex-shrink:0; overflow:hidden;
  }
          .chat-header-info .name {font - weight:700; font-size:15px; }
          .chat-header-info .status {font - size:12px; opacity:0.85; margin-top:2px; }
          .chat-messages {
            flex:1; padding:20px;
          display:flex; flex-direction:column; gap:12px;
          overflow-y:auto; background:#fafafa;
  }
          .msg {max - width:75%; padding:11px 16px; border-radius:18px; font-size:14px; line-height:1.55; }
          .msg.bot {background:#fff; border:1px solid #eee; border-bottom-left-radius:4px; align-self:flex-start; color:#333; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
          .msg.bot a {color:#6c63ff; text-decoration:underline; }
          .msg.bot a:hover {color:#5a52d9; }
          .msg.user {background:${primaryColor}; color:#fff; border-bottom-right-radius:4px; align-self:flex-end; }
          .typing-dots {
            display: flex;
          align-items: center;
          gap: 3px;
          padding: 6px 2px;
          align-self: flex-start;
  }
          .typing-dots span {
            width: 5px;
          height: 5px;
          border-radius: 50%;
          animation: wave 1.3s ease-in-out infinite;
  }
          .typing-dots span:nth-child(1) {
            background: #c0c0c0;
          animation-delay: 0s;
  }
          .typing-dots span:nth-child(2) {
            background: #808080;
          animation-delay: 0.18s;
  }
          .typing-dots span:nth-child(3) {
            background: #303030;
          animation-delay: 0.36s;
  }
          @keyframes wave {
            0 %, 60 %, 100 % { transform: translateY(0); opacity: 0.6; }
    30% {transform:translateY(-4px); opacity:1; }
  }
          .chat-input-area {
            padding:14px 16px; border-top:1px solid #eee;
          display:flex; gap:10px; align-items:center; background:#fff; flex-shrink:0;
  }
          .chat-input {flex:1; border:1px solid #e5e5e5; border-radius:24px; padding:10px 18px; font-size:14px; outline:none; color:#333; background:#f8f8f8; font-family:inherit; }
          .chat-input:focus {border - color:${primaryColor}; }
          .send-btn {width:38px; height:38px; background:${primaryColor}; border:none; border-radius:50%; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#fff; font-size:16px; flex-shrink:0; }
        </style>
    </head>
    <body>
      <div class="chat-window">
        <div class="chat-header">
          <div class="chat-header-avatar">${avatarContent}</div>
          <div class="chat-header-info">
            <div class="name">${botName}</div>
            <div class="status">⬤ Online · Ready to help</div>
          </div>
        </div>
        <div class="chat-messages">
          <div class="msg bot">${greeting}</div>
        </div>
        <div class="chat-input-area">
          <input class="chat-input" id="fp-chat-input" placeholder="Type a message…"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();fpSendMsg()}" />
          <button class="send-btn" onclick="fpSendMsg()">↑</button>
        </div>
      </div>
    </body>
    <script>
      let fpSending = false;

      // Create conversation on load (only if not already created)
      // Parent window will attach visitor ID from localStorage
      if (!window._fpConvId) {
        window.parent.postMessage({
          type: 'IAM_CONV_CREATE',
          bot_id: '${bot.id}',
        }, '*');
  }

      // Markdown renderer
      function formatMarkdown(text) {
        if (!text) return '';
        let h = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        h = h.replace(/^### (.+)$/gm, '<strong>$1</strong>');
        h = h.replace(/^## (.+)$/gm, '<strong>$1</strong>');
        h = h.replace(/^# (.+)$/gm, '<strong>$1</strong>');
        h = h.replace(/[*][*](.+?)[*][*]/g, '<strong>$1</strong>');
        h = h.replace(/__(.+?)__/g, '<strong>$1</strong>');
        h = h.replace(/[*](.+?)[*]/g, '<em>$1</em>');
        h = h.replace(/^[ ]*[-][ ]+(.+)$/gm, '<li style="margin:2px 0;">$1</li>');
        h = h.replace(/^[ ]*[0-9]+[.][ ]+(.+)$/gm, '<li style="margin:2px 0;">$1</li>');
        var nl = String.fromCharCode(10); h = h.split(nl+nl).join('<br><br>'); h = h.split(nl).join('<br>');
        return h;
      }
      function fpSendMsg() {
  const input = document.getElementById('fp-chat-input');
  const text = input.value.trim();
  if (!text || fpSending) return;
  fpSending = true;

  const msgs = document.querySelector('.chat-messages');
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  userMsg.textContent = text;
  msgs.appendChild(userMsg);
  input.value = '';
  msgs.scrollTop = msgs.scrollHeight;

  const typing = document.createElement('div');
  typing.className = 'typing-dots';
  typing.id = 'fp-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;

  // Send to parent window to make the API call - avoids CORS
  window.parent.postMessage({
    type: 'IAM_BOT_REQUEST',
    message: text,
    bot_id: '${bot.id}',
    conv_id: window._fpConvId || null
  }, '*');
}

// Listen for response from parent
window.addEventListener('message', function (e) {
  if (!e.data) return;

  if (e.data.type === 'IAM_CONV_CREATED') {
    window._fpConvId = e.data.conv_id;
  }

  // Handle loading previous chat history (from mode switch)
  if (e.data.type === 'IAM_LOAD_HISTORY' && e.data.messages?.length) {
    const msgs = document.querySelector('.chat-messages');
    // Clear any greeting message and rebuild from history
    msgs.innerHTML = '';
    e.data.messages.forEach(m => {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.role === 'bot' ? 'bot' : 'user');
      div.textContent = m.content;
      msgs.appendChild(div);
    });
    msgs.scrollTop = msgs.scrollHeight;
  }

  if (e.data.type === 'IAM_BOT_RESPONSE') {
    const msgs = document.querySelector('.chat-messages');
    const t = document.getElementById('fp-typing');
    if (t) t.remove();
    const botMsg = document.createElement('div');
    botMsg.className = 'msg bot';
    botMsg.innerHTML = formatMarkdown(e.data.response) || 'Sorry, no response received.';
    msgs.appendChild(botMsg);
    msgs.scrollTop = msgs.scrollHeight;
    if (e.data.conv_id) window._fpConvId = e.data.conv_id;
    fpSending = false;
  }
});
    </script >
  </html > `;

  const html = isWidgetMode ? widgetPreviewHTML : fullPageHTML;

  // Render in modal preview iframe
  const modalIframe = document.getElementById('preview-iframe');
  if (modalIframe) {
    modalIframe.srcdoc = html;
    // Restore previous chat state after iframe loads
    modalIframe.onload = () => {
      if (PreviewState.convId) {
        modalIframe.contentWindow.postMessage({
          type: 'IAM_CONV_CREATED',
          conv_id: PreviewState.convId,
          returning: true
        }, '*');
      }
      if (PreviewState.messages.length > 0) {
        modalIframe.contentWindow.postMessage({
          type: 'IAM_LOAD_HISTORY',
          messages: PreviewState.messages
        }, '*');
      }
    };
  }

  // Also render in inline appearance preview
  const inlineIframe = document.getElementById('preview-iframe-inline');
  if (inlineIframe) {
    inlineIframe.srcdoc = html;
    inlineIframe.onload = () => {
      if (PreviewState.convId) {
        inlineIframe.contentWindow.postMessage({
          type: 'IAM_CONV_CREATED',
          conv_id: PreviewState.convId,
          returning: true
        }, '*');
      }
      if (PreviewState.messages.length > 0) {
        inlineIframe.contentWindow.postMessage({
          type: 'IAM_LOAD_HISTORY',
          messages: PreviewState.messages
        }, '*');
      }
    };
  }
}
window.renderLivePreview = renderLivePreview;

function setPreviewMode(mode) {
  currentPreviewMode = mode;
  const widgetTab = document.getElementById('preview-tab-widget');
  const embedTab = document.getElementById('preview-tab-embed');
  const btnWidgetView = document.getElementById('btn-widget-view');
  const btnFullpageView = document.getElementById('btn-fullpage-view');

  // Update modal tabs
  if (widgetTab) widgetTab.classList.toggle('active', mode === 'widget');
  if (embedTab) embedTab.classList.toggle('active', mode === 'embed');

  // Update inline preview buttons (active state)
  if (btnWidgetView) {
    btnWidgetView.classList.toggle('btn-primary', mode === 'widget');
    btnWidgetView.classList.toggle('btn-secondary', mode !== 'widget');
  }
  if (btnFullpageView) {
    btnFullpageView.classList.toggle('btn-primary', mode === 'embed');
    btnFullpageView.classList.toggle('btn-secondary', mode !== 'embed');
  }

  // Render preview directly using srcdoc (no external file needed)
  const bot = AppState.currentBot;
  if (bot) {
    renderLivePreview(bot);
  }
}
window.setPreviewMode = setPreviewMode;

function openBotPreview() {
  const bot = AppState.currentBot;
  if (!bot) return;

  setPreviewMode('widget'); // Default to widget view
  renderLivePreview(bot); // Render immediately
  openModal('modal-preview-bot');
}
window.openBotPreview = openBotPreview;

function sharePreviewLink() {
  const bot = AppState.currentBot;
  if (!bot) return;

  const url = `${window.location.origin}${window.location.pathname.replace('index.html', '')}preview.html?botId=${bot.id}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast('Preview link copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy link', 'error');
  });
}
window.sharePreviewLink = sharePreviewLink;

/* ── API KEY HELPERS ── */
function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const key = 'iam_live_' + Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const el = document.getElementById('api-key-display');
  if (el) { el.value = key; el.type = 'text'; }
  showToast('API key generated — copy it now, it won\'t be shown again', 'info');
}
window.generateApiKey = generateApiKey;

function copyApiKey() {
  const el = document.getElementById('api-key-display');
  if (!el || !el.value) { showToast('Generate a key first', 'error'); return; }
  navigator.clipboard.writeText(el.value).then(() => showToast('API key copied!', 'success'));
}
window.copyApiKey = copyApiKey;

/* ─── BOT CONFIG ─────────────────────────────────────────────────── */
async function createBot() {
  const name = document.getElementById('new-bot-name')?.value?.trim();
  const model = document.getElementById('new-bot-model')?.value || 'gemini-2.5-flash';
  if (!name) { showToast('Please enter a bot name', 'error'); return; }
  try {
    const newBot = await Bots.create({ name, model, status: 'unpublished', color: getColorForId(name + Date.now()) });
    Store.addItem('bots', newBot);
    LocalDB.clear('bots');
    closeModal('modal-create-bot');
    document.getElementById('new-bot-name').value = '';
    showToast(`"${name}" created!`, 'success');
    navigate('bot-config', { botId: newBot.id, botName: newBot.name });
  } catch (e) {
    console.error(e);
    showToast('Failed to create bot', 'error');
  }
}

async function saveBotConfig() {
  const bot = AppState.currentBot;
  if (!bot) return;
  const updates = {
    name: document.getElementById('cfg-bot-name')?.value?.trim() || bot.name,
    model: document.getElementById('cfg-model')?.value || bot.model,
    greeting_message: document.getElementById('cfg-greeting')?.value?.trim() || bot.greeting_message,
    system_prompt: document.getElementById('cfg-prompt')?.value?.trim() || bot.system_prompt,
    status: document.getElementById('cfg-live')?.checked ? 'live' : 'unpublished',
    theme: {
      ...(bot.theme || {}),
      primaryColor: document.getElementById('cfg-primary-color')?.value || bot.theme?.primaryColor,
      position: document.getElementById('cfg-widget-position')?.value || bot.theme?.position,
      displayName: document.getElementById('cfg-display-name')?.value?.trim() || bot.theme?.displayName,
      avatarUrl: document.getElementById('cfg-avatar-url')?.value?.trim() || bot.theme?.avatarUrl,
    },
  };
  try {
    const saved = await Bots.update(bot.id, updates);
    Store.updateItem('bots', bot.id, saved);
    AppState.currentBot = { ...bot, ...saved };
    LocalDB.clear('bots');
    Cache.clear(`analytics_summary_all`);
    showToast('Bot saved!', 'success');
    renderEmbedCode(AppState.currentBot);
  } catch (e) {
    console.error(e);
    showToast('Failed to save bot', 'error');
  }
}

function confirmDeleteBot(id, name) {
  if (confirm(`Delete "${name}" ? This cannot be undone.`)) deleteBot(id);
}

async function deleteBot(id) {
  try {
    Store.removeItem('bots', id);
    LocalDB.clear('bots');
    await Bots.delete(id);
    if (AppState.currentBot?.id === id) {
      AppState.currentBot = null;
      navigate('home');
    }
    showToast('Bot deleted', 'info');
  } catch (e) {
    console.error(e);
    showToast('Failed to delete bot', 'error');
  }
}

function renderBotConfig(extra = {}) {
  const botId = extra.botId || AppState.currentBot?.id;
  if (!botId) { navigate('home'); return; }

  const bot = AppState.bots.find(b => b.id === botId) || AppState.currentBot;
  if (!bot) { navigate('home'); return; }

  AppState.currentBot = bot;

  // Update page title elements
  const titleEl = document.getElementById('bot-config-name');
  if (titleEl) titleEl.textContent = bot.name;

  // Fill the form fields
  fillBotForm(bot);

  // Render attached KBs and embed code
  renderAttachedKBs(bot);
  renderEmbedCode(bot);

  // Set default preview mode to widget
  currentPreviewMode = 'widget';

  // Update button states
  const btnWidgetView = document.getElementById('btn-widget-view');
  const btnFullpageView = document.getElementById('btn-fullpage-view');
  if (btnWidgetView) {
    btnWidgetView.classList.add('btn-primary');
    btnWidgetView.classList.remove('btn-secondary');
  }
  if (btnFullpageView) {
    btnFullpageView.classList.add('btn-secondary');
    btnFullpageView.classList.remove('btn-primary');
  }

  // Reset to Overview tab (preview is in Appearance tab)
  showConfigSection('overview');
}

function fillBotForm(bot) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
  const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

  set('cfg-bot-name', bot.name || '');
  set('cfg-model', bot.model || 'gemini-2.5-flash');
  set('cfg-greeting', bot.greeting_message || '');
  set('cfg-prompt', bot.system_prompt || '');
  setChk('cfg-live', bot.status === 'live');

  const theme = bot.theme || {};
  const color = theme.primaryColor || bot.color || '#6c63ff';
  set('cfg-primary-color', color);
  set('cfg-primary-color-hex', color);
  set('cfg-widget-position', theme.position || 'bottom-right');
  set('cfg-display-name', theme.displayName || '');
  set('cfg-avatar-url', theme.avatarUrl || '');

  // Sync the preview bubble color
  const bubble = document.getElementById('cfg-preview-bubble');
  if (bubble) bubble.style.background = color;

  // Render variables
  renderVariablesTable(bot.bot_variables || []);
}

function showConfigSection(section) {
  // CSS controls visibility via .config-section.active (display:flex) vs no active (display:none)
  const configSections = document.querySelectorAll('.config-section');
  const configNavItems = document.querySelectorAll('.config-nav-item');
  configSections.forEach(el => el.classList.remove('active'));
  configNavItems.forEach(el => el.classList.remove('active'));

  const target = document.getElementById(`config-${section}`);
  if (target) target.classList.add('active');

  const navItem = document.querySelector('.config-nav-item[data-section="' + section + '"]');
  if (navItem) navItem.classList.add('active');

  // Render preview when appearance section is shown
  if (section === 'design' && AppState.currentBot) {
    // Ensure default mode is widget
    currentPreviewMode = 'widget';

    // Update button states to show widget as active
    const btnWidgetView = document.getElementById('btn-widget-view');
    const btnFullpageView = document.getElementById('btn-fullpage-view');
    if (btnWidgetView) {
      btnWidgetView.classList.add('btn-primary');
      btnWidgetView.classList.remove('btn-secondary');
    }
    if (btnFullpageView) {
      btnFullpageView.classList.add('btn-secondary');
      btnFullpageView.classList.remove('btn-primary');
    }

    renderLivePreview(AppState.currentBot);
  }
}

function renderEmbedCode(bot) {
  if (!bot) return;
  const color = bot.theme?.primaryColor || bot.color || '#6c63ff';
  const name = bot.theme?.displayName || bot.name || 'Assistant';
  const pos = bot.theme?.position || 'bottom-right';

  const widgetSnippet = `< script >
  (function (w, d, b) {
    w.IAMConfig = { botId: "${bot.id}", color: "${color}", position: "${pos}" };
    var s = d.createElement('script'); s.src = b + '/widget.js'; s.async = true;
    d.head.appendChild(s);
  })(window, document, 'https://iam-platform.app');
<\/script>`;

  const inpageSnippet = `<div id="iam-chat" data-bot-id="${bot.id}"></div>
<script src="https://iam-platform.app/embed.js" async><\/script>`;

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('widget-snippet', widgetSnippet);
  setEl('inpage-snippet', inpageSnippet);
  // Also fill the panel versions
  setEl('widget-snippet-p', widgetSnippet);
  setEl('inpage-snippet-p', inpageSnippet);
}

function renderEmbedPanel() {
  const bot = AppState.currentBot;
  if (!bot) return;
  renderEmbedCode(bot);
}

function copySnippet(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(
    () => showToast('Snippet copied!', 'success'),
    () => showToast('Copy failed', 'error')
  );
}

/* ─── BOT VARIABLES ──────────────────────────────────────────────── */
let _editingVarId = null;
let _allVariables = [];

// System variables - read-only, cannot be edited or deleted
const SYSTEM_VARIABLES = [
  { id: 'sys_timestamp', name: 'current_timestamp', description: 'Current Unix timestamp (ms)', type: 'datetime', required: false, is_system: true },
  { id: 'sys_page_url', name: 'page_url', description: 'Current page URL', type: 'url', required: false, is_system: true },
  { id: 'sys_language', name: 'browser_language', description: 'Browser language code', type: 'text', required: false, is_system: true },
  { id: 'sys_title', name: 'page_title', description: 'Current page title', type: 'text', required: false, is_system: true },
  { id: 'sys_timezone', name: 'user_timezone', description: 'User timezone', type: 'text', required: false, is_system: true },
  { id: 'sys_platform', name: 'user_platform', description: 'User OS and browser platform', type: 'text', required: false, is_system: true },
  { id: 'sys_origin', name: 'user_origin', description: 'Traffic source / referrer', type: 'text', required: false, is_system: true },
  { id: 'sys_bot_id', name: 'bot_id', description: 'Current bot ID', type: 'text', required: false, is_system: true },
  { id: 'sys_conv_id', name: 'conversation_id', description: 'Current conversation ID', type: 'text', required: false, is_system: true },
];

function renderVariablesTable(vars, filter = 'all') {
  // Only include custom vars (non-system) from the DB to avoid duplicates
  const customVars = (vars || []).filter(v => !v.is_system);
  const allVarsWithSystem = [...SYSTEM_VARIABLES, ...customVars];
  _allVariables = allVarsWithSystem;

  const tbody = document.getElementById('variables-table-body');
  if (!tbody) return;

  const filtered = filter === 'all' ? allVarsWithSystem
    : allVarsWithSystem.filter(v => v.source === filter || (filter === 'custom' && !v.is_system) || (filter === 'system' && v.is_system));

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px;">No variables yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(v => `
    <tr id="var-row-${v.id}" style="${v.is_system ? 'opacity:0.7;background:rgba(108,99,255,0.05);' : ''}">
      <td style="font-family:monospace;font-size:12px;">
        ${v.is_system ? '<span style="color:var(--accent);">🔒</span> ' : ''}${v.name}
      </td>
      <td style="font-size:13px;color:var(--text-secondary);">${v.description || '—'}</td>
      <td><span class="badge ${v.is_system ? 'badge-purple' : 'badge-gray'}">${v.is_system ? 'system' : (v.type || 'text')}</span></td>
      <td style="text-align:center;">
        <span style="color:${v.required ? 'var(--accent-2)' : 'var(--text-muted)'};">${v.required ? '✓' : '—'}</span>
      </td>
      <td style="text-align:right;">
        ${v.is_system
      ? '<span style="font-size:11px;color:var(--text-muted);">System</span>'
      : `<button class="btn btn-ghost btn-sm btn-icon" onclick="editVariable('${v.id}')">✏️</button>
             <button class="btn btn-ghost btn-sm btn-icon" style="color:var(--danger);" onclick="removeVariable('${v.id}')">🗑</button>`}
      </td>
    </tr>
  `).join('');
}

function filterVariables(filter) {
  $$('#var-filter-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase().includes(filter === 'all' ? 'all' : filter)));
  renderVariablesTable(_allVariables, filter);
}

async function addVariable() {
  const bot = AppState.currentBot;
  if (!bot) return;

  const name = document.getElementById('new-var-name')?.value?.trim();
  const desc = document.getElementById('new-var-desc')?.value?.trim() || '';
  const type = document.getElementById('new-var-type')?.value || 'text';
  const required = document.getElementById('new-var-required')?.checked || false;

  if (!name) { showToast('Variable name is required', 'error'); return; }
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) { showToast('Name must start with a letter and contain only letters, numbers, underscores', 'error'); return; }

  // Check for duplicate with system variables
  const systemNames = SYSTEM_VARIABLES.map(sv => sv.name.toLowerCase());
  if (systemNames.includes(name.toLowerCase())) {
    showToast('Cannot create variable: name conflicts with system variable "' + name + '"', 'error');
    return;
  }

  // Check for duplicate with existing custom variables
  const customVarNames = _allVariables.filter(v => !v.is_system).map(v => v.name.toLowerCase());
  if (customVarNames.includes(name.toLowerCase())) {
    showToast('A variable with this name already exists', 'error');
    return;
  }

  if (_editingVarId) {
    // Update existing - also check system variable conflict
    const systemNames = SYSTEM_VARIABLES.map(sv => sv.name.toLowerCase());
    if (systemNames.includes(name.toLowerCase())) {
      showToast('Cannot rename to system variable name "' + name + '"', 'error');
      return;
    }

    // Update existing
    try {
      await supabase.from('bot_variables').update({ name, description: desc, type, required }).eq('id', _editingVarId);
      const idx = _allVariables.findIndex(v => v.id === _editingVarId);
      if (idx > -1) _allVariables[idx] = { ..._allVariables[idx], name, description: desc, type, required };
      renderVariablesTable(_allVariables);
      cancelEditVariable();
      showToast('Variable updated', 'success');
    } catch (e) { showToast('Failed to update variable', 'error'); }
    return;
  }

  try {
    const { BotVariables } = await import('./supabase.js');
    const newVar = await BotVariables.add(bot.id, { name, description: desc, type, required });
    _allVariables = [newVar, ..._allVariables];
    renderVariablesTable(_allVariables);
    document.getElementById('new-var-name').value = '';
    document.getElementById('new-var-desc').value = '';
    showToast('Variable added', 'success');
  } catch (e) {
    console.error(e);
    showToast('Failed to add variable', 'error');
  }
}

function editVariable(id) {
  const v = _allVariables.find(v => v.id === id);
  if (!v) return;

  // Prevent editing system variables
  if (v.is_system) {
    showToast('System variables cannot be edited', 'error');
    return;
  }

  _editingVarId = id;
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val ?? ''; };
  set('new-var-name', v.name);
  set('new-var-desc', v.description || '');
  set('new-var-type', v.type || 'text');
  const req = document.getElementById('new-var-required');
  if (req) req.checked = !!v.required;
  const addBtn = document.getElementById('var-add-btn');
  const cancelBtn = document.getElementById('var-cancel-edit-btn');
  if (addBtn) addBtn.textContent = '✓ Save';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';
}

function cancelEditVariable() {
  _editingVarId = null;
  const clear = (id) => { const el = document.getElementById(id); if (el) el.value = ''; };
  clear('new-var-name'); clear('new-var-desc');
  const sel = document.getElementById('new-var-type'); if (sel) sel.value = 'text';
  const req = document.getElementById('new-var-required'); if (req) req.checked = false;
  const addBtn = document.getElementById('var-add-btn');
  const cancelBtn = document.getElementById('var-cancel-edit-btn');
  if (addBtn) addBtn.textContent = '+ Add';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

async function removeVariable(id) {
  // Find the variable first
  const v = _allVariables.find(v => v.id === id);
  if (!v) return;

  // Prevent deleting system variables
  if (v.is_system) {
    showToast('System variables cannot be deleted', 'error');
    return;
  }

  if (!confirm('Delete this variable?')) return;
  try {
    const { BotVariables } = await import('./supabase.js');
    await BotVariables.delete(id);
    _allVariables = _allVariables.filter(v => v.id !== id);
    renderVariablesTable(_allVariables);
    showToast('Variable removed', 'info');
  } catch (e) { showToast('Failed to remove variable', 'error'); }
}

/* ─── LEADS ──────────────────────────────────────────────────────── */
async function renderLeads() {
  const tbody = document.getElementById('leads-tbody');
  if (!tbody) return;

  let leads = Store.get('leads') || [];

  // If scoped to a bot, filter
  if (AppState.currentBot) {
    leads = leads.filter(l => l.bot_id === AppState.currentBot.id);
  }

  if (leads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:28px;">No leads yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = leads.map(l => {
    const botName = l.bots?.name || (AppState.bots.find(b => b.id === l.bot_id)?.name) || '—';
    const date = l.created_at ? new Date(l.created_at).toLocaleDateString() : '—';
    const statusColor = l.status === 'qualified' ? 'badge-green' : l.status === 'new' ? 'badge-purple' : 'badge-gray';
    return `
      <tr>
        <td>
          <div style="font-weight:600;">${l.name || '—'}</div>
          <div style="font-size:12px;color:var(--text-muted);">${l.email || ''}</div>
        </td>
        <td>${l.company || '—'}</td>
        <td>${l.phone || '—'}</td>
        <td>${botName}</td>
        <td>${date}</td>
        <td><span class="badge ${statusColor}">${l.status || 'new'}</span></td>
        <td style="text-align:right;">
          <button class="btn btn-ghost btn-sm btn-icon" style="color:var(--danger);" onclick="deleteLead('${l.id}')">🗑</button>
        </td>
      </tr>`;
  }).join('');
}

async function deleteLead(id) {
  if (!confirm('Delete this lead?')) return;
  try {
    Store.removeItem('leads', id);
    await Leads.delete(id);
    showToast('Lead deleted', 'info');
  } catch (e) {
    console.error(e);
    showToast('Failed to delete lead', 'error');
  }
}

/* ─── Final Global Exposures ─────────────────────────────────────── */

// Safe wrapper for embed button on bot cards — avoids AppState inline access
function openEmbedForBot(botId) {
  const bot = AppState.bots.find(b => b.id === botId);
  if (!bot) return;
  AppState.currentBot = bot;
  renderEmbedPanel();
  openPanel('panel-embed');
}
window.openEmbedForBot = openEmbedForBot;
window.renderConversations = renderConversations;
window.openModal = openModal;
window.closeModal = closeModal;
window.openPanel = openPanel;
window.closePanel = closePanel;
window.showToast = showToast;
window.navigate = navigate;
window.createBot = createBot;
window.saveBotConfig = saveBotConfig;
window.confirmDeleteBot = confirmDeleteBot;
window.addVariable = addVariable;
window.removeVariable = removeVariable;
window.editVariable = editVariable;
window.cancelEditVariable = cancelEditVariable;
window.filterVariables = filterVariables;
window.copySnippet = copySnippet;
window.sendAgentMessage = sendAgentMessage;
window.interceptConversation = interceptConversation;
window.endHITL = endHITL;
window.deleteLead = deleteLead;
window.deleteBot = deleteBot;
window.renderEmbedPanel = renderEmbedPanel;
window.renderBotConfig = renderBotConfig;
// KB functions
window.openKBDetail = openKBDetail;
window.openKB = openKBDetail; // alias for any old references
window.loadKBDetailFiles = loadKBDetailFiles;
window.switchKBDetailTab = switchKBDetailTab;
window.uploadKBDetailFiles = uploadKBDetailFiles;
window.uploadKBPanelFiles = uploadKBPanelFiles;
window.saveKBRichText = saveKBRichText;
window.startKBCrawl = startKBCrawl;
window.deleteKBFile = deleteKBFile;
window.renameKB = renameKB;
window.renameCurrentKB = renameCurrentKB;
window.confirmRenameKB = confirmRenameKB;
window.deleteCurrentKB = deleteCurrentKB;
window.confirmDeleteKB = confirmDeleteKB;
window.deleteKnowledgeBase = deleteKnowledgeBase;
window.openAttachKBModal = openAttachKBModal;
window.attachKB = attachKB;
window.detachKB = detachKB;
window.renderAttachedKBs = renderAttachedKBs;
window.addKnowledgeBase = addKnowledgeBase;
window.uploadKBPanelFiles = uploadKBPanelFiles;
// Settings / auth
window.saveWorkspaceSettings = saveWorkspaceSettings;
window.handleSignOut = handleSignOut;
window.toggleUserMenu = toggleUserMenu;
window.generateApiKey = generateApiKey;
window.copyApiKey = copyApiKey;
// Preview / config
window.openBotPreview = openBotPreview;
window.setPreviewMode = setPreviewMode;
window.sharePreviewLink = sharePreviewLink;
window.showConfigSection = showConfigSection;
window.handleConversationsNav = handleConversationsNav;
window.renderAnalytics = renderAnalytics;

console.log('IAM Platform: app.js loaded.');
