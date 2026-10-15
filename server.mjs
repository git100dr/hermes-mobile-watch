import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Require dependencies from hermes-web-ui-pereview/node_modules
const pDir = path.resolve(__dirname, '..', 'hermes-web-ui-pereview', 'node_modules')
const require = createRequire(path.join(pDir, 'dummy.js'))
const { io } = require('socket.io-client')
const { WebSocketServer, WebSocket } = require('ws')
const QRCode = require('qrcode')

// Configuration
const CONFIG_FILE = path.join(__dirname, 'config.json')
let config = {
  port: 8649,
  hermesUrl: 'http://127.0.0.1:8648',
  username: 'admin',
  password: '123456',
  ntfyTopic: '', // e.g. "hermes-approval"
  soundAlert: true,
  vibrateAlert: true
}

const EXAMPLE_CONFIG_FILE = path.join(__dirname, 'config.example.json')

if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(EXAMPLE_CONFIG_FILE)) {
  try {
    fs.copyFileSync(EXAMPLE_CONFIG_FILE, CONFIG_FILE)
    console.log('[Config] Initialized config.json from config.example.json')
  } catch {}
}

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    config = { ...config, ...loaded }
  } catch (err) {
    console.warn('[Config] Failed to load config.json, using defaults:', err.message)
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[Config] Failed to save config.json:', err.message)
  }
}

// Database Path
const DB_PATH = process.env.HERMES_DB_PATH || path.resolve(__dirname, '..', 'hermes-web-ui.db')

// Auto-inject Companion Widget into Hermes Web UI client index.html
function ensureWidgetInjected() {
  try {
    const homedir = os.homedir()
    const candidates = new Set()

    const npxDir = path.join(homedir, '.npm', '_npx')
    if (fs.existsSync(npxDir)) {
      const hashes = fs.readdirSync(npxDir)
      for (const h of hashes) {
        const candidate = path.join(npxDir, h, 'node_modules', 'hermes-web-ui', 'dist', 'client', 'index.html')
        if (fs.existsSync(candidate)) {
          candidates.add(candidate)
        }
      }
    }

    const siblingDist = path.resolve(__dirname, '..', 'dist', 'client', 'index.html')
    if (fs.existsSync(siblingDist)) {
      candidates.add(siblingDist)
    }

    const widgetPath = path.join(__dirname, 'public', 'companion-widget.js')
    if (!fs.existsSync(widgetPath)) return
    const widgetCode = fs.readFileSync(widgetPath, 'utf8')
    const markerStart = '<!-- HERMES_WATCH_WIDGET_START -->'
    const markerEnd = '<!-- HERMES_WATCH_WIDGET_END -->'
    const widgetBlock = markerStart + '\n<script>\n' + widgetCode + '\n</script>\n' + markerEnd

    for (const target of candidates) {
      try {
        let html = fs.readFileSync(target, 'utf8')
        if (!html.includes(markerStart)) {
          const backup = target + '.original'
          if (!fs.existsSync(backup)) {
            fs.writeFileSync(backup, html, 'utf8')
          }
          html = html.replace('</body>', widgetBlock + '\n</body>')
          fs.writeFileSync(target, html, 'utf8')
          console.log(`[Widget] Auto-injected companion widget into: ${target}`)
        }
      } catch (e) {
        console.warn(`[Widget] Failed to inject into ${target}:`, e.message)
      }
    }
  } catch (err) {
    console.warn('[Widget] Auto-injection check failed:', err.message)
  }
}

ensureWidgetInjected()

function formatTokens(num) {
  if (num == null) return '0'
  const n = Number(num)
  if (isNaN(n)) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function formatRunSummaryRow(row) {
  if (!row) return null
  const inputTokens = row.input_tokens ?? 0
  const outputTokens = row.output_tokens ?? 0
  const cacheTokens = row.cache_read_tokens ?? 0
  const cacheHitRate = row.cache_hit_rate != null
    ? (Number(row.cache_hit_rate) * 100).toFixed(1) + '%'
    : (inputTokens > 0 && cacheTokens > 0 ? ((cacheTokens / (inputTokens + cacheTokens)) * 100).toFixed(1) + '%' : '--')

  const cost = row.cost_usd != null ? '$' + Number(row.cost_usd).toFixed(4) : '$0.0000'
  const speed = row.tokens_per_second != null && Number(row.tokens_per_second) > 0 ? Number(row.tokens_per_second).toFixed(1) + ' t/s' : '-'

  const fullContent = row.content || ''
  const reasoning = row.reasoning || row.reasoning_content || ''
  const lines = fullContent.split('\n').map(l => l.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()).filter(Boolean)
  const preview = lines[0] ? lines[0].slice(0, 45) : (fullContent.slice(0, 45) || '无正文输出')

  return {
    runId: row.run_id || '',
    messageId: row.assistant_message_id ? String(row.assistant_message_id) : '',
    sessionId: row.session_id,
    sessionTitle: row.session_title || '未命名会话',
    preview,
    completedAt: row.completed_at || (row.msg_timestamp ? row.msg_timestamp * 1000 : Date.now()),
    output: fullContent,
    reasoning,
    stats: {
      outputTokens: formatTokens(outputTokens),
      inputTokens: formatTokens(inputTokens),
      cacheRead: formatTokens(cacheTokens),
      cacheHitRate,
      estimatedCost: cost,
      tokenSpeed: speed,
      raw: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: row.cost_usd ?? 0
      }
    }
  }
}

