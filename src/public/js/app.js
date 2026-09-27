// BotArca ERP & Headless Automation Frontend Application Logic
let sseSource = null;
let logCount = 0;
let crmClientsList = [];
let catalogProductsList = [];
let liveDolares = [];
let currentUser = null;
let cotizacionOficialVenta = 1060;

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

// Helper de peticiones autenticadas con JWT
async function fetchWithAuth(url, options = {}) {
  const token = localStorage.getItem('botarca_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    // No autenticado o sesión vencida
    currentUser = null;
    localStorage.removeItem('botarca_token');
    document.getElementById('loginOverlay').classList.remove('hidden');
    throw new Error('Sesión no autorizada o expirada.');
  }

  return response;
}

async function initApp() {
  initDates();

  // Verificar si hay sesión guardada
  const token = localStorage.getItem('botarca_token');
  if (!token) {
    document.getElementById('loginOverlay').classList.remove('hidden');
    return;
  }

  const authenticated = await loadCurrentUserProfile();
  if (!authenticated) {
    document.getElementById('loginOverlay').classList.remove('hidden');
    return;
  }

  document.getElementById('loginOverlay').classList.add('hidden');
  setupSSELogs();
  await loadAuthStatus();
  await loadFinanzasData();
  await loadCRMClientes();
  await loadCatalogProducts();
  await loadDashboardStats();
  await loadTaskHistory();
  await loadKeepAliveSettings();
  await loadSupabaseStatus();
  await loadMonotributoStatus();
  await loadNotificacionesDFE();

  if (currentUser && currentUser.role === 'admin') {
    await loadUsersList();
  }

  // Polling de cotizaciones y stats cada 20 segundos
  setInterval(() => {
    if (currentUser) {
      loadFinanzasData();
      loadDashboardStats();
      loadTaskHistory();
    }
  }, 20000);
}

// --- AUTENTICACIÓN DE USUARIOS & SESIÓN ---
async function handleUserLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('btnLoginSubmit');

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Verificando...';

  try {
    const res = await fetch('/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();
    if (data.success && data.token) {
      localStorage.setItem('botarca_token', data.token);
      currentUser = data.user;
      updateUserHeaderProfile();
      document.getElementById('loginOverlay').classList.add('hidden');
      showToast(`¡Bienvenido/a, ${currentUser.name}!`, 'success');
      await initApp();
    } else {
      showToast(data.message || 'Usuario o contraseña incorrectos.', 'error');
    }
  } catch (err) {
    showToast(`Error de conexión al autenticar: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Ingresar al Sistema</span><i class="fa-solid fa-arrow-right text-xs ml-2"></i>';
  }
}

async function loadCurrentUserProfile() {
  try {
    const res = await fetchWithAuth('/api/users/me');
    const data = await res.json();
    if (data.success && data.user) {
      currentUser = data.user;
      updateUserHeaderProfile();
      return true;
    }
  } catch (e) {}
  return false;
}

function updateUserHeaderProfile() {
  if (!currentUser) return;

  const nameEl = document.getElementById('headerUserName');
  const roleEl = document.getElementById('headerUserRole');
  const letterEl = document.getElementById('userAvatarLetter');
  const tabUsersBtn = document.getElementById('tabBtnUsers');

  if (nameEl) nameEl.innerText = currentUser.name || currentUser.username;
  if (roleEl) roleEl.innerText = currentUser.role;
  if (letterEl) letterEl.innerText = (currentUser.name || currentUser.username).charAt(0).toUpperCase();

  // Mostrar u ocultar pestaña de administración de usuarios
  if (tabUsersBtn) {
    if (currentUser.role === 'admin') {
      tabUsersBtn.classList.remove('hidden');
    } else {
      tabUsersBtn.classList.add('hidden');
    }
  }
}

function handleUserLogout() {
  localStorage.removeItem('botarca_token');
  currentUser = null;
  document.getElementById('loginOverlay').classList.remove('hidden');
  showToast('Has cerrado sesión correctamente.', 'info');
}

// --- GESTIÓN DE USUARIOS (SOLO ADMIN) ---
async function loadUsersList() {
  if (!currentUser || currentUser.role !== 'admin') return;

  try {
    const res = await fetchWithAuth('/api/users');
    const data = await res.json();
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    if (!data.success || !data.users || data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500">No hay otros usuarios registrados.</td></tr>';
      return;
    }

    tbody.innerHTML = data.users.map(u => {
      let roleBadge = '<span class="px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 font-semibold uppercase text-[10px]">Operador</span>';
      if (u.role === 'admin') roleBadge = '<span class="px-2 py-0.5 rounded bg-violet-950 text-violet-300 font-semibold uppercase text-[10px]">Administrador</span>';
      if (u.role === 'viewer') roleBadge = '<span class="px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-semibold uppercase text-[10px]">Solo Lectura</span>';

      const statusBadge = u.active
        ? '<span class="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 font-semibold text-[10px]">Activo</span>'
        : '<span class="px-2 py-0.5 rounded bg-rose-950 text-rose-300 font-semibold text-[10px]">Inactivo</span>';

      const lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('es-AR') + ' ' + new Date(u.lastLoginAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : 'Nunca';

      const isSelf = currentUser && currentUser.id === u.id;

      return `
        <tr class="hover:bg-slate-800/40 transition">
          <td class="py-3 px-3">
            <div class="font-semibold text-slate-100">${escapeHtml(u.name)}</div>
            <div class="text-[11px] text-indigo-400 font-mono">@${escapeHtml(u.username)}</div>
          </td>
          <td class="py-3 px-3 text-slate-300">${escapeHtml(u.email)}</td>
          <td class="py-3 px-3">${roleBadge}</td>
          <td class="py-3 px-3">${statusBadge}</td>
          <td class="py-3 px-3 text-slate-400 text-[11px] font-mono">${lastLogin}</td>
          <td class="py-3 px-3 text-right space-x-2">
            <button onclick="openResetPasswordModal('${u.id}', '${u.username}')" class="px-2.5 py-1 bg-amber-600/30 hover:bg-amber-600 text-amber-200 rounded text-[11px] font-bold transition">
              <i class="fa-solid fa-key mr-1"></i> Clave
            </button>
            ${!isSelf ? `
              <button onclick="toggleUserActive('${u.id}', ${!u.active})" class="px-2.5 py-1 ${u.active ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-emerald-600 hover:bg-emerald-500 text-white'} rounded text-[11px] font-bold transition">
                ${u.active ? 'Desactivar' : 'Activar'}
              </button>
              <button onclick="deleteUser('${u.id}')" class="text-slate-500 hover:text-red-400 transition text-sm">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            ` : '<span class="text-[10px] text-slate-500 italic">(Tu cuenta)</span>'}
          </td>
        </tr>
      `;
    }).join('');

  } catch (e) {
    console.error('Error cargando lista de usuarios:', e);
  }
}

function openNewUserModal() {
  document.getElementById('userModal').classList.remove('hidden');
}

function closeUserModal() {
  document.getElementById('userModal').classList.add('hidden');
}

async function handleSaveUser(e) {
  e.preventDefault();
  const name = document.getElementById('usrName').value;
  const username = document.getElementById('usrUsername').value;
  const email = document.getElementById('usrEmail').value;
  const password = document.getElementById('usrPassword').value;
  const role = document.getElementById('usrRole').value;

  try {
    const res = await fetchWithAuth('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name, username, email, password, role }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('Usuario creado correctamente.', 'success');
      closeUserModal();
      await loadUsersList();
    } else {
      showToast(data.message, 'error');
    }
  } catch (err) {
    showToast('Error al crear usuario.', 'error');
  }
}

function openResetPasswordModal(id, username) {
  document.getElementById('resetUserId').value = id;
  document.getElementById('resetUserLabel').innerText = `@${username}`;
  document.getElementById('resetNewPassword').value = '';
  document.getElementById('resetPassModal').classList.remove('hidden');
}

function closeResetPassModal() {
  document.getElementById('resetPassModal').classList.add('hidden');
}

async function handleResetPasswordSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('resetUserId').value;
  const newPassword = document.getElementById('resetNewPassword').value;

  try {
    const res = await fetchWithAuth(`/api/users/${id}/reset-password`, {
      method: 'PUT',
      body: JSON.stringify({ newPassword }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('Contraseña restablecida con éxito.', 'success');
      closeResetPassModal();
    } else {
      showToast(data.message, 'error');
    }
  } catch (err) {
    showToast('Error al restablecer contraseña.', 'error');
  }
}

async function toggleUserActive(id, active) {
  try {
    const res = await fetchWithAuth(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ active }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Usuario ${active ? 'activado' : 'desactivado'}.`, 'info');
      await loadUsersList();
    }
  } catch (e) {}
}

