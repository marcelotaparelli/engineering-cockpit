'use strict';
// Engineering Cockpit UI. Plain DOM, textContent only (no HTML from data), same-origin fetch with session proof.
const $ = id => document.getElementById(id);
const STATE_LABEL = { working: 'Trabalhando', awaiting_approval: 'Aguardando você', completed: 'Concluído', failed: 'Falhou', interrupted: 'Interrompido', unknown: 'Não confirmado', idle: 'Ocioso', offline: 'Offline' };
const RUN_LABEL = { prepared: 'Preparando', dispatching: 'Enviando', running: 'Executando', awaiting_approval: 'Aguardando aprovação', completed: 'Concluído', failed: 'Falhou', interrupted: 'Interrompido', unknown: 'Não confirmado' };
const REASON = {
  transport_lost: 'A conexão com a VM caiu durante a execução. Nada foi reenviado.',
  dispatch_unconfirmed: 'O envio pode ter chegado ao Codex, mas não foi confirmado. Nada foi reenviado.',
  process_restarted: 'O Cockpit reiniciou durante a execução. Nada foi reenviado.',
  not_dispatched_before_restart: 'O Cockpit reiniciou antes do envio; o prompt não chegou ao agente.',
  provider_turn_failed: 'O agente encerrou a tarefa com erro (o Codex não informou a causa).',
  provider_turn_error: 'O Codex reportou um erro durante a tarefa (causa não classificada).',
  provider_usage_limit: 'Limite de uso ou quota do Codex esgotado. Aguarde a renovação ou troque de plano.',
  provider_auth_failed: 'Falha de autenticação no Codex da VM. Refaça o login dentro da VM.',
  provider_transport_error: 'Falha de conexão entre o Codex e o serviço do modelo. Tente novamente depois.',
  provider_context_window: 'A conversa excedeu a janela de contexto do modelo.',
  provider_bad_request: 'O modelo recusou a requisição (requisição inválida).',
  provider_overloaded: 'O serviço do modelo está sobrecarregado. Tente novamente depois.',
  provider_sandbox_error: 'Erro no sandbox de execução do Codex.',
  provider_internal_error: 'Erro interno do serviço do modelo.',
  approval_delivery_unconfirmed: 'A decisão de aprovação não teve entrega confirmada.',
  reconciled: 'Estado confirmado pelo histórico do Codex.',
  target_unavailable: 'VM indisponível (parada, ausente ou órfã).',
  provider_status_unknown: 'O Codex retornou um estado não reconhecido.',
};
const ERROR_TEXT = {
  project_busy: 'Já existe uma execução ativa neste projeto. Aguarde ou interrompa antes de enviar outra.',
  target_unavailable: 'A VM não está em execução ou não está mais disponível. Nada foi enviado.',
  idempotency_key_conflict: 'Esta chave de envio já foi usada com outro conteúdo.',
  approval_conflict: 'A aprovação já foi decidida ou mudou. A lista foi atualizada.',
  approval_expired: 'A aprovação expirou ou o agente não está mais esperando por ela.',
  run_not_interruptible: 'A execução ainda não pode ser interrompida (envio em curso) ou já não está ativa.',
  csrf_denied: 'Sessão desta aba inválida para alterações. Entre novamente.',
  invalid_prompt: 'Prompt vazio ou grande demais.',
};
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const ACTIVE = new Set(['prepared', 'dispatching', 'running', 'awaiting_approval']);