function getTaskSummaries(limit = 25) {
  try {
    if (!fs.existsSync(DB_PATH)) return []
    const db = new DatabaseSync(DB_PATH, { readOnly: true })

    const rows = db.prepare(`
      SELECT 
        u.session_id, 
        u.run_id, 
        u.assistant_message_id, 
        u.input_tokens, 
        u.output_tokens, 
        u.cache_read_tokens, 
        u.cache_hit_rate, 
        u.cost_usd, 
        u.tokens_per_second, 
        u.completed_at,
        s.title AS session_title,
        m.content,
        m.reasoning,
        m.reasoning_content,
        m.timestamp AS msg_timestamp
      FROM run_usage u
      LEFT JOIN sessions s ON s.id = u.session_id
      LEFT JOIN messages m ON m.id = u.assistant_message_id
      WHERE m.content IS NOT NULL AND trim(m.content) != ''
      ORDER BY u.completed_at DESC
      LIMIT ?
    `).all(limit)

    db.close()
    return rows.map(formatRunSummaryRow).filter(Boolean)
  } catch (err) {
    console.warn('[DB] Failed to getTaskSummaries:', err.message)
    return []
  }
}

function getTaskSummaryByTarget({ runId, messageId, sessionId } = {}) {
  try {
    if (!fs.existsSync(DB_PATH)) return null
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    let row = null
    if (runId) {
      row = db.prepare(`
        SELECT u.*, s.title AS session_title, m.content, m.reasoning, m.reasoning_content, m.timestamp AS msg_timestamp
        FROM run_usage u
        LEFT JOIN sessions s ON s.id = u.session_id
        LEFT JOIN messages m ON m.id = u.assistant_message_id
        WHERE u.run_id = ?
        LIMIT 1
      `).get(runId)
    } else if (messageId) {
      row = db.prepare(`
        SELECT u.*, s.title AS session_title, m.content, m.reasoning, m.reasoning_content, m.timestamp AS msg_timestamp
        FROM run_usage u
        LEFT JOIN sessions s ON s.id = u.session_id
        LEFT JOIN messages m ON m.id = u.assistant_message_id
        WHERE u.assistant_message_id = ?
        LIMIT 1
      `).get(messageId)
    } else if (sessionId) {
      // Prioritize the latest run with non-empty text content
      row = db.prepare(`
        SELECT u.*, s.title AS session_title, m.content, m.reasoning, m.reasoning_content, m.timestamp AS msg_timestamp
        FROM run_usage u
        LEFT JOIN sessions s ON s.id = u.session_id
        LEFT JOIN messages m ON m.id = u.assistant_message_id
        WHERE u.session_id = ? AND m.content IS NOT NULL AND trim(m.content) != ''
        ORDER BY u.completed_at DESC
        LIMIT 1
      `).get(sessionId)

      // Fallback: If no run_usage had non-empty text, get the latest row
      if (!row) {
        row = db.prepare(`
          SELECT u.*, s.title AS session_title, m.content, m.reasoning, m.reasoning_content, m.timestamp AS msg_timestamp
          FROM run_usage u
          LEFT JOIN sessions s ON s.id = u.session_id
          LEFT JOIN messages m ON m.id = u.assistant_message_id
          WHERE u.session_id = ?
          ORDER BY u.completed_at DESC
          LIMIT 1
        `).get(sessionId)
      }
    }

    if (!row && !sessionId && !runId && !messageId) {
      row = db.prepare(`
        SELECT u.*, s.title AS session_title, m.content, m.reasoning, m.reasoning_content, m.timestamp AS msg_timestamp
        FROM run_usage u
        LEFT JOIN sessions s ON s.id = u.session_id
        LEFT JOIN messages m ON m.id = u.assistant_message_id
        WHERE m.content IS NOT NULL AND trim(m.content) != ''
        ORDER BY u.completed_at DESC
        LIMIT 1
      `).get()
      if (!row) {
        row = db.prepare(`
          SELECT u.*, s.title AS session_title, m.content, m.reasoning, m.reasoning_content, m.timestamp AS msg_timestamp
          FROM run_usage u
          LEFT JOIN sessions s ON s.id = u.session_id
          LEFT JOIN messages m ON m.id = u.assistant_message_id
          ORDER BY u.completed_at DESC
          LIMIT 1
        `).get()
      }
    }

    // If row still has no content, try to find the latest non-empty assistant message in the same session
    if (row && (!row.content || !row.content.trim()) && row.session_id) {
      try {
        const fallbackMsg = db.prepare(`
          SELECT content, reasoning, reasoning_content, timestamp AS msg_timestamp
          FROM messages
          WHERE session_id = ? AND role = 'assistant' AND content IS NOT NULL AND trim(content) != ''
          ORDER BY timestamp DESC, id DESC
          LIMIT 1
        `).get(row.session_id)
        if (fallbackMsg) {
          row.content = fallbackMsg.content
          row.reasoning = fallbackMsg.reasoning
          row.reasoning_content = fallbackMsg.reasoning_content
          row.msg_timestamp = fallbackMsg.msg_timestamp
        }
      } catch (err) {
        // quiet
      }
    }

    db.close()
    return formatRunSummaryRow(row)
  } catch (err) {
    console.warn('[DB] Failed to getTaskSummaryByTarget:', err.message)
    return null
  }
}

function getLatestTaskSummary(sessionId) {
  return getTaskSummaryByTarget({ sessionId })
}

function getRecentSessions(limit = 15) {
  try {
    if (!fs.existsSync(DB_PATH)) return []
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const rows = db.prepare(`
      SELECT id, title, profile, last_active, model
      FROM sessions
      ORDER BY last_active DESC
      LIMIT ?
    `).all(limit)
    db.close()
    return rows
  } catch (err) {
    console.warn('[DB] Failed to getRecentSessions:', err.message)
    return []
  }
}