async function deleteUser(id) {
  if (!confirm('¿Seguro que deseas eliminar este usuario permanentemente?')) return;
  try {
    const res = await fetchWithAuth(`/api/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Usuario eliminado.', 'info');
      await loadUsersList();
    } else {
      showToast(data.message, 'error');
    }
  } catch (e) {}
}

// Inicializar fechas por defecto
function initDates() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];

  const desdeInput = document.getElementById('compFilterDesde');
  const hastaInput = document.getElementById('compFilterHasta');
  if (desdeInput) desdeInput.value = firstDay;
  if (hastaInput) hastaInput.value = today;
}

// Conectar con flujo de logs en tiempo real (Server-Sent Events)
function setupSSELogs() {
  if (sseSource) {
    sseSource.close();
  }

  const terminal = document.getElementById('terminalScreen');
  sseSource = new EventSource('/api/logs/stream');

  sseSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        terminal.innerHTML = '';
        data.logs.forEach(entry => appendLogEntry(entry));
      } else if (data.type === 'log') {
        appendLogEntry(data.entry);
      }
    } catch (e) {
      console.error('Error parseando mensaje SSE:', e);
    }
  };

  sseSource.onerror = () => {
    console.warn('Conexión SSE perdida. Reintentando automáticamente...');
  };
}

function appendLogEntry(entry) {
  const terminal = document.getElementById('terminalScreen');
  if (!terminal) return;

  logCount++;
  const badge = document.getElementById('logBadgeCount');
  if (badge) badge.innerText = logCount > 99 ? '99+' : logCount;

  const div = document.createElement('div');
  div.className = 'py-0.5 leading-relaxed';

  let levelColor = 'text-sky-400';
  if (entry.level === 'success') levelColor = 'text-emerald-400';
  if (entry.level === 'warn') levelColor = 'text-amber-400';
  if (entry.level === 'error') levelColor = 'text-rose-400 font-bold';

  div.innerHTML = `
    <span class="text-slate-500">[${entry.timestamp}]</span>
    <span class="text-indigo-400 font-semibold">[${entry.category}]</span>
    <span class="${levelColor}">[${entry.level.toUpperCase()}]</span>
    <span class="text-slate-200">${escapeHtml(entry.message)}</span>
  `;

  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
}

function clearLogsConsole() {
  const terminal = document.getElementById('terminalScreen');
  if (terminal) terminal.innerHTML = '<div class="text-slate-500">[SISTEMA] Consola limpiada. Esperando nuevos eventos...</div>';
  logCount = 0;
  const badge = document.getElementById('logBadgeCount');
  if (badge) badge.innerText = '0';
}

function reconnectLogsSSE() {
  setupSSELogs();
}

// Cambio de pestaña
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });

  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.add('hidden');
  });

  const activeContent = document.getElementById(`tab-${tabId}`);
  if (activeContent) {
    activeContent.classList.remove('hidden');
  }
}

// --- FINANZAS & ARGENTINADATOS ---
async function loadFinanzasData() {
  try {
    const res = await fetchWithAuth('/api/finanzas/indicadores');
    const data = await res.json();

    if (data.success) {
      liveDolares = data.dolares || [];
      
      const oficial = liveDolares.find(d => d.casa === 'oficial') || liveDolares[0];
      const blue = liveDolares.find(d => d.casa === 'blue');
      const mep = liveDolares.find(d => d.casa === 'bolsa');
      const ccl = liveDolares.find(d => d.casa === 'contadoconliqui');

      if (oficial) {
        cotizacionOficialVenta = oficial.venta || 1060;
        document.getElementById('tickOficial').innerText = `C: $${oficial.compra} / V: $${oficial.venta}`;
        const cotizDisplay = document.getElementById('invCotizDolarDisplay');
        if (cotizDisplay) cotizDisplay.innerText = `$${oficial.venta.toLocaleString('es-AR')}`;
      }
      if (blue) document.getElementById('tickBlue').innerText = `C: $${blue.compra} / V: $${blue.venta}`;
      if (mep) document.getElementById('tickMep').innerText = `$${mep.venta}`;
      if (ccl) document.getElementById('tickCcl').innerText = `$${ccl.venta}`;

      if (data.inflacionMensual && data.inflacionMensual.length > 0) {
        const lastIpc = data.inflacionMensual[data.inflacionMensual.length - 1];
        document.getElementById('tickIpc').innerText = `${lastIpc.valor}% (${lastIpc.fecha})`;
      }

      if (data.uva && data.uva.length > 0) {
        const lastUva = data.uva[data.uva.length - 1];
        document.getElementById('tickUva').innerText = `$${lastUva.valor}`;
      }

      document.getElementById('tickerUpdated').innerText = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

      renderDolaresCards();
      handleConvertCurrency();
    }
  } catch (err) {}
}

function renderDolaresCards() {
  const container = document.getElementById('dolaresCardsGrid');
  if (!container || !liveDolares.length) return;

  container.innerHTML = liveDolares.map(d => {
    let badgeColor = 'bg-indigo-950 text-indigo-300 border-indigo-800';
    if (d.casa === 'blue') badgeColor = 'bg-emerald-950 text-emerald-300 border-emerald-800';
    if (d.casa === 'bolsa') badgeColor = 'bg-cyan-950 text-cyan-300 border-cyan-800';

    return `
      <div class="bg-slate-950/70 border border-slate-800 rounded-xl p-4 space-y-2 hover:border-slate-700 transition">
        <div class="flex items-center justify-between">
          <span class="font-bold text-slate-100 text-sm">${d.nombre || d.casa}</span>
          <span class="text-[10px] px-2 py-0.5 rounded-full border ${badgeColor} uppercase font-semibold">${d.casa}</span>
        </div>
        <div class="grid grid-cols-2 gap-2 pt-1 text-xs">
          <div>
            <span class="text-slate-400 text-[10px]">Compra</span>
            <p class="font-bold text-slate-200 font-mono text-sm">$${(d.compra || 0).toLocaleString('es-AR')}</p>
          </div>
          <div>
            <span class="text-slate-400 text-[10px]">Venta</span>
            <p class="font-black text-emerald-400 font-mono text-base">$${(d.venta || 0).toLocaleString('es-AR')}</p>
          </div>
        </div>
        <span class="text-[9px] text-slate-500 block font-mono">Actualizado: ${d.fechaActualizacion ? d.fechaActualizacion.slice(0, 10) : 'Hoy'}</span>
      </div>
    `;
  }).join('');
}

async function handleConvertCurrency() {
  const amount = parseFloat(document.getElementById('calcAmount')?.value || '0');
  const from = document.getElementById('calcFrom')?.value || 'USD';
  const to = document.getElementById('calcTo')?.value || 'ARS';
  const tipoDolar = document.getElementById('calcTipoDolar')?.value || 'oficial';

  const resDisplay = document.getElementById('calcResultDisplay');
  const tasaDisplay = document.getElementById('calcTasaDisplay');
  if (!resDisplay) return;

  if (amount <= 0) {
    resDisplay.innerText = '$ 0,00';
    return;
  }

  try {
    const res = await fetchWithAuth('/api/finanzas/convert', {
      method: 'POST',
      body: JSON.stringify({ amount, from, to, tipoDolar }),
    });
    const data = await res.json();
    if (data.success) {
      const sym = to === 'USD' ? 'USD $' : '$';
      resDisplay.innerText = `${sym} ${data.result.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      tasaDisplay.innerText = `Tipo de cambio (${data.casa}): 1 USD = $${data.tipoCambio.toLocaleString('es-AR')}`;
    }
  } catch (e) {}
}

// --- CRM CLIENTES ---
async function loadCRMClientes() {
  try {
    const res = await fetchWithAuth('/api/erp/clientes');
    const data = await res.json();
    if (data.success && data.clientes) {
      crmClientsList = data.clientes;
      renderClientsTable();
      populateQuickClientDropdown();
    }
  } catch (e) {}
}

function renderClientsTable() {
  const tbody = document.getElementById('clientsTableBody');
  if (!tbody) return;

  if (crmClientsList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-500">No hay clientes registrados aún. Haz click en "Nuevo Cliente".</td></tr>';
    return;
  }

  tbody.innerHTML = crmClientsList.map(c => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="py-3 px-3 font-semibold text-slate-100">${escapeHtml(c.razonSocial)}</td>
      <td class="py-3 px-3 font-mono text-indigo-300">${formatCuit(c.cuit)} (${c.tipoDoc})</td>
      <td class="py-3 px-3"><span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-semibold">${c.condicionIva}</span></td>
      <td class="py-3 px-3 text-slate-400">${escapeHtml(c.email || c.telefono || '-')}</td>
      <td class="py-3 px-3 text-right space-x-2">
        <button onclick="selectClientForInvoiceById('${c.id}')" class="px-2.5 py-1 bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 rounded text-[11px] font-bold transition">
          <i class="fa-solid fa-file-invoice mr-1"></i> Facturar
        </button>
        <button onclick="deleteClient('${c.id}')" class="text-slate-500 hover:text-red-400 transition text-sm">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

function populateQuickClientDropdown() {
  const select = document.getElementById('quickClientSelect');
  if (!select) return;

  select.innerHTML = '<option value="">👤 Cargar Cliente del CRM...</option>' +
    crmClientsList.map(c => `<option value="${c.id}">${c.razonSocial} (${formatCuit(c.cuit)})</option>`).join('');
}

function handleSelectClientForInvoice(clientId) {
  if (!clientId) return;
  selectClientForInvoiceById(clientId);
}

function selectClientForInvoiceById(clientId) {
  const c = crmClientsList.find(x => x.id === clientId);
  if (!c) return;

  switchTab('facturacion');
  document.getElementById('facDocTipo').value = c.tipoDoc || 'CUIT';
  document.getElementById('facDocNro').value = c.cuit;
  document.getElementById('facRazonSocial').value = c.razonSocial;
  document.getElementById('facCondIva').value = c.condicionIva || 'Consumidor Final';

  showToast(`Cliente "${c.razonSocial}" cargado en el facturador.`, 'info');
}

function openNewClientModal() {
  document.getElementById('clientModal').classList.remove('hidden');
}

function closeClientModal() {
  document.getElementById('clientModal').classList.add('hidden');
}

async function handleSaveClient(e) {
  e.preventDefault();
  const razonSocial = document.getElementById('crmRazonSocial').value;
  const cuit = document.getElementById('crmCuit').value;
  const tipoDoc = document.getElementById('crmTipoDoc').value;
  const condicionIva = document.getElementById('crmCondIva').value;
  const email = document.getElementById('crmEmail').value;
  const domicilio = document.getElementById('crmDomicilio').value;

  try {
    const res = await fetchWithAuth('/api/erp/clientes', {
      method: 'POST',
      body: JSON.stringify({ razonSocial, cuit, tipoDoc, condicionIva, email, domicilio }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('Cliente guardado con éxito.', 'success');
      closeClientModal();
      await loadCRMClientes();
    } else {
      showToast(data.message, 'error');
    }
  } catch (err) {
    showToast('Error al guardar cliente.', 'error');
  }
}

async function deleteClient(id) {
  if (!confirm('¿Deseas eliminar este cliente?')) return;
  try {
    const res = await fetchWithAuth(`/api/erp/clientes/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Cliente eliminado.', 'info');
      await loadCRMClientes();
    }
  } catch (e) {}
}

async function saveCurrentInvoiceClientToCRM() {
  const razonSocial = document.getElementById('facRazonSocial').value;
  const cuit = document.getElementById('facDocNro').value;
  const tipoDoc = document.getElementById('facDocTipo').value;
  const condicionIva = document.getElementById('facCondIva').value;

  if (!cuit || !razonSocial) {
    showToast('Completa el CUIT y la Razón Social para guardar en CRM.', 'warn');
    return;
  }

  try {
    const res = await fetchWithAuth('/api/erp/clientes', {
      method: 'POST',
      body: JSON.stringify({ razonSocial, cuit, tipoDoc, condicionIva }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('Cliente guardado en CRM.', 'success');
      await loadCRMClientes();
    }
  } catch (e) {}
}

// --- CATÁLOGO DE PRODUCTOS & SERVICIOS ---
async function loadCatalogProducts() {
  try {
    const res = await fetchWithAuth('/api/erp/productos');
    const data = await res.json();
    if (data.success && data.productos) {
      catalogProductsList = data.productos;
      renderProductsTable();
      populateQuickProductDropdown();
    }
  } catch (e) {}
}

function renderProductsTable() {
  const tbody = document.getElementById('productsTableBody');
  if (!tbody) return;

  if (catalogProductsList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500">No hay productos en catálogo. Haz click en "Nuevo Producto/Servicio".</td></tr>';
    return;
  }

  tbody.innerHTML = catalogProductsList.map(p => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="py-3 px-3 font-mono font-bold text-indigo-300">${p.codigo}</td>
      <td class="py-3 px-3 font-medium text-slate-100">${escapeHtml(p.nombre)}</td>
      <td class="py-3 px-3 text-slate-400 text-xs">${p.categoria}</td>
      <td class="py-3 px-3 text-right font-mono text-slate-300">USD $${p.precioUsd.toFixed(2)}</td>
      <td class="py-3 px-3 text-right font-mono font-bold text-emerald-400">$ ${p.precioArs.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
      <td class="py-3 px-3 text-right space-x-2">
        <button onclick="insertProductIntoInvoice('${p.id}')" class="px-2.5 py-1 bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 rounded text-[11px] font-bold transition">
          <i class="fa-solid fa-plus mr-1"></i> Facturar
        </button>
        <button onclick="deleteProduct('${p.id}')" class="text-slate-500 hover:text-red-400 transition text-sm">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

function populateQuickProductDropdown() {
  const select = document.getElementById('quickProductSelect');
  if (!select) return;

  select.innerHTML = '<option value="">📦 Insertar desde Catálogo...</option>' +
    catalogProductsList.map(p => `<option value="${p.id}">${p.nombre} - $${p.precioArs.toLocaleString('es-AR')}</option>`).join('');
}

function handleSelectProductForInvoice(productId) {
  if (!productId) return;
  insertProductIntoInvoice(productId);
}

function insertProductIntoInvoice(productId) {
  const p = catalogProductsList.find(x => x.id === productId);
  if (!p) return;

  const moneda = document.getElementById('facMoneda')?.value || 'ARS';
  const unitPrice = moneda === 'USD' ? p.precioUsd : p.precioArs;

  const container = document.getElementById('invoiceItemsContainer');
  const div = document.createElement('div');
  div.className = 'invoice-item-row grid grid-cols-12 gap-2 items-center bg-slate-950/40 p-3 rounded-xl border border-slate-800/80';
  div.innerHTML = `
    <div class="col-span-12 md:col-span-6">
      <input type="text" class="item-desc input-dark text-xs" placeholder="Descripción..." value="${escapeHtml(p.nombre)}" required>
    </div>
    <div class="col-span-4 md:col-span-2">
      <input type="number" class="item-qty input-dark text-xs" placeholder="Cant." value="1" min="1" step="1" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-6 md:col-span-3">
      <input type="number" class="item-price input-dark text-xs" placeholder="Precio" value="${unitPrice}" min="0" step="0.01" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-2 md:col-span-1 text-center">
      <button type="button" onclick="removeInvoiceItem(this)" class="text-slate-500 hover:text-red-400 text-sm">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `;
  container.appendChild(div);
  calculateInvoiceTotals();
  showToast(`Producto "${p.nombre}" añadido a la factura.`, 'info');
}

function openNewProductModal() {
  document.getElementById('productModal').classList.remove('hidden');
}

function closeProductModal() {
  document.getElementById('productModal').classList.add('hidden');
}

async function handleSaveProduct(e) {
  e.preventDefault();
  const codigo = document.getElementById('prodCodigo').value;
  const nombre = document.getElementById('prodNombre').value;
  const precioUsd = parseFloat(document.getElementById('prodPrecioUsd').value || '0');
  const precioArs = parseFloat(document.getElementById('prodPrecioArs').value || '0');
  const autoAjusteDolar = document.getElementById('prodAutoAjusteDolar').checked;

  try {
    const res = await fetchWithAuth('/api/erp/productos', {
      method: 'POST',
      body: JSON.stringify({ codigo, nombre, precioUsd, precioArs, autoAjusteDolar }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('Producto guardado en catálogo.', 'success');
      closeProductModal();
      await loadCatalogProducts();
    } else {
      showToast(data.message, 'error');
    }
  } catch (err) {
    showToast('Error al guardar producto.', 'error');
  }
}

async function deleteProduct(id) {
  if (!confirm('¿Deseas eliminar este producto?')) return;
  try {
    const res = await fetchWithAuth(`/api/erp/productos/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Producto eliminado.', 'info');
      await loadCatalogProducts();
    }
  } catch (e) {}
}

// --- SUPABASE SYNC ---
async function loadSupabaseStatus() {
  try {
    const res = await fetchWithAuth('/api/erp/supabase/status');
    const data = await res.json();

    const badge = document.getElementById('supaStatusText');
    const formBadge = document.getElementById('supaStatusBadgeForm');

    if (data.connected) {
      if (badge) badge.innerText = 'Supabase: Conectado';
      if (formBadge) formBadge.innerText = 'Estado: Conectado a la nube';
    } else if (data.enabled) {
      if (badge) badge.innerText = 'Supabase: Configurado';
      if (formBadge) formBadge.innerText = 'Estado: Configurado';
    } else {
      if (badge) badge.innerText = 'Supabase: Local';
      if (formBadge) formBadge.innerText = 'Estado: Almacenamiento local';
    }
  } catch (e) {}
}

async function handleSaveSupabase(e) {
  e.preventDefault();
  const url = document.getElementById('cfgSupaUrl').value;
  const key = document.getElementById('cfgSupaKey').value;

  try {
    const res = await fetchWithAuth('/api/erp/supabase/connect', {
      method: 'POST',
      body: JSON.stringify({ url, key }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('¡Supabase conectado y verificado exitosamente!', 'success');
      loadSupabaseStatus();
      loadCRMClientes();
      loadCatalogProducts();
      if (currentUser && currentUser.role === 'admin') loadUsersList();
    } else {
      showToast(`Supabase: ${data.message}`, 'warn');
    }
  } catch (err) {
    showToast('Error conectando con Supabase.', 'error');
  }
}

function openSchemaSqlModal() {
  document.getElementById('schemaSqlModal').classList.remove('hidden');
}

function closeSchemaSqlModal() {
  document.getElementById('schemaSqlModal').classList.add('hidden');
}

// --- AUTH & ARCA CONNECTION ---
async function loadAuthStatus() {
  try {
    const res = await fetchWithAuth('/api/auth/status');
    const data = await res.json();

    const alertBox = document.getElementById('unconfiguredAlert');
    const dashTitular = document.getElementById('dashTitular');
    const dashCuit = document.getElementById('dashCuit');
    const cfgCuit = document.getElementById('cfgCuit');
    const cfgPuntoVenta = document.getElementById('cfgPuntoVenta');
    const facPuntoVenta = document.getElementById('facPuntoVenta');
    const facPtoVtaBadge = document.getElementById('facPtoVtaBadge');

    if (data.cuit) {
      if (alertBox) alertBox.classList.add('hidden');
      if (cfgCuit) cfgCuit.value = data.cuit;
      if (cfgPuntoVenta) cfgPuntoVenta.value = data.puntoVentaDefault || 1;
      if (facPuntoVenta) facPuntoVenta.value = data.puntoVentaDefault || 1;
      if (facPtoVtaBadge) facPtoVtaBadge.innerText = data.puntoVentaDefault || 1;

      dashCuit.innerText = `CUIT: ${formatCuit(data.cuit)}`;
      dashTitular.innerText = data.razonSocial || 'Conectado';
    } else {
      if (alertBox) alertBox.classList.remove('hidden');
      dashTitular.innerText = 'Sin configurar';
      dashCuit.innerText = 'Configura CUIT y Clave';
    }
  } catch (err) {}
}

async function loadDashboardStats() {
  try {
    const res = await fetchWithAuth('/api/keepalive/health');
    const data = await res.json();

    const uptimeEl = document.getElementById('dashUptime');
    const pingsEl = document.getElementById('dashPings');
    const keepAliveText = document.getElementById('keepAliveText');

    if (uptimeEl) uptimeEl.innerText = data.uptimeFormatted;
    if (pingsEl) pingsEl.innerText = `${data.totalPings} pings de actividad`;
    if (keepAliveText) keepAliveText.innerText = `Keep-Alive: ${data.uptimeFormatted}`;

  } catch (err) {}
}

async function loadTaskHistory() {
  try {
    const res = await fetchWithAuth('/api/tasks/history?limit=10');
    const data = await res.json();
    const tbody = document.getElementById('taskHistoryTableBody');
    if (!tbody) return;

    if (!data.tasks || data.tasks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="py-6 text-center text-slate-500">No hay ejecuciones registradas aún.</td></tr>';
      return;
    }

    tbody.innerHTML = data.tasks.map(t => {
      let statusBadge = '<span class="px-2 py-0.5 rounded bg-amber-950 text-amber-300 font-semibold">En curso</span>';
      if (t.status === 'success') {
        statusBadge = '<span class="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 font-semibold">Éxito</span>';
      } else if (t.status === 'failed') {
        statusBadge = '<span class="px-2 py-0.5 rounded bg-rose-950 text-rose-300 font-semibold">Error</span>';
      }

      const hora = new Date(t.startedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      return `
        <tr class="hover:bg-slate-800/40 transition">
          <td class="py-2.5 px-3 font-semibold uppercase text-indigo-300">${t.type}</td>
          <td class="py-2.5 px-3">${statusBadge}</td>
          <td class="py-2.5 px-3 text-slate-400 font-mono">${hora}</td>
          <td class="py-2.5 px-3 text-slate-300">${escapeHtml(t.resultSummary || t.error || '-')}</td>
        </tr>
      `;
    }).join('');

  } catch (err) {}
}

async function testArcaConnection() {
  showToast('Iniciando prueba de conexión con ARCA en backend con evasión WAF...', 'info');
  try {
    const res = await fetchWithAuth('/api/auth/test-login', { method: 'POST', body: JSON.stringify({}) });
    const data = await res.json();

    if (data.success) {
      showToast(`¡Conexión Exitosa con ARCA! Titular: ${data.razonSocial}`, 'success');
      loadAuthStatus();
    } else {
      showToast(`Fallo de conexión: ${data.message}`, 'error');
    }
  } catch (e) {
    showToast(`Error de comunicación: ${e.message}`, 'error');
  }
}

async function handleSaveCreds(e) {
  e.preventDefault();
  const cuit = document.getElementById('cfgCuit').value;
  const claveFiscal = document.getElementById('cfgClaveFiscal').value;
  const puntoVenta = document.getElementById('cfgPuntoVenta').value;

  try {
    const res = await fetchWithAuth('/api/auth/credentials', {
      method: 'POST',
      body: JSON.stringify({ cuit, claveFiscal, puntoVentaDefault: puntoVenta }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('Credenciales de ARCA guardadas y encriptadas con éxito.', 'success');
      loadAuthStatus();
    } else {
      showToast(data.message, 'error');
    }
  } catch (err) {
    showToast('Error al guardar credenciales.', 'error');
  }
}

async function handleSaveKeepAlive(e) {
  e.preventDefault();
  const enabled = document.getElementById('cfgKeepAliveEnabled').checked;
  const interval = document.getElementById('cfgKeepAliveInterval').value;
  const url = document.getElementById('cfgExternalUrl').value;
  const uptimeRobotKey = document.getElementById('cfgUptimeRobotKey').value;

  try {
    const res = await fetchWithAuth('/api/keepalive/config', {
      method: 'POST',
      body: JSON.stringify({
        keepAliveEnabled: enabled,
        keepAliveIntervalMinutes: parseInt(interval, 10),
        externalUrl: url,
        uptimeRobotApiKey: uptimeRobotKey,
      }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('Configuración de Keep-Alive y UptimeRobot actualizada.', 'success');
      await checkUptimeRobotStatus();
    }
  } catch (err) {
    showToast('Error al guardar Keep-Alive.', 'error');
  }
}

async function loadKeepAliveSettings() {
  try {
    const res = await fetchWithAuth('/api/keepalive/health');
    const data = await res.json();
    if (data.settings) {
      const chk = document.getElementById('cfgKeepAliveEnabled');
      const intInput = document.getElementById('cfgKeepAliveInterval');
      const urlInput = document.getElementById('cfgExternalUrl');
      const uptimeKeyInput = document.getElementById('cfgUptimeRobotKey');
      if (chk) chk.checked = data.settings.keepAliveEnabled;
      if (intInput) intInput.value = data.settings.keepAliveIntervalMinutes;
      if (urlInput) urlInput.value = data.settings.externalUrl || '';
      if (uptimeKeyInput && data.settings.uptimeRobotApiKey) uptimeKeyInput.value = data.settings.uptimeRobotApiKey;
    }
    await checkUptimeRobotStatus();
  } catch (e) {}
}

async function checkUptimeRobotStatus() {
  const detailsEl = document.getElementById('uptimeRobotDetails');
  const badgeText = document.getElementById('uptimeRobotStatusText');
  const liveBadge = document.getElementById('uptimeRobotLiveBadge');
  if (!detailsEl) return;

  try {
    detailsEl.innerHTML = '<span class="text-slate-500"><i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Consultando API de UptimeRobot...</span>';
    const res = await fetchWithAuth('/api/keepalive/uptimerobot/status');
    const data = await res.json();

    if (data.success && data.monitors && data.monitors.length > 0) {
      if (liveBadge) liveBadge.classList.remove('hidden');
      if (badgeText) badgeText.innerText = `UptimeRobot: ${data.monitors.length} Monitor(es)`;

      detailsEl.innerHTML = `
        <div class="space-y-2">
          ${data.monitors.map(m => {
            let statusColor = 'text-emerald-400 bg-emerald-950/80 border-emerald-800';
            let statusLabel = 'OPERATIVO (UP)';
            if (m.status === 0) {
              statusColor = 'text-amber-400 bg-amber-950/80 border-amber-800';
              statusLabel = 'PAUSADO';
            } else if (m.status === 8 || m.status === 9) {
              statusColor = 'text-rose-400 bg-rose-950/80 border-rose-800';
              statusLabel = 'CAÍDO (DOWN)';
            }

            return `
              <div class="flex items-center justify-between p-2.5 bg-slate-900 border border-slate-800/80 rounded-lg">
                <div class="space-y-0.5">
                  <div class="flex items-center space-x-2">
                    <strong class="text-slate-200 text-xs">${escapeHtml(m.friendly_name)}</strong>
                    <span class="px-2 py-0.5 text-[10px] font-mono border rounded-full ${statusColor}">${statusLabel}</span>
                  </div>
                  <div class="text-[11px] text-slate-400 font-mono truncate max-w-md">${escapeHtml(m.url)}</div>
                </div>
                <div class="text-right">
                  <div class="text-xs font-bold text-emerald-400">${m.all_time_uptime_ratio || '100'}% Uptime</div>
                  <div class="text-[10px] text-slate-500 font-mono">ID: ${m.id}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else if (data.success && (!data.monitors || data.monitors.length === 0)) {
      if (badgeText) badgeText.innerText = 'UptimeRobot: Sin monitores';
      detailsEl.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="text-slate-400">API Key conectada correctamente, pero aún no hay monitores registrados para esta URL.</span>
          <button type="button" onclick="syncUptimeRobotMonitor()" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition">Crear Monitor Ahora</button>
        </div>
      `;
    } else {
      if (badgeText) badgeText.innerText = 'UptimeRobot: Pendiente';
      detailsEl.innerHTML = `<span class="text-amber-400/90"><i class="fa-solid fa-triangle-exclamation mr-1"></i> ${escapeHtml(data.error || 'No se pudo conectar con UptimeRobot.')}</span>`;
    }
  } catch (err) {
    if (detailsEl) detailsEl.innerHTML = '<span class="text-rose-400">Error al consultar UptimeRobot.</span>';
  }
}

async function syncUptimeRobotMonitor() {
  const url = document.getElementById('cfgExternalUrl')?.value;
  showToast('Registrando monitor en UptimeRobot...', 'info');

  try {
    const res = await fetchWithAuth('/api/keepalive/uptimerobot/sync', {
      method: 'POST',
      body: JSON.stringify({ targetUrl: url }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      await checkUptimeRobotStatus();
    } else {
      showToast(data.message, 'warn');
    }
  } catch (e) {
    showToast('Error al sincronizar con UptimeRobot.', 'error');
  }
}

async function triggerManualPing() {
  try {
    const res = await fetchWithAuth('/api/keepalive/trigger', { method: 'POST' });
    const data = await res.json();
    showToast(`Keep-Alive: ${data.message}`, 'success');
    loadDashboardStats();
  } catch (e) {
    showToast('Error al enviar ping.', 'error');
  }
}

// --- FACTURADOR ACTIONS ---
function addInvoiceItem() {
  const container = document.getElementById('invoiceItemsContainer');
  const div = document.createElement('div');
  div.className = 'invoice-item-row grid grid-cols-12 gap-2 items-center bg-slate-950/40 p-3 rounded-xl border border-slate-800/80';
  div.innerHTML = `
    <div class="col-span-12 md:col-span-6">
      <input type="text" class="item-desc input-dark text-xs" placeholder="Descripción del servicio o producto..." required>
    </div>
    <div class="col-span-4 md:col-span-2">
      <input type="number" class="item-qty input-dark text-xs" placeholder="Cant." value="1" min="1" step="1" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-6 md:col-span-3">
      <input type="number" class="item-price input-dark text-xs" placeholder="Precio Unitario" value="0" min="0" step="0.01" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-2 md:col-span-1 text-center">
      <button type="button" onclick="removeInvoiceItem(this)" class="text-slate-500 hover:text-red-400 text-sm">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `;
  container.appendChild(div);
  calculateInvoiceTotals();
}

function removeInvoiceItem(button) {
  const row = button.closest('.invoice-item-row');
  const container = document.getElementById('invoiceItemsContainer');
  if (container.children.length > 1) {
    row.remove();
    calculateInvoiceTotals();
  } else {
    showToast('La factura debe tener al menos un renglón.', 'warn');
  }
}

function calculateInvoiceTotals() {
  const rows = document.querySelectorAll('.invoice-item-row');
  const moneda = document.getElementById('facMoneda')?.value || 'ARS';
  let total = 0;

  rows.forEach(row => {
    const qty = parseFloat(row.querySelector('.item-qty')?.value || '0');
    const price = parseFloat(row.querySelector('.item-price')?.value || '0');
    total += qty * price;
  });

  const display = document.getElementById('invoiceTotalDisplay');
  if (display) {
    const prefix = moneda === 'USD' ? 'USD $' : '$';
    display.innerText = `${prefix} ${total.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return total;
}

async function handleEmitirFactura(e) {
  e.preventDefault();
  const btn = document.getElementById('btnEmitirFactura');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Procesando en ARCA (Headless)...';

  const ptoVta = parseInt(document.getElementById('facPuntoVenta').value, 10);
  const tipoComp = document.getElementById('facTipoComp').value;
  const concepto = parseInt(document.getElementById('facConcepto').value, 10);
  const docTipo = document.getElementById('facDocTipo').value;
  const docNro = document.getElementById('facDocNro').value;
  const razonSocial = document.getElementById('facRazonSocial').value;
  const condIva = document.getElementById('facCondIva').value;
  const condVenta = document.getElementById('facCondVenta').value;

  const items = [];
  document.querySelectorAll('.invoice-item-row').forEach(row => {
    const desc = row.querySelector('.item-desc').value;
    const qty = parseFloat(row.querySelector('.item-qty').value);
    const price = parseFloat(row.querySelector('.item-price').value);
    items.push({
      descripcion: desc,
      cantidad: qty,
      precioUnitario: price,
      subtotal: qty * price,
    });
  });

  const payload = {
    puntoVenta: ptoVta,
    tipoComprobante: tipoComp,
    concepto,
    receptor: {
      tipoDoc: docTipo,
      nroDoc: docNro,
      razonSocial,
      condicionIva: condIva,
    },
    condicionVenta: condVenta,
    items,
  };

  try {
    const res = await fetchWithAuth('/api/tasks/facturar', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    if (result.success) {
      showToast('¡Factura autorizada y emitida en ARCA!', 'success');
      const box = document.getElementById('invoiceSuccessBox');
      box.classList.remove('hidden');
      document.getElementById('invResultNro').innerText = result.comprobanteNro;
      document.getElementById('invResultCae').innerText = result.cae;
      document.getElementById('invResultVto').innerText = result.caeVencimiento;
      document.getElementById('invResultTotal').innerText = `$ ${result.totalImporte.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
      loadTaskHistory();
    } else {
      showToast(`Error al facturar: ${result.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error de conexión: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-stamp"></i><span>Autorizar y Emitir en ARCA</span>';
  }
}

// --- MIS COMPROBANTES ---
async function buscarComprobantes() {
  const tipo = document.getElementById('compFilterTipo').value;
  const desde = document.getElementById('compFilterDesde').value;
  const hasta = document.getElementById('compFilterHasta').value;
  const tbody = document.getElementById('comprobantesTableBody');

  tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Consultando registros en ARCA...</td></tr>';

  try {
    const res = await fetchWithAuth('/api/tasks/comprobantes', {
      method: 'POST',
      body: JSON.stringify({ tipo, fechaDesde: desde, fechaHasta: hasta }),
    });
    const data = await res.json();

    if (data.success && data.comprobantes) {
      if (data.comprobantes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500">No se encontraron comprobantes para el período indicado.</td></tr>';
        return;
      }

      tbody.innerHTML = data.comprobantes.map(c => `
        <tr class="hover:bg-slate-800/40 transition">
          <td class="py-2.5 px-3 font-mono">${c.fecha}</td>
          <td class="py-2.5 px-3 font-semibold text-slate-200">${c.tipo}</td>
          <td class="py-2.5 px-3 font-mono text-indigo-300">${String(c.puntoVenta).padStart(4, '0')}-${String(c.numero).padStart(8, '0')}</td>
          <td class="py-2.5 px-3 font-medium">${c.denominacionReceptor}</td>
          <td class="py-2.5 px-3 text-slate-400 font-mono">${c.nroDocReceptor || '-'}</td>
          <td class="py-2.5 px-3 text-right font-bold text-emerald-400 font-mono">$ ${c.importeTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
          <td class="py-2.5 px-3 font-mono text-slate-400 text-[11px]">${c.cae || '-'}</td>
        </tr>
      `).join('');

      document.getElementById('compSummaryFooter').classList.remove('hidden');
      document.getElementById('compCountLabel').innerText = `${data.totalRegistros} comprobantes encontrados`;
      document.getElementById('compTotalSum').innerText = `$ ${data.totalImporte.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
      showToast(`Consulta completada: ${data.totalRegistros} comprobantes.`, 'success');
    } else {
      tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-rose-400">Error: ${data.message}</td></tr>`;
      showToast(data.message, 'error');
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-rose-400">Error de conexión con el backend.</td></tr>`;
  }
}

// --- MONOTRIBUTO & DFE ---
async function loadMonotributoStatus() {
  try {
    const res = await fetchWithAuth('/api/tasks/monotributo');
    const data = await res.json();
    if (data.success) {
      document.getElementById('dashCategoria').innerText = data.categoria || 'Cat C';
      document.getElementById('monoCatVal').innerText = data.categoria || 'Cat C';
      document.getElementById('monoRecatVal').innerText = data.proximaRecategorizacion || 'Julio 2026';
      
      const pct = data.porcentajeConsumido || 58.16;
      document.getElementById('monoProgressBar').style.width = `${pct}%`;
      document.getElementById('monoProgressText').innerText = `${pct}%`;
      document.getElementById('monoAcumVal').innerText = `$ ${(data.facturacionAcumuladaAnual || 0).toLocaleString('es-AR')}`;
      document.getElementById('monoTopeVal').innerText = `$ ${(data.topeCategoriaAnual || 0).toLocaleString('es-AR')}`;
    }
  } catch (e) {}
}

async function loadNotificacionesDFE() {
  const container = document.getElementById('dfeNotifList');
  try {
    const res = await fetchWithAuth('/api/tasks/notificaciones');
    const data = await res.json();
    if (data.success && data.comunicaciones) {
      document.getElementById('dashNotifCount').innerText = `${data.unreadCount} sin leer`;
      
      container.innerHTML = data.comunicaciones.map(n => `
        <div class="p-3 bg-slate-950/60 rounded-xl border ${n.leido ? 'border-slate-800' : 'border-violet-700/60 bg-violet-950/20'} flex items-start justify-between">
          <div class="space-y-1">
            <div class="flex items-center space-x-2">
              <span class="font-bold text-slate-100">${n.organismo}</span>
              ${!n.leido ? '<span class="px-1.5 py-0.2 bg-violet-600 text-white rounded text-[9px] font-bold">NUEVA</span>' : ''}
            </div>
            <p class="text-slate-300 text-[11px]">${n.asunto}</p>
            <span class="text-[10px] text-slate-500 font-mono">${n.fecha}</span>
          </div>
        </div>
      `).join('');
    }
  } catch (e) {}
}

function quickSyncComprobantes() {
  switchTab('comprobantes');
  buscarComprobantes();
}

function quickCheckDFE() {
  switchTab('monotributo');
  loadNotificacionesDFE();
}

// --- UTILS ---
function formatCuit(cuit) {
  if (!cuit || cuit.length !== 11) return cuit || '-';
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  let bg = 'bg-slate-900 border-indigo-500 text-slate-100';
  if (type === 'success') bg = 'bg-slate-900 border-emerald-500 text-emerald-300';
  if (type === 'error') bg = 'bg-slate-900 border-rose-500 text-rose-300';
  if (type === 'warn') bg = 'bg-slate-900 border-amber-500 text-amber-300';

  toast.className = `fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl border shadow-2xl text-xs font-semibold flex items-center space-x-2 transition-all duration-300 transform translate-y-10 opacity-0 ${bg}`;
  toast.innerHTML = `<i class="fa-solid fa-circle-info"></i><span>${escapeHtml(message)}</span>`;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('translate-y-10', 'opacity-0');
  }, 50);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-5');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
