'use strict'

const TOKEN_KEY = 'smartflow_panel_token'
const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  mappings: { page: 1, pageSize: 25, total: 0, items: [], q: '', selected: new Set() },
  logs: { page: 1, pageSize: 25, total: 0, items: [], q: '', event: '', success: '', selected: new Set() },
  events: new Set(),
  autoRefreshTimer: null
}

function $(id) { return document.getElementById(id) }
function fmtDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch (_) { return iso }
}
function escapeHTML(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function toast(message, kind = '') {
  const el = $('toast')
  el.textContent = message
  el.className = `toast ${kind}`
  el.hidden = false
  setTimeout(() => { el.hidden = true }, 3500)
}

async function api(path, opts = {}) {
  const headers = Object.assign({ 'x-panel-token': state.token }, opts.headers || {})
  if (opts.body && typeof opts.body === 'object') {
    headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(opts.body)
  }
  const res = await fetch(path, Object.assign({}, opts, { headers }))
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY)
    state.token = ''
    showLogin(true)
    throw new Error('unauthorized')
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  const ct = res.headers.get('content-type') || ''
  return ct.includes('application/json') ? res.json() : res.text()
}

function showLogin(show) {
  $('login').hidden = !show
}

function applyLogin() {
  state.token = $('login-token').value.trim()
  if (!state.token) {
    $('login-error').textContent = 'Token vacío'
    return
  }
  sessionStorage.setItem(TOKEN_KEY, state.token)
  showLogin(false)
  $('login-error').textContent = ''
  refreshAll().catch((err) => toast(err.message, 'err'))
}

function logout() {
  sessionStorage.removeItem(TOKEN_KEY)
  state.token = ''
  state.mappings.items = []
  state.logs.items = []
  $('login-token').value = ''
  showLogin(true)
}

function renderStatus(data) {
  for (const [system, elId] of [['hubspot', 'card-hubspot'], ['odoo', 'card-odoo']]) {
    const card = $(elId)
    const sys = data[system] || {}
    const badge = card.querySelector('.badge')
    if (sys.up === true) {
      badge.className = 'badge ok'
      badge.textContent = 'OK'
    } else if (sys.up === false) {
      badge.className = sys.mode === 'stub' ? 'badge warn' : 'badge err'
      badge.textContent = sys.mode === 'stub' ? 'STUB' : 'DOWN'
    } else {
      badge.className = 'badge pending'
      badge.textContent = '—'
    }
    const latency = card.querySelector('.latency')
    latency.textContent = sys.latencyMs != null ? `${sys.latencyMs} ms` : ''
    const detail = card.querySelector('.card-detail')
    detail.textContent = sys.note || sys.error || (sys.up ? 'Conectado correctamente' : (sys.status ? `HTTP ${sys.status}` : 'Sin respuesta'))
    if (sys.version) detail.textContent += ` · v${sys.version}`
  }
}

async function refreshStatus() {
  try {
    const data = await api('/api/panel/status')
    renderStatus(data)
  } catch (err) {
    toast(`Status: ${err.message}`, 'err')
  }
}

function renderTable(tbody, items, columns, rowIdKey) {
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="' + columns.length + '" style="text-align:center;color:#6b7280;padding:24px">Sin registros</td></tr>'
    return
  }
  tbody.innerHTML = items.map((it) => {
    const tds = columns.map((c) => `<td>${c.render(it)}</td>`).join('')
    return `<tr data-id="${escapeHTML(it[rowIdKey])}">${tds}</tr>`
  }).join('')
}

function renderMappings() {
  const cols = [
    { render: (m) => `<input type="checkbox" class="mappings-select" data-id="${escapeHTML(m._id)}" ${state.mappings.selected.has(m._id) ? 'checked' : ''}/>` },
    { render: (m) => `<code>${escapeHTML(m.sourceId)}</code>` },
    { render: (m) => `<code>${escapeHTML(m.targetId || '—')}</code>` },
    { render: (m) => escapeHTML(m.targetRef || '—') },
    { render: (m) => `<code title="${escapeHTML(m.payloadHash || '')}">${escapeHTML((m.payloadHash || '').slice(0, 16))}</code>` },
    { render: (m) => fmtDate(m.lastSyncedAt) },
    { render: (m) => fmtDate(m.createdAt) },
    { render: (m) => fmtDate(m.updatedAt) },
    { render: (m) => `<button class="danger small" data-action="delete-mapping" data-id="${escapeHTML(m._id)}">Borrar</button>` }
  ]
  renderTable($('mappings-tbody'), state.mappings.items, cols, '_id')
  $('mappings-shown').textContent = state.mappings.items.length
  $('mappings-total').textContent = state.mappings.total
  renderPagination('mappings-pagination', state.mappings, refreshMappings)
}

