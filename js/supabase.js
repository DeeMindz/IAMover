/* ═══════════════════════════════════════════════════════════════
   IAM Platform — Supabase Client & Database Functions
═══════════════════════════════════════════════════════════════ */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://ekdsfvjsbhoxjszciquq.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrZHNmdmpzYmhveGpzemNpcXVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MTM1ODcsImV4cCI6MjA4OTE4OTU4N30.otpg9pOci8B9nN33APefE0ulHAlfJ-nVMvNSvrIf_xQ'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

/* ─── AUTH ────────────────────────────────────────────────────── */
export const Auth = {
  async signUp(email, password, fullName) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    })
    if (error) throw error
    if (data.user) {
      await supabase.from('profiles').insert({
        id: data.user.id,
        email,
        full_name: fullName,
      })
    }
    return data
  },

  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  },

  async signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  },

  async getUser() {
    const { data: { user } } = await supabase.auth.getUser()
    return user
  },

  onAuthChange(callback) {
    return supabase.auth.onAuthStateChange(callback)
  }
}

/* ─── BOTS ────────────────────────────────────────────────────── */
export const Bots = {
  async getAll() {
    const { data, error } = await supabase
      .from('bots')
      .select('*')
      .order('created_at', { ascending: false })
      .range(0, 19)
    if (error) throw error
    return data
  },

  async getOne(id) {
    const { data, error } = await supabase
      .from('bots')
      .select('*, bot_variables(*)')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  async create(bot) {
    const user = await Auth.getUser()
    const { data, error } = await supabase
      .from('bots')
      .insert({ ...bot, user_id: user.id })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async update(id, updates) {
    const { data, error } = await supabase
      .from('bots')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async delete(id) {
    const { error } = await supabase
      .from('bots')
      .delete()
      .eq('id', id)
    if (error) throw error
  },

  async getStats(botId) {
    const [sessions, leads] = await Promise.all([
      supabase.from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('bot_id', botId),
      supabase.from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('bot_id', botId),
    ])

    // Get message count via conversations belonging to this bot
    const { data: convIds } = await supabase
      .from('conversations')
      .select('id')
      .eq('bot_id', botId)

    let messageCount = 0
    if (convIds && convIds.length > 0) {
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .in('conversation_id', convIds.map(c => c.id))
      messageCount = count || 0
    }

    return {
      messages: messageCount,
      sessions: sessions.count || 0,
      leads: leads.count || 0,
    }
  }
}

/* ─── BOT VARIABLES ───────────────────────────────────────────── */
export const BotVariables = {
  async getAll(botId) {
    const { data, error } = await supabase
      .from('bot_variables')
      .select('*')
      .eq('bot_id', botId)
      .order('created_at')
    if (error) throw error
    return data
  },

  async add(botId, variable) {
    const { data, error } = await supabase
      .from('bot_variables')
      .insert({ ...variable, bot_id: botId })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async delete(id) {
    const { error } = await supabase
      .from('bot_variables')
      .delete()
      .eq('id', id)
    if (error) throw error
  }
}

/* ─── KNOWLEDGE BASES ─────────────────────────────────────────── */
export const KnowledgeBases = {
  async getAll() {
    const user = await Auth.getUser()
    const { data, error } = await supabase
      .from('knowledge_bases')
      .select('*, kb_files(count)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(0, 19)
    if (error) throw error
    return data
  },

  async create(name, description) {
    const user = await Auth.getUser()
    const { data, error } = await supabase
      .from('knowledge_bases')
      .insert({ name, description, user_id: user.id })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async delete(id) {
    const { error } = await supabase
      .from('knowledge_bases')
      .delete()
      .eq('id', id)
    if (error) throw error
  },

  async addFile(kbId, file) {
    const { data, error } = await supabase
      .from('kb_files')
      .insert({ ...file, kb_id: kbId })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async getFiles(kbId) {
    const { data, error } = await supabase
      .from('kb_files')
      .select('*')
      .eq('kb_id', kbId)
      .order('created_at', { ascending: false })
      .range(0, 49)
    if (error) throw error
    return data
  },

  async uploadFile(kbId, file) {
    const path = `${kbId}/${Date.now()}_${file.name}`
    const { error: uploadError } = await supabase.storage
      .from('knowledge-files')
      .upload(path, file)
    if (uploadError) throw uploadError

    // Extract text content immediately for plain text files
    // PDF and DOCX will be handled by the processing pipeline later
    let content = null
    const ext = file.name.split('.').pop().toLowerCase()
    if (['txt', 'md', 'csv'].includes(ext)) {
      content = await file.text()
    }
    const status = content ? 'processed' : 'pending'

    return await this.addFile(kbId, {
      name: file.name,
      type: ext,
      size_bytes: file.size,
      storage_path: path,
      content,
      status,
    })
  }
}

/* ─── CONVERSATIONS ───────────────────────────────────────────── */
export const Conversations = {
  async getAll(botId) {
    const { data, error } = await supabase
      .from('conversations')
      .select('*, messages(count)')
      .eq('bot_id', botId)
      .order('updated_at', { ascending: false })
      .range(0, 19)
    if (error) throw error
    return data
  },

  async create(botId, userIdentifier) {
    const { data, error } = await supabase
      .from('conversations')
      .insert({ bot_id: botId, user_id: userIdentifier })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async update(id, updates) {
    const { data, error } = await supabase
      .from('conversations')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async getMessages(conversationId) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at')
      .range(0, 99)
    if (error) throw error
    return data
  },

  async sendMessage(conversationId, role, content) {
    const { data, error } = await supabase
      .from('messages')
      .insert({ conversation_id: conversationId, role, content })
      .select()
      .single()
    if (error) throw error
    return data
  },

  subscribeToMessages(conversationId, callback) {
    return supabase
      .channel(`messages:${conversationId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`
      }, payload => callback(payload.new))
      .subscribe()
  },

  async setHITL(conversationId, active) {
    return await this.update(conversationId, { hitl_active: active })
  }
}

/* ─── LEADS ───────────────────────────────────────────────────── */
export const Leads = {
  async getAll(botId = null) {
    let query = supabase
      .from('leads')
      .select('*, bots(name)')
      .order('created_at', { ascending: false })
      .range(0, 49)
    if (botId) query = query.eq('bot_id', botId)
    const { data, error } = await query
    if (error) throw error
    return data
  },

  async create(lead) {
    const { data, error } = await supabase
      .from('leads')
      .insert(lead)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async update(id, updates) {
    const { data, error } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async delete(id) {
    const { error } = await supabase
      .from('leads')
      .delete()
      .eq('id', id)
    if (error) throw error
  }
}

/* ─── ANALYTICS ───────────────────────────────────────────────── */
export const Analytics = {
  async getSummary(botId = null) {
    const bots = await Bots.getAll();
    const effectiveBotIds = botId ? [botId] : bots.map(b => b.id);
    
    if (effectiveBotIds.length === 0) return {
      totalBots: bots.length,
      totalConversations: 0,
      totalMessages: 0,
      totalLeads: 0,
    };

    const convQuery = supabase.from('conversations')
      .select('id', { count: 'exact', head: true });
    
    if (botId) {
      convQuery.eq('bot_id', botId);
    } else {
      convQuery.in('bot_id', effectiveBotIds);
    }

    const leadQuery = supabase.from('leads')
      .select('id', { count: 'exact', head: true });
    
    if (botId) {
      leadQuery.eq('bot_id', botId);
    } else {
      leadQuery.in('bot_id', effectiveBotIds);
    }

    // Role mapping: we want user messages
    const msgQuery = supabase.from('messages')
      .select('id, conversations!inner(bot_id)', { count: 'exact', head: true })
      .eq('role', 'user');
    
    if (botId) {
      msgQuery.eq('conversations.bot_id', botId);
    }

    const [convs, msgs, leads] = await Promise.all([
      convQuery,
      msgQuery,
      leadQuery
    ]);

    return {
      totalBots: bots.length,
      totalConversations: convs.count || 0,
      totalMessages: msgs.count || 0,
      totalLeads: leads.count || 0,
    };
  }
}