function getSessionMessages(sessionId, limit = 25) {
  try {
    if (!fs.existsSync(DB_PATH) || !sessionId) return []
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const rows = db.prepare(`
      SELECT id, role, content, reasoning, timestamp
      FROM messages
      WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL AND trim(content) != ''
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(sessionId, limit)
    db.close()
    return rows.reverse()
  } catch (err) {
    console.warn('[DB] Failed to getSessionMessages:', err.message)
    return []
  }
}

function getSessionProfile(sessionId) {
  try {
    if (!fs.existsSync(DB_PATH) || !sessionId) return 'default'
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const row = db.prepare('SELECT profile FROM sessions WHERE id = ? LIMIT 1').get(sessionId)
    db.close()
    return row?.profile || 'default'
  } catch (err) {
    return 'default'
  }
}

// Dynamic LAN IP Detection with PowerShell fallback
let cachedHostLanIp = null
function detectHostLanIp() {
  try {
    const isWsl = fs.existsSync('/proc/sys/fs/binfmt_misc/WSL') || Boolean(process.env.WSL_DISTRO_NAME)
    if (!isWsl) return null
    const { execSync } = createRequire(import.meta.url)('node:child_process')
    const psCmd = `powershell.exe -NoProfile -NonInteractive -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or ($_.IPAddress -like '10.*' -and $_.IPAddress -notlike '10.255.*') } | Select-Object -ExpandProperty IPAddress)[0]"`
    const out = execSync(psCmd, { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out)) {
      cachedHostLanIp = out
      return out
    }
  } catch {}
  return null
}
setTimeout(detectHostLanIp, 1200)

function getLanIp() {
  if (cachedHostLanIp) return cachedHostLanIp
  const ifaces = os.networkInterfaces()
  const candidates = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const ip = addr.address
        // Exclude virtual/tunnel/loopback interfaces (e.g. Clash TUN 198.18.x, WSL internal 10.255.x)
        if (!ip.startsWith('198.18.') && !ip.startsWith('10.255.') && !ip.startsWith('127.')) {
          candidates.push({ name, address: ip })
        }
      }
    }
  }
  const best = candidates.find(c => c.address.startsWith('192.168.')) ||
               candidates.find(c => c.address.startsWith('10.')) ||
               candidates.find(c => c.address.startsWith('172.') && !c.address.startsWith('172.17.') && !c.address.startsWith('172.18.')) ||
               candidates[0] || { address: 'localhost' }
  return best.address
}

function getLanUrl() {
  return `http://${getLanIp()}:${config.port}`
}

// Dangerous Command Filter & Auto-Approve Circuit Breaker
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\s+([/~]|\$HOME|\.\.)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\bchmod\s+(-R\s+)?777\s+([/~]|\/etc|\/usr)/i,
  /\b(shutdown|reboot|init\s+0)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bcurl\s+.*\|\s*(ba)?sh\b/i
]

function isDangerousCommand(command = '') {
  if (!command) return false
  return DANGEROUS_COMMAND_PATTERNS.some(p => p.test(command))
}

const autoApproveTimestamps = []
const CIRCUIT_BREAKER_MAX_PER_MINUTE = 12

function checkAutoApproveCircuitBreaker() {
  const now = Date.now()
  while (autoApproveTimestamps.length > 0 && (now - autoApproveTimestamps[0] > 60000)) {
    autoApproveTimestamps.shift()
  }
  if (autoApproveTimestamps.length >= CIRCUIT_BREAKER_MAX_PER_MINUTE) {
    return false
  }
  autoApproveTimestamps.push(now)
  return true
}

// State
let hermesToken = null
let chatRunSocket = null
let isHermesConnected = false
let autoApproveEnabled = Boolean(config.autoApprove?.enabled ?? config.autoApprove ?? false)
let autoApproveSessionId = autoApproveEnabled ? (config.autoApprove?.sessionId || '*') : null

function setAutoApproveState(enabled, sessionId = '*') {
  autoApproveEnabled = Boolean(enabled)
  autoApproveSessionId = enabled ? (sessionId || '*') : null
  config.autoApprove = {
    enabled: autoApproveEnabled,
    sessionId: autoApproveSessionId
  }
  saveConfig()
  console.log(`[Auto-Approve] Setting auto-approve: enabled=${autoApproveEnabled}, sessionId=${autoApproveSessionId}`)
  appendLog('system', autoApproveEnabled 
    ? `⚡ 已开启自动审批托管 (范围: ${autoApproveSessionId === '*' ? '全局所有会话' : autoApproveSessionId})` 
    : '🛑 已关闭自动审批托管'
  )
  broadcast({
    type: 'auto_approve_changed',
    enabled: autoApproveEnabled,
    sessionId: autoApproveSessionId
  })
}

const activeApprovals = new Map() // approval_id -> details
const activeClarifies = new Map() // clarify_id -> details
const recentApprovalRequests = new Map() // approval_id -> timestamp
const recentResolvedApprovals = new Map() // approval_id -> timestamp
const recentClarifyRequests = new Map() // clarify_id -> timestamp
const sessionRunDebounceTimers = new Map() // sessionId -> timer
const recentBroadcastRuns = new Map() // sessionId -> { key, time }
const sessionLastNotifiedTime = new Map() // sessionId -> timestamp
const sessionUserPromptTime = new Map() // sessionId -> timestamp
const recentLogs = [] // max 60 log items: { timestamp, type, text, sessionId }
const joinedSessions = new Set()
const mobileSockets = new Set()
let latestCompletion = getLatestTaskSummary()
let currentRunningSessionId = null
const activeSessionsMap = new Map() // sessionId -> { sessionId, title, thought, status, startTime, lastUpdate }

function getSessionTitleById(sid) {
  try {
    const list = getRecentSessions(50)
    const found = list.find(s => s.id === sid)
    if (found?.title) return found.title
  } catch {}
  return sid
}

function appendLog(type, text, sessionId = '') {
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    type,
    text: String(text).slice(0, 500),
    sessionId
  }
  recentLogs.push(item)
  if (recentLogs.length > 60) recentLogs.shift()
  broadcast({ type: 'log', item })
}

function broadcast(msg) {
  const payload = JSON.stringify(msg)
  for (const client of mobileSockets) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload) } catch {}
    }
  }
}