const state = { csrf: null, proof: null, dashboard: null, vm: null, sessionId: null, sessionData: null, run: null, lastEventId: null, stream: null, refreshTimer: null, liveItems: new Map(), retry: 0 };
try { state.proof = sessionStorage.getItem('cockpit_session_proof'); } catch {}
try { const view = JSON.parse(sessionStorage.getItem('cockpit_view') || 'null'); if (view) { state.vm = view.vm || null; state.sessionId = view.sessionId || null; } } catch {}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function button(text, onClick, className) {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
function ago(iso) {
  if (!iso) return 'sem atividade';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `há ${seconds}s`;
  if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.round(seconds / 3600)} h`;
  return new Date(iso).toLocaleString('pt-BR');
}
function saveView() { try { sessionStorage.setItem('cockpit_view', JSON.stringify({ vm: state.vm, sessionId: state.sessionId })); } catch {} }
function showError(message) { $('error').textContent = message; $('error').hidden = false; }
function clearError() { $('error').hidden = true; $('error').textContent = ''; }
function nonce() { return crypto.randomUUID().replaceAll('-', '') + 'n0'; }

class ApiError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }
async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.proof) headers['X-Session-Proof'] = state.proof;
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, headers }); }
  catch (error) { throw new ApiError(error && error.message ? error.message : 'network_error', 0); }
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const code = data && data.error && data.error.code ? data.error.code : 'request_failed';
    if (response.status === 401 && path !== '/api/auth/logout') { showLogin(); }
    throw new ApiError(code, response.status);
  }
  return data;
}
const get = path => request(path);
const post = (path, body, extra = {}) => request(path, { method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '', 'X-Request-Nonce': nonce(), ...extra } });

function stopStream() { if (state.stream) { state.stream.abort(); state.stream = null; } }
function showLogin() {
  stopStream();
  state.csrf = null; state.proof = null; state.dashboard = null;
  try { sessionStorage.removeItem('cockpit_session_proof'); } catch {}
  $('login').hidden = false; $('logout').hidden = true; $('app').hidden = true; $('refresh').hidden = true; $('live').hidden = true;
  $('agents').replaceChildren(); $('attention').replaceChildren(); $('conversation').replaceChildren();
  $('source').textContent = 'Acesso local protegido'; $('source').className = 'badge';
  setLive('offline', 'bad');
  $('status').textContent = 'Autenticação local necessária';
}
function showApp() {
  $('login').hidden = true; $('logout').hidden = false; $('app').hidden = false; $('refresh').hidden = false; $('live').hidden = false;
  if (!state.dashboard) { $('agents').replaceChildren(el('li', 'Carregando agentes…', 'empty-list')); setLive('conectando…', 'warn'); }
}
function setLive(text, tone) { $('live').textContent = text; $('live').className = `badge conn ${tone}`; }
function setPane(pane) {
  $('app').dataset.pane = pane;
  for (const tab of document.querySelectorAll('.tabs button')) tab.setAttribute('aria-current', String(tab.dataset.pane === pane));
}
for (const tab of document.querySelectorAll('.tabs button')) tab.addEventListener('click', () => setPane(tab.dataset.pane));
setPane('session');

async function init() {
  if (!state.proof) { showLogin(); return; }
  try {
    const session = await get('/api/auth/session');
    state.csrf = session.csrf;
    showApp();
    await loadDashboard();
    connectStream();
    if (state.vm) await selectVm(state.vm, state.sessionId);
  } catch (error) { if (error.status !== 401) showError(`Falha ao iniciar: ${error.code}`); }
}

$('login').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('credential');
  const credential = input.value;
  input.value = '';
  $('login-error').hidden = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
    if (!response.ok) throw new Error('login_failed');
    const session = await response.json();
    state.csrf = session.csrf; state.proof = session.proof;
    try { sessionStorage.setItem('cockpit_session_proof', state.proof); } catch {}
    clearError();
    showApp();
    await loadDashboard();
    connectStream();
    if (state.vm) await selectVm(state.vm, state.sessionId);
  } catch {
    $('login-error').textContent = 'Credencial recusada ou limite de tentativas atingido.';
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  if (!state.csrf) return;
  try {
    await post('/api/auth/logout', {});
    showLogin();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      showError('Sessão desta aba inválida. Saída não confirmada; outra aba pode estar autenticada.');
      return;
    }
    showError('Não foi possível confirmar a saída. Tente novamente.');
  }
});

// ---------------------------------------------------------------- dashboard
async function loadDashboard() {
  $('refresh').disabled = true;
  try {
    const data = await get('/api/dashboard');
    state.dashboard = data;
    if (state.lastEventId === null && Number.isSafeInteger(data.cursor)) state.lastEventId = data.cursor;
    $('source').textContent = data.source === 'mock' ? 'SIMULAÇÃO · agente sintético' : 'Host · Microsandbox';
    $('source').className = data.source === 'mock' ? 'badge sim' : 'badge';
    renderAttention(data.attention);
    renderAgents(data);
    renderDiscovery(data);
    $('status').textContent = data.discovery_error ? `Discovery indisponível (${data.discovery_error}); exibindo apenas sessões conhecidas.` : `VMs observadas ${ago(data.observed_at)}`;
    clearError();
  } catch (error) {
    if (error.status === 401) return;
    if (!state.dashboard) $('agents').replaceChildren();
    showError(`Falha ao atualizar: ${error.code}`);
  } finally { $('refresh').disabled = false; }
}

const DISCOVERY_ERROR = {
  msb_timeout: 'o comando msb não respondeu a tempo.', msb_spawn_failed: 'o comando msb não foi encontrado no PATH do Cockpit.',
  project_discovery_failed: 'COCKPIT_PROJECTS_BASE não pôde ser lido.', invalid_vm_json: 'saída do msb não é JSON válido.',
};
function renderDiscovery(data) {
  const box = $('discovery');
  const d = data.discovery || {};
  const lines = [];
  let tone = '';
  if (data.discovery_error) {
    tone = 'bad';
    lines.push(`Não foi possível listar as VMs (${data.discovery_error})${DISCOVERY_ERROR[data.discovery_error] ? ': ' + DISCOVERY_ERROR[data.discovery_error] : '.'}`);
    lines.push('Sessões já conhecidas continuam acessíveis. Diagnóstico local: ./scripts/cockpit discovery-report');
  } else if (!data.vms.length) {
    tone = 'warn';
    lines.push('Nenhuma VM de agente nos projetos autorizados.');
    if (d.outside_grants) lines.push(`${d.outside_grants} VM(s) de agente fora de COCKPIT_ALLOWED_PROJECTS.`);
    if (d.ignored_invalid_project) lines.push(`${d.ignored_invalid_project} VM(s) com nome de projeto fora do padrão (minúsculas, dígitos, - e _).`);
    if (d.ignored_not_agent) lines.push(`${d.ignored_not_agent} sandbox(es) que não são agentes (ignoradas).`);
    lines.push('Detalhes por VM: ./scripts/cockpit discovery-report');
  } else if (d.ignored_invalid_project) {
    tone = 'warn';
    lines.push(`${d.ignored_invalid_project} VM(s) parecem agentes mas têm nome de projeto fora do padrão e foram ignoradas. Veja ./scripts/cockpit discovery-report`);
  }
  box.hidden = !lines.length;
  box.className = `notice ${tone}`;
  box.replaceChildren(...lines.map(line => el('span', line)));
}

function renderAgents(data) {
  const c = data.counts;
  const parts = [[c.working, 'executando'], [c.awaiting_approval, 'aguardando você'], [c.failed + c.unknown, 'com problema'], [c.completed, c.completed === 1 ? 'concluído' : 'concluídos']].filter(([n]) => n > 0);
  $('counts').textContent = parts.length ? parts.map(([n, label]) => `${n} ${label}`).join(' · ') : `${data.vms.length} agente(s), nenhum em execução`;
  const list = $('agents');
  const filter = $('filter').value.trim().toLowerCase();
  const vms = data.vms.filter(vm => !filter || vm.vm_name.toLowerCase().includes(filter) || String(vm.project || '').toLowerCase().includes(filter));
  list.replaceChildren();
  if (!data.vms.length) { list.append(el('li', data.discovery_error ? 'Sem VMs observadas.' : 'Nenhum agente para mostrar.', 'empty-list')); return; }
  if (!vms.length) { list.append(el('li', 'Nenhum agente corresponde ao filtro.', 'empty-list')); return; }
  const groups = new Map();
  for (const vm of vms) { const key = vm.project || '—'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(vm); }
  for (const [project, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const group = el('li', null, 'project');
    const head = el('div', null, 'project-name');
    const busy = members.filter(vm => vm.state === 'working' || vm.state === 'awaiting_approval').length;
    head.append(el('span', project), el('span', busy ? `${busy} ativo` : ''));
    const ul = el('ul', null, 'agents');
    for (const vm of members) {
      const item = el('li');
      const node = button('', () => selectVm(vm.vm_name), 'agent');
      node.dataset.vm = vm.vm_name;
      node.setAttribute('aria-pressed', String(vm.vm_name === state.vm));
      const top = el('div', null, 'row');
      top.append(el('span', null, `dot s-${vm.state}`), el('strong', vm.vm_name, 'name'), el('span', STATE_LABEL[vm.state] || vm.state, `chip s-${vm.state}`));
      const where = vm.orphaned ? 'ÓRFÃ: diretório do projeto ausente' : vm.vm_state === 'running' ? 'VM ligada' : vm.vm_state === 'stopped' ? 'VM parada' : 'VM não observada';
      node.append(top, el('div', `${where} · ${ago(vm.last_activity)}`, 'meta'));
      if (vm.state !== 'offline') node.append(el('div', vm.next_step, 'meta'));
      node.title = `${vm.vm_name} — próximo passo: ${vm.next_step}`;
      node.disabled = !vm.runnable && !vm.session_id;
      item.append(node);
      ul.append(item);
    }
    group.append(head, ul);
    list.append(group);
  }
}
$('filter').addEventListener('input', () => { if (state.dashboard) renderAgents(state.dashboard); });

function approvalCard(item, onDone) {
  const li = el('li', null, 'card');
  const summary = item.summary;
  const head = el('div', null, 'head');
  head.append(el('strong', item.action_type === 'file_change' || item.actionType === 'file_change' ? 'Aprovar alteração de arquivos' : 'Aprovar comando'), el('span', ago(item.created_at || item.createdAt), 'where'));
  li.append(head);
  if (item.vm_name) li.append(el('div', `${item.project || ''} · ${item.vm_name}`, 'where'));
  if (summary && summary.command) li.append(el('pre', summary.command));
  if (summary && summary.files && summary.files.length) li.append(el('pre', summary.files.join('\n')));
  if (summary && summary.reason) li.append(el('div', summary.reason, 'muted'));
  if (summary && summary.cwd) li.append(el('div', `cwd: ${summary.cwd}`, 'muted'));
  if (!summary) li.append(el('div', 'Detalhes indisponíveis (conexão perdida).', 'muted'));
  const id = item.approval_id || item.approvalId;
  const version = item.version;
  const actions = el('div', null, 'actions');
  const decide = decision => async () => {
    for (const control of actions.querySelectorAll('button')) control.disabled = true;
    try { await post(`/api/approvals/${encodeURIComponent(id)}/decision`, { decision, expected_version: version }); }
    catch (error) { showError(ERROR_TEXT[error.code] || `Falha na decisão: ${error.code}`); }
    await onDone();
  };
  actions.append(button('Aprovar', decide('approve'), 'primary'), button('Rejeitar', decide('reject'), 'danger'));
  if (item.session_id && item.vm_name && item.session_id !== state.sessionId) actions.append(button('Abrir sessão', () => selectVm(item.vm_name, item.session_id)));
  li.append(actions);
  return li;
}

function renderAttention(items) {
  const list = $('attention');
  list.replaceChildren();
  for (const id of ['attention-count', 'tab-count']) { $(id).textContent = String(items.length); $(id).className = items.length ? 'count hot' : 'count'; }
  if (!items.length) { list.append(el('li', 'Nada pendente. Quando um agente pedir aprovação ou travar, aparece aqui.', 'empty-list')); return; }
  for (const item of items) {
    if (item.kind === 'approval') { list.append(approvalCard(item, refreshAll)); continue; }
    const li = el('li', null, 'card bad');
    const head = el('div', null, 'head');
    head.append(el('strong', item.kind === 'unknown_run' ? 'Execução não confirmada' : 'Execução falhou'), el('span', ago(item.created_at), 'where'));
    li.append(head, el('div', `${item.project || ''} · ${item.vm_name}`, 'where'));
    li.append(el('div', REASON[item.reason_code] || item.reason_code || '', 'muted small'));
    const actions = el('div', null, 'actions');
    actions.append(button(item.kind === 'unknown_run' ? 'Abrir e reconciliar' : 'Abrir sessão', () => selectVm(item.vm_name, item.session_id)));
    li.append(actions);
    list.append(li);
  }
}

// ---------------------------------------------------------------- session workspace
let selectToken = 0;
async function selectVm(vmName, sessionId) {
  const token = ++selectToken;
  state.vm = vmName;
  if (sessionId) { state.sessionId = sessionId; saveView(); }
  for (const node of document.querySelectorAll('.agent')) node.setAttribute('aria-pressed', String(node.dataset.vm === vmName));
  setPane('session');
  const vm = state.dashboard && state.dashboard.vms.find(item => item.vm_name === vmName);
  $('empty').hidden = true; $('session-view').hidden = false;
  $('vm-title').textContent = vmName;
  $('vm-meta').textContent = vm ? `Projeto ${vm.project} · ${vm.provider} · VM ${vm.vm_state === 'running' ? 'ligada' : vm.vm_state === 'stopped' ? 'parada' : 'não observada'}${vm.orphaned ? ' · órfã' : ''}` : 'VM não observada agora';
  $('new-session').disabled = !(vm && vm.runnable);
  const known = state.dashboard ? state.dashboard.sessions.filter(item => item.vm_name === vmName) : [];
  const select = $('session-select');
  select.replaceChildren();
  for (const item of known) {
    const option = el('option', `Sessão ${item.thread_id.slice(0, 8)} · atividade ${ago(item.last_activity)}`);
    option.value = `s:${item.session_id}`;
    select.append(option);
  }
  if (vm && vm.runnable) {
    try {
      const threads = await get(`/api/vms/${encodeURIComponent(vmName)}/threads`);
      for (const thread of threads.threads.filter(item => !item.sessionId)) {
        const option = el('option', `Retomar thread Codex ${thread.id.slice(0, 8)} · ${ago(thread.updatedAt)}`);
        option.value = `t:${thread.id}`;
        select.append(option);
      }
    } catch (error) { if (error.status !== 401) $('composer-note').textContent = `Threads do Codex indisponíveis: ${error.code}`; }
    if (token !== selectToken) return; // a newer selection superseded this one while threads loaded
  }
  if (!select.options.length) {
    const option = el('option', 'Nenhuma sessão — crie uma nova');
    option.value = '';
    select.append(option);
  }
  const preferred = sessionId || (vm && vm.session_id) || (known[0] && known[0].session_id);
  if (preferred && [...select.options].some(option => option.value === `s:${preferred}`)) select.value = `s:${preferred}`;
  await openSelected();
  $('run-bar').scrollIntoView && $('run-bar').scrollIntoView({ block: 'nearest' });
}

async function openSelected() {
  const value = $('session-select').value;
  if (value.startsWith('t:')) {
    try {
      const session = await post('/api/sessions', { vm_name: state.vm, mode: 'resume', thread_id: value.slice(2) });
      await loadDashboard();
      await selectVm(state.vm, session.session_id);
    } catch (error) { showError(`Não foi possível retomar: ${ERROR_TEXT[error.code] || error.code}`); }
    return;
  }
  state.sessionId = value.startsWith('s:') ? value.slice(2) : null;
  saveView();
  state.liveItems.clear();
  await loadSession(true);
}
$('session-select').addEventListener('change', openSelected);
$('new-session').addEventListener('click', async () => {
  $('new-session').disabled = true;
  try {
    const session = await post('/api/sessions', { vm_name: state.vm, mode: 'new' });
    await loadDashboard();
    await selectVm(state.vm, session.session_id);
  } catch (error) { showError(`Não foi possível abrir sessão: ${ERROR_TEXT[error.code] || error.code}`); }
  finally { $('new-session').disabled = false; }
});

async function loadSession(withHistory) {
  const conversation = $('conversation');
  renderPending();
  if (!state.sessionId) {
    conversation.replaceChildren(el('li', 'Crie uma sessão para conversar com o agente.', 'msg note'));
    $('run-bar').hidden = true; $('session-approvals').replaceChildren(); updateComposer();
    return;
  }
  try {
    const data = await get(`/api/sessions/${encodeURIComponent(state.sessionId)}`);
    state.sessionData = data;
    state.run = data.runs[0] || null;
    renderRun();
    const approvals = $('session-approvals');
    approvals.replaceChildren(...data.approvals.map(item => approvalCard(item, refreshAll)));
    if (withHistory) await loadHistory();
  } catch (error) {
    if (error.status === 401) return;
    if (error.status === 404) { state.sessionId = null; saveView(); }
    showError(`Falha ao carregar sessão: ${error.code}`);
  }
  updateComposer();
}

async function loadHistory() {
  const conversation = $('conversation');
  try {
    const page = await get(`/api/sessions/${encodeURIComponent(state.sessionId)}/history`);
    conversation.replaceChildren();
    state.liveItems.clear();
    for (const item of page.items) conversation.append(renderItem(item));
    if (!page.items.length) conversation.append(el('li', 'Sessão sem mensagens ainda.', 'msg note'));
  } catch (error) {
    if (error.status === 401) return;
    conversation.replaceChildren(el('li', `Histórico indisponível (${error.code}). A execução continua sendo acompanhada ao vivo.`, 'msg note'));
  }
  syncRunEnd();
  conversation.scrollTop = conversation.scrollHeight;
}

function renderItem(item) {
  if (item.kind === 'user_message') return el('li', item.text || '', 'msg user');
  if (item.kind === 'agent_message') return el('li', item.text || '', 'msg agent');
  if (item.kind === 'command') {
    const status = item.status || 'in_progress';
    const node = el('li', `$ ${item.command || ''}  [${status}${item.exitCode === null || item.exitCode === undefined ? '' : ` · exit ${item.exitCode}`}]`, `msg action ${status}`);
    if (item.text) node.append(el('div', item.text, 'muted'));
    return node;
  }
  if (item.kind === 'file_change') return el('li', `Arquivos (${item.status || 'pendente'}): ${(item.files || []).join(', ')}`, `msg action ${item.status || ''}`);
  if (item.kind === 'plan') return el('li', `Plano: ${item.text || ''}`, 'msg note');
  if (item.kind === 'reasoning') {
    if (item.text) return el('li', `Raciocínio: ${item.text}`, 'msg note');
    // Empty reasoning is only a transient "thinking" placeholder while a run is active; never after it ended.
    const live = !state.run || ACTIVE.has(state.run.status);
    return live ? el('li', 'Raciocinando…', 'msg note thinking') : el('li', 'Raciocínio (sem resumo)', 'msg note');
  }
  return el('li', item.kind, 'msg note');
}

const END_NOTE = { interrupted: 'Execução interrompida — o agente parou antes de concluir esta resposta.', failed: 'Execução falhou.', unknown: 'Resultado não confirmado.' };
// Settles transient indicators once the run is no longer active; idempotent, never touches real history items.
function syncRunEnd() {
  const conversation = $('conversation');
  const run = state.run;
  const ended = run && !ACTIVE.has(run.status);
  if (ended) for (const node of conversation.querySelectorAll('.thinking')) { node.textContent = 'Raciocínio (sem resumo)'; node.classList.remove('thinking'); }
  for (const node of conversation.querySelectorAll('.run-end')) node.remove();
  if (ended && run.status === 'interrupted') conversation.append(el('li', END_NOTE.interrupted, 'msg note run-end'));
}

function renderRun() {
  const run = state.run;
  $('run-bar').hidden = !run;
  if (!run) return;
  syncRunEnd();
  $('run-status').textContent = RUN_LABEL[run.status] || run.status;
  $('run-status').className = `chip s-${run.status}`;
  const parts = [];
  if (run.reason_code) parts.push(REASON[run.reason_code] || run.reason_code);
  const metrics = run.metrics || {};
  if (metrics.durationMs !== null && metrics.durationMs !== undefined) parts.push(`duração ${(metrics.durationMs / 1000).toFixed(1)}s`);
  parts.push(metrics.inputTokens === null || metrics.inputTokens === undefined ? 'tokens: não medido' : `tokens (acumulado da sessão): ${metrics.inputTokens} in / ${metrics.outputTokens ?? 'não medido'} out`);
  $('run-detail').textContent = parts.join(' · ');
  $('interrupt').hidden = !(run.status === 'running' || run.status === 'awaiting_approval');
  $('interrupt').disabled = !run.provider_bound;
  $('reconcile').hidden = run.status !== 'unknown';
}

function updateComposer() {
  const vm = state.dashboard && state.dashboard.vms.find(item => item.vm_name === state.vm);
  const busy = state.run && ACTIVE.has(state.run.status);
  const usable = Boolean(state.sessionId && vm && vm.runnable);
  $('prompt').disabled = !usable;
  $('send').disabled = !usable || busy;
  $('composer-note').textContent = !state.sessionId ? '' : !usable ? 'VM indisponível: envio desabilitado.' : busy ? 'Execução em andamento: aguarde, decida aprovações ou interrompa.' : '';
}

$('interrupt').addEventListener('click', async () => {
  if (!state.run) return;
  $('interrupt').disabled = true;
  try { await post(`/api/runs/${encodeURIComponent(state.run.run_id)}/interrupt`, {}); $('composer-note').textContent = 'Interrupção solicitada; aguardando confirmação do agente.'; }
  catch (error) { showError(ERROR_TEXT[error.code] || `Falha ao interromper: ${error.code}`); $('interrupt').disabled = false; }
});
$('reconcile').addEventListener('click', async () => {
  if (!state.run) return;
  $('reconcile').disabled = true;
  try { await post(`/api/runs/${encodeURIComponent(state.run.run_id)}/reconcile`, {}); await refreshAll(); await loadHistory(); }
  catch (error) { showError(`Reconciliação indisponível: ${ERROR_TEXT[error.code] || error.code}`); }
  finally { $('reconcile').disabled = false; }
});

// ---------------------------------------------------------------- sending, exactly once
function readPending() { try { return JSON.parse(sessionStorage.getItem('cockpit_pending_send') || 'null'); } catch { return null; } }
function writePending(value) { try { if (value) sessionStorage.setItem('cockpit_pending_send', JSON.stringify(value)); else sessionStorage.removeItem('cockpit_pending_send'); } catch {} }
function renderPending() {
  const pending = readPending();
  $('pending').hidden = !(pending && pending.sessionId === state.sessionId);
}
async function send(pending) {
  $('send').disabled = true;
  writePending(pending);
  try {
    const run = await post(`/api/sessions/${encodeURIComponent(pending.sessionId)}/runs`, { prompt: pending.prompt }, { 'Idempotency-Key': pending.key });
    writePending(null);
    $('prompt').value = '';
    state.run = run;
    const conversation = $('conversation');
    if (conversation.firstChild && conversation.firstChild.classList.contains('note')) conversation.replaceChildren();
    if (!run.replayed) conversation.append(el('li', pending.prompt, 'msg user'));
    conversation.scrollTop = conversation.scrollHeight;
    renderRun();
    await refreshAll();
  } catch (error) {
    if (error.status === 0) { $('composer-note').textContent = 'Sem confirmação do servidor. Use "Confirmar envio" — a mesma chave impede duplicação.'; }
    else { writePending(null); showError(ERROR_TEXT[error.code] || `Envio recusado: ${error.code}`); }
  }
  renderPending();
  updateComposer();
}
$('composer').addEventListener('submit', event => {
  event.preventDefault();
  const prompt = $('prompt').value;
  if (!prompt.trim() || !state.sessionId) return;
  send({ sessionId: state.sessionId, key: crypto.randomUUID().replaceAll('-', ''), prompt });
});
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('composer').requestSubmit(); });
$('pending-confirm').addEventListener('click', () => { const pending = readPending(); if (pending) send(pending); });
$('pending-discard').addEventListener('click', () => { writePending(null); renderPending(); });

// ---------------------------------------------------------------- live stream
function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(async () => { state.refreshTimer = null; await refreshAll(); }, 250);
}
async function refreshAll() {
  await loadDashboard();
  if (state.sessionId) await loadSession(false);
}
function onJournal(event) {
  scheduleRefresh();
  if (event.session_id === state.sessionId && event.payload && TERMINAL.has(event.payload.to)) {
    setTimeout(() => { if (state.sessionId === event.session_id) loadHistory(); }, 300);
  }
}
function onLive(event) {
  if (event.session_id !== state.sessionId) return;
  const conversation = $('conversation');
  if (conversation.firstChild && conversation.firstChild.classList.contains('note') && conversation.children.length === 1) conversation.replaceChildren();
  if (event.kind === 'delta') {
    let node = state.liveItems.get(event.itemId);
    if (!node) { node = el('li', '', 'msg agent live'); state.liveItems.set(event.itemId, node); conversation.append(node); }
    node.textContent += event.delta;
  } else if (event.kind === 'item') {
    const item = event.item;
    if (item.kind === 'user_message') return; // already shown on send
    const rendered = renderItem(item);
    const existing = state.liveItems.get(item.id);
    if (item.kind === 'agent_message' && event.phase === 'started') return;
    if (existing) existing.replaceWith(rendered); else conversation.append(rendered);
    if (event.phase === 'completed' && item.kind === 'agent_message') rendered.classList.remove('live');
    state.liveItems.set(item.id, rendered);
  } else if (event.kind === 'error') {
    conversation.append(el('li', `Erro do agente${event.willRetry ? ' (tentando novamente)' : ''}: ${event.message || 'sem detalhe'}`, 'msg error'));
  } else if (event.kind === 'status' && event.errorMessage) {
    conversation.append(el('li', event.errorMessage, 'msg error'));
  } else if (event.kind === 'notice' && event.code === 'provider_request_unsupported') {
    conversation.append(el('li', 'O agente pediu uma interação que o Cockpit ainda não suporta. Interrompa e reformule a tarefa.', 'msg error'));
  } else if (event.kind === 'approval') {
    scheduleRefresh();
  }
  syncRunEnd(); // a late live event must not resurrect a "thinking" indicator after the run ended
  conversation.scrollTop = conversation.scrollHeight;
}

async function connectStream() {
  stopStream();
  if (!state.proof) return;
  const controller = new AbortController();
  state.stream = controller;
  const headers = { 'X-Session-Proof': state.proof };
  if (state.lastEventId !== null) headers['Last-Event-ID'] = String(state.lastEventId);
  try {
    const response = await fetch('/api/events', { credentials: 'same-origin', cache: 'no-store', headers, signal: controller.signal });
    if (response.status === 401) { showLogin(); return; }
    if (!response.ok || !response.body) throw new Error('stream_failed');
    setLive('ao vivo', 'ok');
    state.retry = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let type = 'message'; let id = null; let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7);
          else if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (id !== null && /^\d+$/.test(id)) state.lastEventId = Number(id);
        if (type === 'journal') onJournal(payload); else if (type === 'live') onLive(payload);
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return;
  }
  if (state.stream !== controller || !state.proof || !$('live')) return; // page gone or logged out
  // Reconnect with backoff; the cursor guarantees no durable event is lost meanwhile.
  setLive('reconectando…', 'warn');
  state.retry = Math.min(state.retry + 1, 5);
  setTimeout(() => { if (state.stream === controller) { scheduleRefresh(); connectStream(); } }, 500 * 2 ** state.retry);
}

$('refresh').addEventListener('click', refreshAll);
init();