function renderLogs() {
  const cols = [
    { render: (l) => `<input type="checkbox" class="logs-select" data-id="${escapeHTML(l._id)}" ${state.logs.selected.has(l._id) ? 'checked' : ''}/>` },
    { render: (l) => `<code title="${escapeHTML(l._id)}">${escapeHTML(l._id.slice(-12))}</code>` },
    { render: (l) => `<code>${escapeHTML(l.sourceId || '—')}</code>` },
    { render: (l) => `<code>${escapeHTML(l.event || '—')}</code>` },
    { render: (l) => `<span class="badge ${l.success ? 'ok' : 'err'}">${l.success ? 'success' : 'failed'}</span>` },
    { render: (l) => { const msg = l.detail && l.detail.message ? l.detail.message : (l.detail && typeof l.detail === 'string' ? l.detail : ''); return escapeHTML(msg || '—') } },
    { render: (l) => `<div class="payload-cell"><button class="payload-toggle" data-action="toggle-payload" data-id="${escapeHTML(l._id)}">Ver payload</button><pre class="payload-pre" data-payload-for="${escapeHTML(l._id)}" hidden></pre></div>` },
    { render: (l) => fmtDate(l.createdAt) },
    { render: (l) => `<button class="danger small" data-action="delete-log" data-id="${escapeHTML(l._id)}">Borrar</button>` }
  ]
  renderTable($('logs-tbody'), state.logs.items, cols, '_id')
  $('logs-shown').textContent = state.logs.items.length
  $('logs-total').textContent = state.logs.total
  renderPagination('logs-pagination', state.logs, refreshLogs)
}

function renderPagination(elId, pageState, refresher) {
  const totalPages = Math.max(1, Math.ceil(pageState.total / pageState.pageSize))
  const el = $(elId)
  if (totalPages <= 1) { el.innerHTML = ''; return }
  const buttons = []
  for (let p = 1; p <= totalPages; p += 1) {
    buttons.push(`<button data-page="${p}" class="${p === pageState.page ? 'active' : ''}">${p}</button>`)
  }
  el.innerHTML = buttons.join('')
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { pageState.page = Number(b.dataset.page); refresher() }
  })
}

async function refreshMappings() {
  try {
    const q = state.mappings.q ? `&q=${encodeURIComponent(state.mappings.q)}` : ''
    const data = await api(`/api/panel/mappings?page=${state.mappings.page}&pageSize=${state.mappings.pageSize}${q}`)
    state.mappings.items = data.items
    state.mappings.total = data.total
    state.mappings.page = data.page
    state.mappings.pageSize = data.pageSize
    renderMappings()
  } catch (err) { toast(`Mappings: ${err.message}`, 'err') }
}

async function refreshLogs() {
  try {
    const params = new URLSearchParams()
    params.set('page', state.logs.page)
    params.set('pageSize', state.logs.pageSize)
    if (state.logs.q) params.set('q', state.logs.q)
    if (state.logs.event) params.set('event', state.logs.event)
    if (state.logs.success !== '') params.set('success', String(state.logs.success))
    const data = await api(`/api/panel/logs?${params.toString()}`)
    state.logs.items = data.items
    state.logs.total = data.total
    state.logs.page = data.page
    state.logs.pageSize = data.pageSize
    for (const it of data.items) state.events.add(it.event)
    refreshEventFilter()
    renderLogs()
  } catch (err) { toast(`Logs: ${err.message}`, 'err') }
}

function refreshEventFilter() {
  const sel = $('logs-event')
  const current = sel.value
  const opts = ['<option value="">Todos los eventos</option>']
  for (const ev of Array.from(state.events).sort()) {
    opts.push(`<option value="${escapeHTML(ev)}" ${ev === current ? 'selected' : ''}>${escapeHTML(ev)}</option>`)
  }
  sel.innerHTML = opts.join('')
}

function refreshAll() {
  return Promise.all([refreshStatus(), refreshMappings(), refreshLogs()])
}

async function deleteMapping(id) {
  try {
    await api(`/api/panel/mappings/${id}`, { method: 'DELETE' })
    state.mappings.selected.delete(id)
    toast('Mapping borrado', 'ok')
    await refreshMappings()
  } catch (err) { toast(`Borrar mapping: ${err.message}`, 'err') }
}

async function deleteLog(id) {
  try {
    await api(`/api/panel/logs/${id}`, { method: 'DELETE' })
    state.logs.selected.delete(id)
    toast('Log borrado', 'ok')
    await refreshLogs()
  } catch (err) { toast(`Borrar log: ${err.message}`, 'err') }
}

async function deleteSelectedLogs() {
  const ids = Array.from(state.logs.selected)
  if (!ids.length) return
  if (!confirm(`¿Borrar ${ids.length} log(s)?`)) return
  for (const id of ids) {
    try { await api(`/api/panel/logs/${id}`, { method: 'DELETE' }) } catch (_) {}
  }
  state.logs.selected.clear()
  toast('Logs borrados', 'ok')
  await refreshLogs()
}

async function deleteSelectedMappings() {
  const ids = Array.from(state.mappings.selected)
  if (!ids.length) return
  if (!confirm(`¿Borrar ${ids.length} mapping(s)?`)) return
  for (const id of ids) {
    try { await api(`/api/panel/mappings/${id}`, { method: 'DELETE' }) } catch (_) {}
  }
  state.mappings.selected.clear()
  toast('Mappings borrados', 'ok')
  await refreshMappings()
}