// Obtain or refresh Hermes Token
async function loginToHermes() {
  try {
    const res = await fetch(`${config.hermesUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: config.username, password: config.password })
    })
    if (!res.ok) {
      throw new Error(`Login failed with status ${res.status}: ${await res.text()}`)
    }
    const data = await res.json()
    hermesToken = data.token
    return hermesToken
  } catch (err) {
    console.error('[Hermes Auth] Login error:', err.message)
    return null
  }
}

// Fetch active sessions and join them
async function syncSessions() {
  if (!hermesToken || !chatRunSocket?.connected) return
  try {
    const res = await fetch(`${config.hermesUrl}/api/hermes/sessions`, {
      headers: { Authorization: `Bearer ${hermesToken}` }
    })
    if (!res.ok) return
    const data = await res.json()
    const sessions = data.sessions || []
    for (const session of sessions.slice(0, 15)) {
      if (!joinedSessions.has(session.id)) {
        joinedSessions.add(session.id)
        chatRunSocket.emit('resume', { session_id: session.id })
      }
    }
  } catch (err) {
    // quiet
  }
}

// Connect to Hermes Socket.IO
async function connectToHermes() {
  const token = await loginToHermes()
  if (!token) {
    console.log('[Hermes Socket] Retrying login in 5s...')
    setTimeout(connectToHermes, 5000)
    return
  }

  // Connect to /chat-run
  if (chatRunSocket) {
    chatRunSocket.removeAllListeners()
    chatRunSocket.disconnect()
  }

  chatRunSocket = io(`${config.hermesUrl}/chat-run`, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 2000,
  })

  chatRunSocket.on('connect', () => {
    isHermesConnected = true
    joinedSessions.clear()
    console.log('[Hermes Socket] Connected to /chat-run')
    appendLog('system', '已成功连接至 Hermes Agent 核心服务')
    broadcast({ type: 'status', hermesConnected: true })
    syncSessions()
  })

  chatRunSocket.on('disconnect', () => {
    isHermesConnected = false
    joinedSessions.clear()
    console.log('[Hermes Socket] Disconnected from /chat-run')
    appendLog('system', '与 Hermes Agent 核心连接中断，尝试重连中...')
    broadcast({ type: 'status', hermesConnected: false })
  })

  chatRunSocket.on('approval.requested', (data) => {
    if (!data || !data.approval_id) return
    console.log('[Approval] Received approval.requested:', data.approval_id, data.command)

    // Deduplicate approval.requested events
    const now = Date.now()
    const lastSeen = recentApprovalRequests.get(data.approval_id)
    if (lastSeen && (now - lastSeen < 25000)) {
      console.log('[Approval] Suppressing duplicate approval.requested:', data.approval_id)
      return
    }
    recentApprovalRequests.set(data.approval_id, now)
    if (recentApprovalRequests.size > 200) {
      for (const [k, v] of recentApprovalRequests) {
        if (now - v > 60000) recentApprovalRequests.delete(k)
      }
    }

    // Check if auto-approve is active
    if (autoApproveEnabled && (!autoApproveSessionId || autoApproveSessionId === '*' || autoApproveSessionId === data.session_id || !data.session_id)) {
      const isDangerous = isDangerousCommand(data.command)
      const canProceed = checkAutoApproveCircuitBreaker()

      if (isDangerous) {
        console.warn(`[Auto-Approve] 🛑 Blocked dangerous command from auto-approval: ${data.command}`)
        appendLog('error', `🛡️ [安全拦截] 命令命中高危规则，阻断自动放行，转人工确认: ${data.command}`, data.session_id)
        if (config.ntfyTopic) {
          sendNtfyNotification({
            title: '🚨 Hermes 高危命令拦截',
            body: `命令命中安全拦截规则，已阻断自动放行，需人工审批：\n${data.command}`,
            priority: 5,
            tags: ['rotating_light', 'warning']
          })
        }
      } else if (!canProceed) {
        console.warn(`[Auto-Approve] 🚨 Circuit breaker tripped! > ${CIRCUIT_BREAKER_MAX_PER_MINUTE} approvals in 1 min. Disabling auto-approve.`)
        setAutoApproveState(false)
        appendLog('error', `🚨 [熔断报警] 1分钟内自动审批超过 ${CIRCUIT_BREAKER_MAX_PER_MINUTE} 次，已暂停自动放行！`, data.session_id)
        if (config.ntfyTopic) {
          sendNtfyNotification({
            title: '🚨 自动审批频次熔断',
            body: `1分钟内自动审批超 ${CIRCUIT_BREAKER_MAX_PER_MINUTE} 次，已自动暂停托管，请检查 Agent 任务！`,
            priority: 5,
            tags: ['fire', 'warning']
          })
        }
      } else {
        console.log(`[Approval] ⚡ Auto-approving request: ${data.approval_id} for session: ${data.session_id || 'global'}`)
        appendLog('approval.auto', `🤖 [自动审批] 已为会话自动放行命令: ${data.command || data.description}`, data.session_id)
        chatRunSocket.emit('approval.respond', {
          session_id: data.session_id,
          approval_id: data.approval_id,
          choice: 'always'
        })
        broadcast({
          type: 'approval.auto_resolved',
          session_id: data.session_id,
          approval_id: data.approval_id,
          command: data.command,
          description: data.description
        })
        return
      }
    }

    activeApprovals.set(data.approval_id, {
      ...data,
      receivedAt: Date.now()
    })
    appendLog('approval', `需要审批命令: ${data.command || data.description}`, data.session_id)
    broadcast({ type: 'approval.requested', approval: data })

    if (config.ntfyTopic) {
      sendNtfyNotification({
        title: '⚠️ Hermes Agent 待审批命令',
        body: `命令: ${data.command || '无'}\n原因: ${data.description || '无'}`,
        priority: 5,
        tags: ['warning', 'lock'],
        actions: [
          { action: 'view', label: '🔍 立即审批', url: `${getLanUrl()}?approval=${data.approval_id}` }
        ]
      })
    }

    triggerWindowsNativeAlert({
      title: '⚠️ Hermes Agent 待审批命令',
      message: `待执行命令: ${data.command || '无'}\n说明: ${data.description || '无'}`,
      url: `${config.hermesUrl}/#${data.session_id ? '/hermes/session/' + data.session_id : '/hermes/chat'}`
    })
  })

  chatRunSocket.on('approval.resolved', (data) => {
    if (!data || !data.approval_id) return
    console.log('[Approval] Received approval.resolved:', data.approval_id, data.choice)
    const now = Date.now()
    const lastResolved = recentResolvedApprovals.get(data.approval_id)
    if (lastResolved && (now - lastResolved < 25000)) {
      return
    }
    recentResolvedApprovals.set(data.approval_id, now)
    if (recentResolvedApprovals.size > 200) {
      for (const [k, v] of recentResolvedApprovals) {
        if (now - v > 60000) recentResolvedApprovals.delete(k)
      }
    }

    activeApprovals.delete(data.approval_id)
    appendLog('approval.resolved', `审批已完成: ${data.choice}`, data.session_id)
    broadcast({ type: 'approval.resolved', approval_id: data.approval_id, choice: data.choice })
  })

  chatRunSocket.on('clarify.requested', (data) => {
    if (!data || !data.clarify_id) return
    console.log('[Clarify] Received clarify.requested:', data.clarify_id, data.question)
    const now = Date.now()
    const lastSeen = recentClarifyRequests.get(data.clarify_id)
    if (lastSeen && (now - lastSeen < 25000)) {
      console.log('[Clarify] Suppressing duplicate clarify.requested:', data.clarify_id)
      return
    }
    recentClarifyRequests.set(data.clarify_id, now)
    if (recentClarifyRequests.size > 200) {
      for (const [k, v] of recentClarifyRequests) {
        if (now - v > 60000) recentClarifyRequests.delete(k)
      }
    }

    activeClarifies.set(data.clarify_id, {
      ...data,
      receivedAt: Date.now()
    })
    appendLog('clarify', `待确认问题: ${data.question}`, data.session_id)
    broadcast({ type: 'clarify.requested', clarify: data })

    if (config.ntfyTopic) {
      sendNtfyNotification({
        title: '❓ Hermes Agent 待回答选择',
        body: `问题: ${data.question}`,
        priority: 4,
        tags: ['question', 'speech_balloon'],
        actions: [
          { action: 'view', label: '✍️ 立即回答', url: getLanUrl() }
        ]
      })
    }

    triggerWindowsNativeAlert({
      title: '❓ Hermes Agent 待确认选择',
      message: `问题: ${data.question || 'Agent 提问决策'}\n选项: ${(data.choices || []).join(' / ') || '自由输入回答'}`,
      url: `${config.hermesUrl}/#${data.session_id ? '/hermes/session/' + data.session_id : '/hermes/chat'}`
    })
  })

  chatRunSocket.on('clarify.resolved', (data) => {
    console.log('[Clarify] Received clarify.resolved:', data.clarify_id)
    activeClarifies.delete(data.clarify_id)
    appendLog('clarify.resolved', '用户已回答问题', data.session_id)
    broadcast({ type: 'clarify.resolved', clarify_id: data.clarify_id })
  })

  const handleDelta = (data) => {
    const text = data?.delta || data?.text
    if (text) {
      appendLog('delta', text, data.session_id)
      broadcast({ type: 'chat.delta', session_id: data.session_id, delta: text })
    }
  }
  chatRunSocket.on('chat.delta', handleDelta)
  chatRunSocket.on('message.delta', handleDelta)

  const handleThought = (data) => {
    const thought = data?.thought || data?.text || data?.delta
    const sid = data?.session_id
    if (thought) {
      appendLog('thought', thought, sid)
      if (sid) {
        let entry = activeSessionsMap.get(sid)
        if (!entry) {
          entry = {
            sessionId: sid,
            title: getSessionTitleById(sid),
            startTime: Date.now()
          }
        }
        if (entry.title === sid) {
          entry.title = getSessionTitleById(sid)
        }
        entry.thought = String(thought).replace(/\n/g, ' ').slice(0, 150)
        entry.status = 'thinking'
        entry.lastUpdate = Date.now()
        activeSessionsMap.set(sid, entry)
      }
      broadcast({
        type: 'chat.thought',
        session_id: sid,
        thought,
        activeSessions: Array.from(activeSessionsMap.values())
      })
    }
  }
  chatRunSocket.on('agent.thought', handleThought)
  chatRunSocket.on('reasoning.delta', handleThought)
  chatRunSocket.on('thinking.delta', handleThought)

  chatRunSocket.on('run.started', (data) => {
    const sid = data?.session_id
    console.log('[Hermes Socket] Received run.started:', sid)
    currentRunningSessionId = sid || null
    if (sid) {
      activeSessionsMap.set(sid, {
        sessionId: sid,
        title: getSessionTitleById(sid),
        thought: 'AI 正在准备执行...',
        status: 'running',
        startTime: Date.now(),
        lastUpdate: Date.now()
      })
    }
    appendLog('system', '⚡ Agent 已开始处理指令...', sid)
    broadcast({
      type: 'run.started',
      session_id: sid,
      activeSessions: Array.from(activeSessionsMap.values())
    })
  })

  chatRunSocket.on('run.failed', (data) => {
    if (currentRunningSessionId === data?.session_id) {
      currentRunningSessionId = null
    }
    if (data?.session_id) {
      activeSessionsMap.delete(data.session_id)
    }
    appendLog('error', `运行异常: ${data.error}`, data.session_id)
    broadcast({
      type: 'run.failed',
      session_id: data.session_id,
      error: data.error,
      activeSessions: Array.from(activeSessionsMap.values())
    })
  })

  chatRunSocket.on('run.completed', (data) => {
    const sessionId = data.session_id || 'default'
    console.log('[Hermes Socket] Received run.completed event:', sessionId)
    if (currentRunningSessionId === sessionId) {
      currentRunningSessionId = null
    }
    activeSessionsMap.delete(sessionId)

    // Debounce rapid intermediate tool turns (2500ms trailing debounce per session)
    if (sessionRunDebounceTimers.has(sessionId)) {
      clearTimeout(sessionRunDebounceTimers.get(sessionId))
    }

    const timer = setTimeout(() => {
      sessionRunDebounceTimers.delete(sessionId)

      // 1. If this session currently has active approvals or clarifies pending, it is not finished!
      const hasPendingApproval = Array.from(activeApprovals.values()).some(a => a.session_id === sessionId)
      const hasPendingClarify = Array.from(activeClarifies.values()).some(c => c.session_id === sessionId)
      if (hasPendingApproval || hasPendingClarify) {
        console.log('[Hermes Socket] Session has pending approval/clarify, suppressing completion push:', sessionId)
        return
      }

      const summary = getLatestTaskSummary(sessionId)
      const now = Date.now()

      // 2. Only broadcast run.completed and push ntfy if we actually have text output!
      if (summary && summary.output && summary.output.trim() && summary.output !== '(无正文输出)') {
        const lastNotified = sessionLastNotifiedTime.get(sessionId) || 0
        const lastPrompt = sessionUserPromptTime.get(sessionId) || 0

        // If we already sent notification for this session within 10s and no new user prompt occurred, skip repeat push
        if (now - lastNotified < 10000 && lastPrompt <= lastNotified) {
          console.log('[Hermes Socket] Suppressing duplicate completion push within 10s window for session:', sessionId)
          latestCompletion = summary
          broadcast({
            type: 'run.completed_silent',
            summary,
            allSummaries: getTaskSummaries(25),
            activeSessions: Array.from(activeSessionsMap.values())
          })
          return
        }

        sessionLastNotifiedTime.set(sessionId, now)
        latestCompletion = summary
        const allSummaries = getTaskSummaries(25)
        broadcast({
          type: 'run.completed',
          summary,
          allSummaries,
          activeSessions: Array.from(activeSessionsMap.values())
        })
        appendLog('complete', `✅ 任务执行完毕 (输出: ${summary.stats.outputTokens}, 费用: ${summary.stats.estimatedCost})`, sessionId)

        if (config.ntfyTopic) {
          sendNtfyNotification({
            title: `✅ [${summary.sessionTitle || 'Hermes'}] 任务完成`,
            body: `输出: ${summary.stats.outputTokens} | 费用: ${summary.stats.estimatedCost}\n\n${(summary.preview || summary.output || '').slice(0, 120)}...`,
            priority: 3,
            tags: ['tada', 'white_check_mark'],
            actions: [
              { 
                action: 'view', 
                label: '📊 查看此条回复', 
                url: `${getLanUrl()}?session=${sessionId}&msg=${summary.messageId || ''}&run=${summary.runId || ''}` 
              }
            ]
          })
        }
      } else {
        // Intermediate tool turn or empty output: only silent broadcast for stats, do NOT trigger false complete notification
        console.log('[Hermes Socket] Intermediate turn completed for session (no text output yet):', sessionId)
        broadcast({ type: 'run.stage_completed', session_id: sessionId, allSummaries: getTaskSummaries(25) })
      }
    }, 2500)

    sessionRunDebounceTimers.set(sessionId, timer)
  })

  // Periodically re-sync sessions
  setInterval(syncSessions, 15000)
}

