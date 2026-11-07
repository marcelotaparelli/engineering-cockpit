const byId = id => document.getElementById(id);
const refresh = byId('refresh');
let selected = null;
let csrf = null;
let proof = null;
try { proof = sessionStorage.getItem('cockpit_session_proof'); } catch {}
function showLogin() {
  csrf = null;
  proof = null;
  try { sessionStorage.removeItem('cockpit_session_proof'); } catch {}
  byId('login').hidden = false;
  byId('logout').hidden = true;
  refresh.disabled = true;
  byId('projects').replaceChildren();
  byId('vms').replaceChildren();
  selected = null;
  byId('selection').textContent = 'Nenhuma VM selecionada.';
  byId('source').textContent = 'Acesso local protegido';
  byId('status').textContent = 'Autenticação local necessária';
}
function textElement(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}
async function get(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: proof ? { 'X-Session-Proof': proof } : {} });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.code || 'request_failed');
  return data;
}
async function init() {
  if (!proof) { showLogin(); return; }
  try {
    const session = await get('/api/auth/session');
    csrf = session.csrf;
    byId('login').hidden = true;
    byId('logout').hidden = false;
    await load();
  } catch { showLogin(); }
}
byId('login').addEventListener('submit', async event => {
  event.preventDefault();
  const input = byId('credential');
  const credential = input.value;
  input.value = '';
  byId('login-error').hidden = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
    if (!response.ok) throw new Error('login_failed');
    const session = await response.json();
    csrf = session.csrf;
    proof = session.proof;
    try { sessionStorage.setItem('cockpit_session_proof', proof); } catch {}
    byId('login').hidden = true;
    byId('logout').hidden = false;
    await load();
  } catch {
    byId('login-error').textContent = 'Credencial recusada ou limite de tentativas atingido.';
    byId('login-error').hidden = false;
  }
});
byId('logout').addEventListener('click', async () => {
  if (!csrf) return;
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Session-Proof': proof, 'X-CSRF-Token': csrf, 'X-Request-Nonce': crypto.randomUUID() }, body: '{}' });
    if (response.status === 401) {
      showLogin();
      byId('error').textContent = 'Sessão desta aba inválida. Saída não confirmada; outra aba pode estar autenticada.';
      byId('error').hidden = false;
      return;
    }
    if (!response.ok) throw new Error('logout_failed');
    showLogin();
  } catch {
    byId('error').textContent = 'Não foi possível confirmar a saída. Tente novamente.';
    byId('error').hidden = false;
  }
});
async function load() {
  refresh.disabled = true;
  byId('status').textContent = 'Carregando…';
  byId('error').hidden = true;
  byId('projects').replaceChildren();
  byId('vms').replaceChildren();
  selected = null;
  byId('selection').textContent = 'Nenhuma VM selecionada.';
  try {
    const vms = await get('/api/vms');
    byId('source').textContent = vms.source === 'mock' ? 'SIMULAÇÃO · source: mock · dados sintéticos · host: not_verified' : 'source: host · msb observado · formato real/integração: not_verified';
    for (const name of vms.projects) byId('projects').append(textElement('li', name));
    if (!vms.projects.length) byId('projects').append(textElement('li', 'Nenhum projeto autorizado encontrado.'));
    for (const vm of vms.vms) {
      const orphan = vm.orphaned ? ' · ÓRFÃ: diretório de projeto ausente' : '';
      const row = textElement('button', `${vm.vm_name} · ${vm.provider} · ${vm.project} · ${vm.state}${orphan}`);
      row.type = 'button';
      row.className = 'vm';
      row.setAttribute('aria-pressed', 'false');
      row.addEventListener('click', () => {
        selected = vm.vm_name;
        for (const button of byId('vms').children) button.setAttribute('aria-pressed', String(button === row));
        byId('selection').textContent = `Selecionada: ${selected} (somente leitura)`;
      });
      byId('vms').append(row);
    }
    if (!vms.vms.length) byId('vms').append(textElement('p', 'Nenhuma VM observada.'));
    byId('status').textContent = `Observado em ${vms.observed_at}`;
  } catch (error) {
    if (error.message === 'authentication_required') { showLogin(); return; }
    // Never present a previously successful observation as current after failure.
    byId('projects').replaceChildren();
    byId('vms').replaceChildren();
    byId('source').textContent = 'Origem indisponível · host: not_verified';
    byId('status').textContent = 'Discovery indisponível';
    byId('error').textContent = `Falha ao atualizar: ${error.message}`;
    byId('error').hidden = false;
  } finally { refresh.disabled = false; }
}
refresh.addEventListener('click', load);
init();