async function clearAll(kind) {
  if (!confirm(`¿Borrar TODOS los ${kind}? Esta acción no se puede deshacer.`)) return
  if (!confirm('Confirmación final: ¿continuar?')) return
  try {
    const data = await api(`/api/panel/${kind}/clear`, { method: 'POST', body: { confirm: true } })
    toast(`Borrados ${data.removed} registros`, 'ok')
    if (kind === 'logs') await refreshLogs(); else await refreshMappings()
  } catch (err) {
    if (err.message && err.message.includes('confirm_required')) toast('Falta confirm:true en el body', 'err')
    else toast(`Clear ${kind}: ${err.message}`, 'err')
  }
}

async function togglePayload(id) {
  const pre = document.querySelector(`pre[data-payload-for="${CSS.escape(id)}"]`)
  if (!pre) return
  if (!pre.hidden) { pre.hidden = true; pre.textContent = ''; return }
  try {
    const data = await api(`/api/panel/logs/${id}`)
    pre.textContent = JSON.stringify(data.item.detail || data.item, null, 2)
    pre.hidden = false
  } catch (err) { toast(`Payload: ${err.message}`, 'err') }
}

function bindEvents() {
  $('login-submit').onclick = applyLogin
  $('login-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyLogin() })
  $('logout').onclick = logout
  $('refresh-status').onclick = () => refreshAll()

  $('auto-refresh').addEventListener('change', (e) => {
    if (state.autoRefreshTimer) { clearInterval(state.autoRefreshTimer); state.autoRefreshTimer = null }
    if (e.target.checked) state.autoRefreshTimer = setInterval(() => refreshStatus(), 15000)
  })

  $('mappings-q').addEventListener('input', debounce((e) => { state.mappings.q = e.target.value; state.mappings.page = 1; refreshMappings() }, 350))
  $('mappings-page-size').addEventListener('change', (e) => { state.mappings.pageSize = Number(e.target.value); state.mappings.page = 1; refreshMappings() })
  $('mappings-clear').onclick = () => clearAll('mappings')
  $('mappings-select-all').addEventListener('change', (e) => {
    const checked = e.target.checked
    state.mappings.selected.clear()
    if (checked) for (const it of state.mappings.items) state.mappings.selected.add(it._id)
    renderMappings()
    updateBulkButtons()
  })
  $('mappings-tbody').addEventListener('change', (e) => {
    if (e.target.classList.contains('mappings-select')) {
      if (e.target.checked) state.mappings.selected.add(e.target.dataset.id)
      else state.mappings.selected.delete(e.target.dataset.id)
      updateBulkButtons()
    }
  })
  $('mappings-delete-selected').onclick = deleteSelectedMappings
  $('mappings-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]')
    if (!btn) return
    if (btn.dataset.action === 'delete-mapping') deleteMapping(btn.dataset.id)
  })

  $('logs-q').addEventListener('input', debounce((e) => { state.logs.q = e.target.value; state.logs.page = 1; refreshLogs() }, 350))
  $('logs-event').addEventListener('change', (e) => { state.logs.event = e.target.value; state.logs.page = 1; refreshLogs() })
  $('logs-success').addEventListener('change', (e) => { state.logs.success = e.target.value === '' ? '' : (e.target.value === 'true'); state.logs.page = 1; refreshLogs() })
  $('logs-page-size').addEventListener('change', (e) => { state.logs.pageSize = Number(e.target.value); state.logs.page = 1; refreshLogs() })
  $('logs-clear').onclick = () => clearAll('logs')
  $('logs-select-all').addEventListener('change', (e) => {
    const checked = e.target.checked
    state.logs.selected.clear()
    if (checked) for (const it of state.logs.items) state.logs.selected.add(it._id)
    renderLogs()
    updateBulkButtons()
  })
  $('logs-tbody').addEventListener('change', (e) => {
    if (e.target.classList.contains('logs-select')) {
      if (e.target.checked) state.logs.selected.add(e.target.dataset.id)
      else state.logs.selected.delete(e.target.dataset.id)
      updateBulkButtons()
    }
  })
  $('logs-delete-selected').onclick = deleteSelectedLogs
  $('logs-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]')
    if (!btn) return
    if (btn.dataset.action === 'delete-log') deleteLog(btn.dataset.id)
    if (btn.dataset.action === 'toggle-payload') togglePayload(btn.dataset.id)
  })
}

function updateBulkButtons() {
  $('logs-delete-selected').disabled = state.logs.selected.size === 0
  $('mappings-delete-selected').disabled = state.mappings.selected.size === 0
}

function debounce(fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents()
  if (!state.token) { showLogin(true); return }
  showLogin(false)
  refreshAll().catch((err) => {
    if (err.message === 'unauthorized') return
    toast(err.message, 'err')
  })
})