// Optional ntfy push helper (JSON payload, unicode safe)
async function sendNtfyNotification({ title, body, actions = [], priority = 4, tags = ['robot'] }) {
  if (!config.ntfyTopic) return
  try {
    const payload = {
      topic: config.ntfyTopic,
      title: title || 'Hermes 通知',
      message: body || '',
      priority,
      tags,
      actions
    }
    const res = await fetch('https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      console.warn('[ntfy] Push failed with status:', res.status)
    } else {
      console.log('[ntfy] Push notification sent to topic:', config.ntfyTopic)
    }
  } catch (err) {
    console.warn('[ntfy] Push failed:', err.message)
  }
}

// Windows Host Native Topmost Alert (via WSL2 interop)
function triggerWindowsNativeAlert({ title = '⚠️ Hermes 待审批命令', message = '', url = 'http://localhost:8648' } = {}) {
  try {
    const isWsl = fs.existsSync('/proc/sys/fs/binfmt_misc/WSL') || Boolean(process.env.WSL_DISTRO_NAME);
    if (!isWsl) return;

    const safeTitle = String(title).replace(/["'`$]/g, ' ');
    const safeMsg = String(message).replace(/["'`$]/g, ' ');
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $msg = "${safeMsg}\`n\`n点击【确定】立即打开浏览器审批，点击【取消】稍后处理。"
      $res = [System.Windows.Forms.MessageBox]::Show($msg, "${safeTitle}", [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button1, [System.Windows.Forms.MessageBoxOptions]::ServiceNotification)
      if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
        Start-Process "${url}"
      }
    `;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    console.log('[Windows Alert] Dispatched Windows native Topmost MessageBox');
  } catch (err) {
    console.warn('[Windows Alert] Trigger error:', err.message);
  }
}

// HTTP Server
const publicDir = path.join(__dirname, 'public')

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  // API Endpoints
  if (url.pathname === '/api/info') {
    const curIp = getLanIp()
    const targetSession = url.searchParams.get('session')
    let curLanUrl = `http://${curIp}:${config.port}`
    if (targetSession) {
      curLanUrl += `?session=${encodeURIComponent(targetSession)}`
    }
    let qrDataUrl = ''
    try {
      qrDataUrl = await QRCode.toDataURL(curLanUrl, { margin: 2, scale: 6 })
    } catch {}

    const ntfyUrl = config.ntfyTopic ? `https://ntfy.sh/${config.ntfyTopic}` : ''
    let ntfyQrDataUrl = ''
    if (ntfyUrl) {
      try {
        ntfyQrDataUrl = await QRCode.toDataURL(ntfyUrl, { margin: 2, scale: 6 })
      } catch {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      lanIp: curIp,
      port: config.port,
      lanUrl: curLanUrl,
      hermesUrl: config.hermesUrl,
      hermesConnected: isHermesConnected,
      autoApprove: {
        enabled: autoApproveEnabled,
        sessionId: autoApproveSessionId
      },
      activeApprovalsCount: activeApprovals.size,
      activeClarifiesCount: activeClarifies.size,
      connectedMobileClients: mobileSockets.size,
      qrDataUrl,
      ntfyTopic: config.ntfyTopic,
      ntfyUrl,
      ntfyQrDataUrl
    }))
    return
  }

  if (url.pathname === '/api/auto-approve') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        enabled: autoApproveEnabled,
        sessionId: autoApproveSessionId
      }))
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const { enabled, sessionId } = JSON.parse(body || '{}')
          setAutoApproveState(enabled, sessionId)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, enabled: autoApproveEnabled, sessionId: autoApproveSessionId }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }
  }

  if (url.pathname === '/api/test-ntfy' && req.method === 'POST') {
    if (!config.ntfyTopic) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'ntfyTopic 未配置' }))
      return
    }
    await sendNtfyNotification({
      title: '🔔 Hermes 伴侣测试通知',
      body: '测试成功！手机锁屏黑屏、放裤兜里也能正常弹出此通知。点击下方按钮可直达看护页。',
      priority: 4,
      tags: ['bell', 'tada'],
      actions: [
        { action: 'view', label: '📱 打开看护页', url: getLanUrl() }
      ]
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true, topic: config.ntfyTopic }))
    return
  }

  if (url.pathname === '/api/test-windows-alert' && req.method === 'POST') {
    triggerWindowsNativeAlert({
      title: '🔔 Hermes Windows 原生弹窗测试成功！',
      message: '这是 Windows 系统的原生置顶弹窗！\\n不受 Chrome 通知设置与免打扰影响。\\n点击【确定】将立即唤醒并打开浏览器 Hermes Web UI。',
      url: 'http://localhost:8648'
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    return
  }

  if (url.pathname === '/api/summaries') {
    const list = getTaskSummaries(25)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(list))
    return
  }

  if (url.pathname === '/api/summary') {
    const runId = url.searchParams.get('run')
    const messageId = url.searchParams.get('msg')
    const sessionId = url.searchParams.get('session')
    const summary = getTaskSummaryByTarget({ runId, messageId, sessionId })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(summary || {}))
    return
  }

  if (url.pathname === '/api/approval/respond' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const { session_id, approval_id, choice } = JSON.parse(body)
        if (!approval_id || !choice) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing approval_id or choice' }))
          return
        }

        console.log(`[Approval Respond] Submitting choice: ${choice} for approval: ${approval_id}`)
        if (chatRunSocket?.connected) {
          chatRunSocket.emit('approval.respond', {
            session_id,
            approval_id,
            choice
          })
        }

        activeApprovals.delete(approval_id)
        broadcast({ type: 'approval.resolved', approval_id, choice })
        broadcast({ type: 'execute_native_approval', session_id, approval_id, choice })
        appendLog('approval.resolved', `已提交审批选择: ${choice}`, session_id)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, choice }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  if (url.pathname === '/api/clarify/respond' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const { session_id, clarify_id, response: userResp } = JSON.parse(body)
        if (!clarify_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing clarify_id' }))
          return
        }

        console.log(`[Clarify Respond] Submitting response for clarify: ${clarify_id}`)
        if (chatRunSocket?.connected) {
          chatRunSocket.emit('clarify.respond', {
            session_id,
            clarify_id,
            response: userResp || ''
          })
        }

        activeClarifies.delete(clarify_id)
        broadcast({ type: 'clarify.resolved', clarify_id })
        appendLog('clarify.resolved', `已提交澄清答案: ${userResp}`, session_id)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  if (url.pathname === '/api/qr') {
    try {
      const targetSession = url.searchParams.get('session')
      let curLanUrl = getLanUrl()
      if (targetSession) {
        curLanUrl += `?session=${encodeURIComponent(targetSession)}`
      }
      const qrDataUrl = await QRCode.toDataURL(curLanUrl, { margin: 2, scale: 8 })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ qr: qrDataUrl, url: curLanUrl }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  if (url.pathname === '/api/sessions') {
    const rawSessions = getRecentSessions(20)
    const sessions = rawSessions.map(s => {
      const active = activeSessionsMap.get(s.id)
      return {
        ...s,
        is_active: Boolean(active),
        thought: active?.thought || ''
      }
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(sessions))
    return
  }

  if (url.pathname === '/api/chat/messages' || url.pathname === '/api/chat/history') {
    const sid = url.searchParams.get('session') || latestCompletion?.sessionId || getRecentSessions(1)[0]?.id
    const limit = Math.min(100, Math.max(10, parseInt(url.searchParams.get('limit') || '60', 10)))
    const messages = getSessionMessages(sid, limit)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ session_id: sid, messages }))
    return
  }

  if (url.pathname === '/api/chat/send' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const { session_id, message, profile } = JSON.parse(body || '{}')
        if (!message || !message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '消息内容不能为空' }))
          return
        }
        if (!chatRunSocket?.connected) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Hermes Agent 核心服务尚未连接' }))
          return
        }

        const sid = session_id || latestCompletion?.sessionId || getRecentSessions(1)[0]?.id
        if (!sid) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '未找到有效会话 ID' }))
          return
        }

        const prof = profile || getSessionProfile(sid)
        const text = message.trim()

        console.log(`[Chat Send] User sending prompt to session ${sid} (profile: ${prof}): "${text.slice(0, 60)}"`)
        sessionUserPromptTime.set(sid, Date.now())

        // Join room & emit run
        chatRunSocket.emit('resume', { session_id: sid })
        chatRunSocket.emit('run', {
          input: text,
          session_id: sid,
          profile: prof,
          source: 'cli'
        })

        appendLog('user', `💬 用户指令: ${text}`, sid)
        broadcast({
          type: 'chat.user_message',
          session_id: sid,
          message: text,
          timestamp: Date.now()
        })

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, session_id: sid }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  if (url.pathname === '/api/chat/abort' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const { session_id } = JSON.parse(body || '{}')
        const sid = session_id || latestCompletion?.sessionId
        if (sid && chatRunSocket?.connected) {
          console.log(`[Chat Abort] User requested abort for session: ${sid}`)
          chatRunSocket.emit('abort', { session_id: sid })
          activeSessionsMap.delete(sid)
          if (currentRunningSessionId === sid) {
            currentRunningSessionId = null
          }
          appendLog('system', '⏹️ 用户请求终止当前任务', sid)
          broadcast({
            type: 'chat.aborted',
            session_id: sid,
            activeSessions: Array.from(activeSessionsMap.values())
          })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, session_id: sid }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // Static files in /public
  let filePath = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname)
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  // Fallback to index.html for client-side routing
  const indexPath = path.join(publicDir, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    fs.createReadStream(indexPath).pipe(res)
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

// WebSocket Server for Mobile clients
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  mobileSockets.add(ws)
  console.log(`[Mobile WS] Client connected (Total: ${mobileSockets.size})`)

  // Send initial snapshot including latestCompletion
  ws.send(JSON.stringify({
    type: 'init',
    lanIp: getLanIp(),
    lanUrl: getLanUrl(),
    autoApprove: {
      enabled: Boolean(autoApproveSessionId),
      sessionId: autoApproveSessionId
    },
    hermesConnected: isHermesConnected,
    approvals: Array.from(activeApprovals.values()),
    clarifies: Array.from(activeClarifies.values()),
    runningSessionId: currentRunningSessionId,
    activeSessions: Array.from(activeSessionsMap.values()),
    logs: recentLogs.slice(-30),
    latestCompletion: latestCompletion || getLatestTaskSummary(),
    allSummaries: getTaskSummaries(25),
    recentSessions: getRecentSessions(20)
  }))

  ws.on('close', () => {
    mobileSockets.delete(ws)
    console.log(`[Mobile WS] Client disconnected (Total: ${mobileSockets.size})`)
  })

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString())
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', time: Date.now() }))
      } else if (data.type === 'chat.send') {
        const { session_id, message: chatMsg, profile } = data
        if (chatMsg && chatMsg.trim() && chatRunSocket?.connected) {
          const sid = session_id || latestCompletion?.sessionId || getRecentSessions(1)[0]?.id
          if (sid) {
            const prof = profile || getSessionProfile(sid)
            const text = chatMsg.trim()
            console.log(`[WS Chat Send] Prompt to session ${sid} (${prof}): "${text.slice(0, 50)}"`)
            sessionUserPromptTime.set(sid, Date.now())
            chatRunSocket.emit('resume', { session_id: sid })
            chatRunSocket.emit('run', {
              input: text,
              session_id: sid,
              profile: prof,
              source: 'cli'
            })
            appendLog('user', `💬 用户指令: ${text}`, sid)
            broadcast({
              type: 'chat.user_message',
              session_id: sid,
              message: text,
              timestamp: Date.now()
            })
          }
        }
      } else if (data.type === 'chat.abort') {
        const sid = data.session_id || latestCompletion?.sessionId
        if (sid && chatRunSocket?.connected) {
          chatRunSocket.emit('abort', { session_id: sid })
          activeSessionsMap.delete(sid)
          if (currentRunningSessionId === sid) {
            currentRunningSessionId = null
          }
          appendLog('system', '⏹️ 用户请求终止当前任务', sid)
          broadcast({
            type: 'chat.aborted',
            session_id: sid,
            activeSessions: Array.from(activeSessionsMap.values())
          })
        }
      } else if (data.type === 'approval.respond') {
        const { session_id, approval_id, choice } = data
        if (approval_id && choice) {
          console.log(`[WS Approval] Submitting choice: ${choice} for approval: ${approval_id}`)
          if (chatRunSocket?.connected) {
            chatRunSocket.emit('approval.respond', { session_id, approval_id, choice })
          }
          activeApprovals.delete(approval_id)
          broadcast({ type: 'approval.resolved', approval_id, choice })
          broadcast({ type: 'execute_native_approval', session_id, approval_id, choice })
          appendLog('approval.resolved', `已通过客户端提交审批: ${choice}`, session_id)
          ws.send(JSON.stringify({ type: 'approval.response_ack', approval_id, success: true }))
        }
      } else if (data.type === 'clarify.respond') {
        const { session_id, clarify_id, response: userResp } = data
        if (clarify_id) {
          console.log(`[WS Clarify] Submitting response for clarify: ${clarify_id}`)
          if (chatRunSocket?.connected) {
            chatRunSocket.emit('clarify.respond', { session_id, clarify_id, response: userResp || '' })
          }
          activeClarifies.delete(clarify_id)
          broadcast({ type: 'clarify.resolved', clarify_id })
          appendLog('clarify.resolved', `已提交澄清答案: ${userResp}`, session_id)
          ws.send(JSON.stringify({ type: 'clarify.response_ack', clarify_id, success: true }))
        }
      } else if (data.type === 'set_auto_approve') {
        setAutoApproveState(data.enabled, data.sessionId)
        ws.send(JSON.stringify({
          type: 'auto_approve_ack',
          enabled: autoApproveEnabled,
          sessionId: autoApproveSessionId
        }))
      }
    } catch {}
  })
})

// Start server
server.listen(config.port, '0.0.0.0', () => {
  const curLanUrl = getLanUrl()
  console.log('==================================================')
  console.log('🚀 Hermes Mobile Watch (移动看护与即时审批伴侣) 已启动!')
  console.log(`📡 局域网访问地址: ${curLanUrl}`)
  console.log(`💻 本机访问地址:   http://localhost:${config.port}`)
  console.log(`🔗 Hermes 核心地址: ${config.hermesUrl}`)
  console.log('==================================================')

  // Print ASCII QR code in terminal for immediate convenience
  QRCode.toString(curLanUrl, { type: 'terminal', small: true }, (err, qrText) => {
    if (!err && qrText) {
      console.log('📱 手机微信/相机扫码直达:')
      console.log(qrText)
    }
  })

  // Start background connection to Hermes Agent core
  connectToHermes()
})
