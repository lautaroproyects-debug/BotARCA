/**
 * BotArca Core Frontend Controller
 * Complete high-performance dashboard for ARCA batch invoicing, multi-cuit accounts, and user management
 */

let authToken = localStorage.getItem('botarca_token') || '';
let currentUser = null;
let allAccounts = [];
let allClients = [];
let allComprobantes = [];
let parsedExcelItems = [];
let sseSource = null;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
  if (authToken) {
    hideLoginOverlay();
    await initApp();
  } else {
    showLoginOverlay();
  }
});

async function initApp() {
  await loadCurrentUser();
  await loadAccounts();
  await loadFinancialTicker();
  await loadQueueItems();
  await loadCRMClientes();
  await loadComprobantesList();
  await loadMonotributoStats();
  await loadKeepAliveSettings();
  if (currentUser && currentUser.role === 'admin') {
    await loadUsersList();
  }
  connectLogsSSE();

  // Polling automático
  setInterval(loadFinancialTicker, 60000);
  setInterval(loadQueueItems, 5000);
}

// --- AUTHENTICATION & LOGIN ---
function showLoginOverlay() {
  document.getElementById('loginOverlay')?.classList.remove('hidden');
}

function hideLoginOverlay() {
  document.getElementById('loginOverlay')?.classList.add('hidden');
}

async function handleUserLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('btnLoginSubmit');

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Verificando...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (data.success && data.token) {
      authToken = data.token;
      localStorage.setItem('botarca_token', authToken);
      currentUser = data.user;
      hideLoginOverlay();
      showToast(`¡Bienvenido, ${data.user.name || data.user.username}!`, 'success');
      await initApp();
    } else {
      showToast(data.message || 'Usuario o contraseña incorrectos.', 'error');
    }
  } catch (err) {
    showToast('Error conectando con el servidor.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Ingresar al Sistema</span> <i class="fa-solid fa-arrow-right text-xs"></i>';
  }
}

function handleUserLogout() {
  localStorage.removeItem('botarca_token');
  authToken = '';
  currentUser = null;
  if (sseSource) sseSource.close();
  showLoginOverlay();
  showToast('Sesión cerrada.', 'info');
}

async function loadCurrentUser() {
  try {
    const res = await fetchWithAuth('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      const el = document.getElementById('headerUserName');
      if (el) el.innerText = currentUser.username;

      const navUsers = document.getElementById('navTabUsers');
      if (navUsers) {
        if (currentUser.role === 'admin') navUsers.classList.remove('hidden');
        else navUsers.classList.add('hidden');
      }
    }
  } catch (e) {}
}

async function fetchWithAuth(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    handleUserLogout();
    throw new Error('Sesión no autorizada');
  }
  return response;
}

// --- NAVIGATION TABS ---
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-tab-btn').forEach(el => el.classList.remove('active'));

  const targetSection = document.getElementById(`tab-${tabId}`);
  if (targetSection) targetSection.classList.remove('hidden');

  const targetBtn = document.querySelector(`.nav-tab-btn[data-tab="${tabId}"]`);
  if (targetBtn) targetBtn.classList.add('active');

  if (tabId === 'cola') loadQueueItems();
  if (tabId === 'comprobantes') loadComprobantesList();
  if (tabId === 'crm') loadCRMClientes();
  if (tabId === 'cuentas') loadAccounts();
  if (tabId === 'users' && currentUser && currentUser.role === 'admin') loadUsersList();
  if (tabId === 'monotributo') loadMonotributoStats();
  if (tabId === 'settings') loadKeepAliveSettings();
}

// --- FINANCIAL TICKER (ArgentinaDatos) ---
async function loadFinancialTicker() {
  try {
    const res = await fetch('/api/finanzas/resumen');
    if (!res.ok) return;
    const data = await res.json();

    const d = data.dolares || {};
    if (d.oficial) document.getElementById('tickOficial').innerText = `$${d.oficial.compra} / $${d.oficial.venta}`;
    if (d.blue) document.getElementById('tickBlue').innerText = `$${d.blue.venta}`;
    if (d.mep) document.getElementById('tickMep').innerText = `$${d.mep.venta || d.mep.compra}`;
    if (d.ccl) document.getElementById('tickCcl').innerText = `$${d.ccl.venta || d.ccl.compra}`;
    if (data.inflacion?.ultimoIpc) document.getElementById('tickIpc').innerText = `${data.inflacion.ultimoIpc.valor}%`;
    if (data.uva?.ultimoValor) document.getElementById('tickUva').innerText = `$${data.uva.ultimoValor.valor}`;

    const updatedEl = document.getElementById('tickerUpdated');
    if (updatedEl) updatedEl.innerText = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {}
}

// --- MULTI-ACCOUNT CUIT MANAGEMENT ---
async function loadAccounts() {
  try {
    const res = await fetchWithAuth('/api/accounts');
    if (!res.ok) return;
    const data = await res.json();
    allAccounts = data.accounts || [];

    // Header selector
    const headerSel = document.getElementById('headerAccountSelect');
    if (headerSel) {
      if (allAccounts.length === 0) {
        headerSel.innerHTML = '<option value="">Sin CUIT configurado</option>';
      } else {
        headerSel.innerHTML = allAccounts.map(a => `
          <option value="${a.cuit}" ${a.cuit === data.activeCuit ? 'selected' : ''}>
            CUIT: ${formatCuit(a.cuit)} (${escapeHtml(a.razonSocial || 'Cuenta')})
          </option>
        `).join('');
      }
    }

    // Grid in accounts tab
    const grid = document.getElementById('accountsGrid');
    if (grid) {
      if (allAccounts.length === 0) {
        grid.innerHTML = '<div class="col-span-full py-8 text-center text-slate-500">No hay cuentas fiscales registradas aún.</div>';
      } else {
        grid.innerHTML = allAccounts.map(a => `
          <div class="p-4 bg-obsidian-850 border ${a.cuit === data.activeCuit ? 'border-amber-500/60 bg-amber-950/10' : 'border-obsidian-700'} rounded space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-slate-200 truncate">${escapeHtml(a.razonSocial || 'Empresa')}</span>
              ${a.cuit === data.activeCuit ? '<span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-bold">ACTIVA</span>' : ''}
            </div>
            <div class="text-[11px] text-slate-400">CUIT: <strong class="text-white select-all">${formatCuit(a.cuit)}</strong></div>
            <div class="text-[10px] text-slate-500">Punto de Venta: ${a.puntoVentaDefault || 1}</div>
            <div class="pt-2 border-t border-obsidian-800 flex justify-between items-center">
              ${a.cuit !== data.activeCuit ? `<button onclick="switchActiveCuitAccount('${a.cuit}')" class="text-[11px] text-amber-400 hover:text-amber-300 font-bold">Seleccionar como Emisor</button>` : '<span class="text-[10px] text-emerald-400">Emisor por defecto</span>'}
            </div>
          </div>
        `).join('');
      }
    }
  } catch (e) {}
}

async function switchActiveCuitAccount(cuit) {
  if (!cuit) return;
  try {
    const res = await fetchWithAuth('/api/accounts/switch', {
      method: 'POST',
      body: JSON.stringify({ cuit })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Emisor cambiado a CUIT ${cuit}.`, 'success');
      await loadAccounts();
      await loadAuthStatus();
    }
  } catch (e) {
    showToast('Error al cambiar cuenta.', 'error');
  }
}

function openNewAccountModal() {
  document.getElementById('accountModal')?.classList.remove('hidden');
}

function closeAccountModal() {
  document.getElementById('accountModal')?.classList.add('hidden');
}

async function handleSaveAccount(e) {
  e.preventDefault();
  const cuit = document.getElementById('accCuit').value.trim();
  const razonSocial = document.getElementById('accRazonSocial').value.trim();
  const claveFiscal = document.getElementById('accClaveFiscal').value;
  const puntoVentaDefault = parseInt(document.getElementById('accPuntoVenta').value || '1', 10);

  try {
    const res = await fetchWithAuth('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ cuit, razonSocial, claveFiscal, puntoVentaDefault })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Cuenta fiscal guardada y activada con éxito.', 'success');
      closeAccountModal();
      await loadAccounts();
      await loadAuthStatus();
    } else {
      showToast(data.message, 'error');
    }
  } catch (e) {
    showToast('Error al guardar cuenta.', 'error');
  }
}

// --- EXCEL & CSV PASTING (CARGA MASIVA) ---
async function handleExcelPasteChange(text) {
  if (!text || text.trim().length === 0) {
    parsedExcelItems = [];
    renderExcelPreview([]);
    return;
  }

  try {
    const res = await fetchWithAuth('/api/queue/parse-excel', {
      method: 'POST',
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (data.success) {
      parsedExcelItems = data.items || [];
      renderExcelPreview(parsedExcelItems);
    }
  } catch (e) {}
}

function renderExcelPreview(items) {
  const tbody = document.getElementById('excelPreviewTbody');
  const countText = document.getElementById('excelParsedCountText');
  const totalDisplay = document.getElementById('excelPreviewTotal');
  const btnAdd = document.getElementById('btnAddToQueue');

  if (countText) countText.innerText = `${items.length} filas válidas detectadas`;

  let sum = 0;
  items.forEach(i => sum += (i.importeTotal || 0));
  if (totalDisplay) totalDisplay.innerText = `$${sum.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;

  if (btnAdd) btnAdd.disabled = items.length === 0;

  if (!tbody) return;
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-500">Pega filas arriba para previsualizar.</td></tr>';
    return;
  }

  tbody.innerHTML = items.map((it, idx) => `
    <tr class="hover:bg-obsidian-850/60">
      <td class="py-2 px-3 text-slate-500">${idx + 1}</td>
      <td class="py-2 px-3 font-semibold text-slate-200 select-all">${it.docNro}</td>
      <td class="py-2 px-3 text-slate-300 truncate max-w-[180px]">${escapeHtml(it.razonSocial)}</td>
      <td class="py-2 px-3 text-slate-400 truncate max-w-[200px]">${escapeHtml(it.descripcion)}</td>
      <td class="py-2 px-3 text-amber-400 font-semibold">${it.tipoComprobante}</td>
      <td class="py-2 px-3 text-right font-bold text-slate-100">$${it.importeTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
    </tr>
  `).join('');
}

function loadSampleExcelData() {
  const sample = `30712345678\tEmpresa Alpha SRL\tServicios de Desarrollo de Software\t250000
20309998887\tMartín Rodríguez\tHonorarios Profesionales de Consultoría\t120000
30654321098\tGlobal Trade SA\tMantenimiento y soporte mensual IT\t180000
27321112223\tLucía Benítez\tAsesoramiento contable e impositivo\t95000`;
  const area = document.getElementById('excelPasteArea');
  if (area) {
    area.value = sample;
    handleExcelPasteChange(sample);
  }
}

function clearExcelPasteArea() {
  const area = document.getElementById('excelPasteArea');
  if (area) {
    area.value = '';
    handleExcelPasteChange('');
  }
}

async function submitExcelBatchToQueue() {
  if (parsedExcelItems.length === 0) {
    showToast('No hay filas para agregar a la cola.', 'warn');
    return;
  }

  const btn = document.getElementById('btnAddToQueue');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Agregando...';

  try {
    const res = await fetchWithAuth('/api/queue/add', {
      method: 'POST',
      body: JSON.stringify({ items: parsedExcelItems })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`¡${data.count} facturas agregadas a la cola de emisión!`, 'success');
      clearExcelPasteArea();
      switchTab('cola');
      await loadQueueItems();
    } else {
      showToast(data.message, 'error');
    }
  } catch (e) {
    showToast('Error al agregar a la cola.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-plus text-[11px]"></i> <span>AGREGAR A LA COLA DE FACTURACIÓN</span>';
  }
}

// --- LIVE QUEUE ENGINE (COLA DE FACTURACIÓN) ---
async function loadQueueItems() {
  try {
    const res = await fetchWithAuth('/api/queue');
    if (!res.ok) return;
    const data = await res.json();

    const badgePendientes = document.getElementById('badgeColaPendientes');
    const qPend = document.getElementById('queueCountPendientes');
    const qEmit = document.getElementById('queueCountEmitidas');
    const btnProcess = document.getElementById('btnProcessQueue');
    const cockpit = document.getElementById('cockpitBanner');

    if (badgePendientes) badgePendientes.innerText = data.pendientes || 0;
    if (qPend) qPend.innerText = `${data.pendientes || 0} pendientes`;
    if (qEmit) qEmit.innerText = `${data.emitidas || 0} emitidas`;

    if (btnProcess) btnProcess.disabled = data.isProcessing || data.pendientes === 0;

    // Cockpit status
    if (cockpit) {
      if (data.isProcessing) {
        cockpit.classList.remove('hidden');
        const pct = data.total > 0 ? Math.round(((data.emitidas + data.errores) / data.total) * 100) : 0;
        document.getElementById('cockpitPercent').innerText = `${pct}%`;
        document.getElementById('cockpitProgressBar').style.width = `${pct}%`;
        document.getElementById('cockpitStatusMsg').innerText = `Procesando lote en ARCA: ${data.emitidas + data.errores} de ${data.total} comprobantes procesados...`;
      } else {
        cockpit.classList.add('hidden');
      }
    }

    renderQueueTable(data.items || []);
  } catch (e) {}
}

function renderQueueTable(items) {
  const tbody = document.getElementById('queueTableBody');
  if (!tbody) return;

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500 font-mono text-xs">La cola de facturación está vacía. Pega una planilla en "Carga Masiva".</td></tr>';
    return;
  }

  tbody.innerHTML = items.map(it => {
    let statusBadge = '<span class="px-2 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-800 text-[10px] font-bold uppercase">Pendiente</span>';
    if (it.estado === 'procesando') {
      statusBadge = '<span class="px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 text-[10px] font-bold uppercase animate-pulse"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Emitiendo</span>';
    } else if (it.estado === 'emitida') {
      statusBadge = '<span class="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 text-[10px] font-bold uppercase">Emitida</span>';
    } else if (it.estado === 'error') {
      statusBadge = '<span class="px-2 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800 text-[10px] font-bold uppercase">Error</span>';
    }

    let resultado = it.cae ? `<span class="text-amber-400 font-bold select-all text-xs">CAE: ${it.cae}</span> <span class="text-slate-500 text-[10px]">(${it.comprobanteNro || ''})</span>` : (it.errorMensaje ? `<span class="text-rose-400 text-[11px] truncate max-w-[200px] block" title="${escapeHtml(it.errorMensaje)}">${escapeHtml(it.errorMensaje)}</span>` : '<span class="text-slate-500">-</span>');

    return `
      <tr class="hover:bg-obsidian-850/60 transition">
        <td class="py-2.5 px-3">${statusBadge}</td>
        <td class="py-2.5 px-3">
          <div class="text-slate-200 font-semibold truncate max-w-[180px]">${escapeHtml(it.razonSocial)}</div>
          <div class="text-[10px] text-slate-500 font-mono">Doc: ${it.docNro}</div>
        </td>
        <td class="py-2.5 px-3 text-slate-300 truncate max-w-[180px]">${escapeHtml(it.descripcion)}</td>
        <td class="py-2.5 px-3 text-slate-400">${it.tipoComprobante} (Pto ${it.puntoVenta})</td>
        <td class="py-2.5 px-3 text-right font-bold text-slate-100">$${(it.importeTotal || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
        <td class="py-2.5 px-3">${resultado}</td>
        <td class="py-2.5 px-3 text-center">
          ${it.estado === 'pendiente' ? `<button onclick="deleteQueueItem('${it.id}')" class="text-slate-600 hover:text-rose-400 transition" title="Eliminar de la cola"><i class="fa-solid fa-trash-can text-xs"></i></button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

async function startProcessingQueue() {
  showToast('Iniciando procesamiento de la cola de facturación en ARCA...', 'info');
  try {
    const res = await fetchWithAuth('/api/queue/process', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Motor iniciado. Puedes ver el avance en la terminal y en la barra superior.', 'success');
      await loadQueueItems();
    }
  } catch (e) {
    showToast('Error al iniciar procesamiento de la cola.', 'error');
  }
}

async function deleteQueueItem(id) {
  try {
    await fetchWithAuth(`/api/queue/${id}`, { method: 'DELETE' });
    await loadQueueItems();
  } catch (e) {}
}

async function clearQueueCompleted() {
  try {
    await fetchWithAuth('/api/queue/clear', { method: 'POST', body: JSON.stringify({ status: 'emitida' }) });
    showToast('Comprobantes emitidos removidos de la cola.', 'info');
    await loadQueueItems();
  } catch (e) {}
}

// --- USER MANAGEMENT (ADMIN PANEL) ---
async function loadUsersList() {
  if (!currentUser || currentUser.role !== 'admin') return;
  try {
    const res = await fetchWithAuth('/api/users');
    if (!res.ok) return;
    const data = await res.json();
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    tbody.innerHTML = (data.users || []).map(u => `
      <tr class="hover:bg-obsidian-850/60 transition">
        <td class="py-2.5 px-3">
          <strong class="text-slate-200 block">${escapeHtml(u.name)}</strong>
          <span class="text-slate-500 text-[11px]">@${escapeHtml(u.username)}</span>
        </td>
        <td class="py-2.5 px-3 text-slate-300">${escapeHtml(u.email)}</td>
        <td class="py-2.5 px-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${u.role === 'admin' ? 'bg-amber-950 text-amber-400 border border-amber-800' : 'bg-obsidian-800 text-slate-300 border border-obsidian-600'}">
            ${u.role}
          </span>
        </td>
        <td class="py-2.5 px-3">
          <span class="text-xs ${u.active ? 'text-emerald-400' : 'text-rose-400'} font-semibold">
            ${u.active ? '● Activo' : '○ Inactivo'}
          </span>
        </td>
        <td class="py-2.5 px-3 text-slate-400 text-[11px]">${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('es-AR') : 'Nunca'}</td>
        <td class="py-2.5 px-3 text-right">
          ${u.id !== currentUser.id ? `<button onclick="deleteUser('${u.id}')" class="text-slate-600 hover:text-rose-400 p-1" title="Eliminar"><i class="fa-solid fa-trash-can text-xs"></i></button>` : '<span class="text-[10px] text-slate-500">Tú</span>'}
        </td>
      </tr>
    `).join('');
  } catch (e) {}
}

function openNewUserModal() {
  document.getElementById('userModal')?.classList.remove('hidden');
}

function closeUserModal() {
  document.getElementById('userModal')?.classList.add('hidden');
}

async function handleSaveUser(e) {
  e.preventDefault();
  const name = document.getElementById('usrName').value.trim();
  const username = document.getElementById('usrUsername').value.trim();
  const email = document.getElementById('usrEmail').value.trim();
  const password = document.getElementById('usrPassword').value;
  const role = document.getElementById('usrRole').value;

  try {
    const res = await fetchWithAuth('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name, username, email, password, role })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Usuario @${username} creado con éxito.`, 'success');
      closeUserModal();
      await loadUsersList();
    } else {
      showToast(data.message, 'error');
    }
  } catch (e) {
    showToast('Error al crear usuario.', 'error');
  }
}

async function deleteUser(id) {
  if (!confirm('¿Seguro de eliminar este usuario?')) return;
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

// --- FAST INVOICING (INDIVIDUAL) ---
function addInvoiceItem() {
  const container = document.getElementById('invoiceItemsContainer');
  const div = document.createElement('div');
  div.className = 'invoice-item-row grid grid-cols-12 gap-2 items-center bg-obsidian-850 p-2.5 rounded border border-obsidian-700';
  div.innerHTML = `
    <div class="col-span-12 sm:col-span-6">
      <input type="text" class="item-desc input-field text-xs" placeholder="Descripción..." required>
    </div>
    <div class="col-span-3 sm:col-span-2">
      <input type="number" class="item-qty input-field font-mono text-xs text-center" value="1" min="1" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-7 sm:col-span-3">
      <input type="number" class="item-price input-field font-mono text-xs" value="0" min="0" step="0.01" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-2 sm:col-span-1 text-center">
      <button type="button" onclick="removeInvoiceItem(this)" class="text-slate-500 hover:text-rose-400 transition text-sm">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `;
  container.appendChild(div);
  calculateInvoiceTotals();
}

function removeInvoiceItem(btn) {
  const row = btn.closest('.invoice-item-row');
  const container = document.getElementById('invoiceItemsContainer');
  if (container.children.length > 1) {
    row.remove();
    calculateInvoiceTotals();
  }
}

function setQuickItemDesc(desc) {
  const firstDesc = document.querySelector('.invoice-item-row .item-desc');
  if (firstDesc) firstDesc.value = desc;
}

function calculateInvoiceTotals() {
  const rows = document.querySelectorAll('.invoice-item-row');
  let total = 0;
  rows.forEach(r => {
    const qty = parseFloat(r.querySelector('.item-qty')?.value || '0');
    const price = parseFloat(r.querySelector('.item-price')?.value || '0');
    total += (qty * price);
  });
  const displayEl = document.getElementById('facTotalDisplay');
  if (displayEl) displayEl.innerText = `$${total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
  return total;
}

function formatInputCuit(input) {
  let val = input.value.replace(/\D/g, '');
  if (val.length === 11) {
    input.value = `${val.substring(0, 2)}-${val.substring(2, 10)}-${val.substring(10, 11)}`;
  }
}

async function handleEmitirFactura(e) {
  e.preventDefault();
  const tipoComprobante = document.getElementById('facTipo').value;
  const puntoVenta = parseInt(document.getElementById('facPuntoVenta').value || '1', 10);
  const concepto = parseInt(document.getElementById('facConcepto').value || '2', 10);
  const tipoDoc = document.getElementById('facTipoDoc').value;
  const nroDoc = document.getElementById('facNroDoc').value.replace(/\D/g, '');
  const razonSocial = document.getElementById('facRazonSocial').value.trim();
  const condicionIva = document.getElementById('facCondIva').value;
  const condicionVenta = document.getElementById('facCondVenta').value;

  const rows = document.querySelectorAll('.invoice-item-row');
  const items = [];
  rows.forEach(r => {
    const descripcion = r.querySelector('.item-desc').value.trim();
    const cantidad = parseFloat(r.querySelector('.item-qty').value || '1');
    const precioUnitario = parseFloat(r.querySelector('.item-price').value || '0');
    items.push({ descripcion, cantidad, precioUnitario, subtotal: cantidad * precioUnitario });
  });

  const payload = { tipoComprobante, puntoVenta, concepto, condicionVenta, receptor: { tipoDoc, nroDoc, razonSocial, condicionIva }, items };

  const btn = document.getElementById('btnEmitirComprobante');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Conectando con ARCA...';

  try {
    const res = await fetchWithAuth('/api/erp/facturacion/emitir', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('¡Comprobante autorizado con éxito en ARCA!', 'success');
      document.getElementById('lastCaeNumber').innerText = data.cae || '-';
      document.getElementById('lastCaeVto').innerText = data.caeVencimiento || '-';
      document.getElementById('lastComprobanteNro').innerText = data.comprobanteNro || '-';
      document.getElementById('caeStatusDot').className = 'w-2 h-2 rounded-full bg-emerald-400';
      loadComprobantesList();
    } else {
      showToast(`Error de emisión: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error de comunicación: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i> <span>EMITIR EN ARCA</span>';
  }
}

// --- COMPROBANTES HISTORIAL ---
async function loadComprobantesList() {
  try {
    const res = await fetchWithAuth('/api/erp/comprobantes');
    if (!res.ok) return;
    const data = await res.json();
    allComprobantes = data.comprobantes || [];
    renderComprobantesTable(allComprobantes);
  } catch (e) {}
}

function renderComprobantesTable(list) {
  const tbody = document.getElementById('comprobantesTableBody');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-500 font-mono text-xs">No hay comprobantes emitidos registrados aún.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(c => `
    <tr class="hover:bg-obsidian-850/60 transition">
      <td class="py-2.5 px-3 text-slate-400">${c.fechaEmision || c.fecha_emision || '-'}</td>
      <td class="py-2.5 px-3">
        <strong class="text-amber-400 font-semibold">${escapeHtml(c.tipoComprobante || c.tipo_comprobante || 'Factura C')}</strong>
        <span class="text-slate-500 ml-1 font-mono">${c.comprobanteFormato || c.comprobante_formato || '-'}</span>
      </td>
      <td class="py-2.5 px-3">
        <div class="text-slate-200 font-semibold truncate max-w-[200px]">${escapeHtml(c.razonSocialReceptor || c.razon_social_receptor || 'Consumidor Final')}</div>
        <div class="text-[10px] text-slate-500 font-mono">CUIT: ${c.cuitReceptor || c.cuit_receptor || '-'}</div>
      </td>
      <td class="py-2.5 px-3 text-right font-bold text-slate-100">$${(c.importeTotal || c.importe_total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
      <td class="py-2.5 px-3">
        <span class="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 text-[10px] font-bold">CAE: ${c.cae || '-'}</span>
      </td>
    </tr>
  `).join('');
}

function filterComprobantesTable(query) {
  const q = query.toLowerCase();
  const filtered = allComprobantes.filter(c => 
    (c.cae && c.cae.includes(q)) ||
    (c.cuitReceptor && c.cuitReceptor.includes(q)) ||
    (c.razonSocialReceptor && c.razonSocialReceptor.toLowerCase().includes(q))
  );
  renderComprobantesTable(filtered);
}

// --- CLIENTES CRM LIGERO ---
async function loadCRMClientes() {
  try {
    const res = await fetchWithAuth('/api/erp/clientes');
    if (!res.ok) return;
    const data = await res.json();
    allClients = data.clientes || [];
    renderClientsGrid(allClients);
    populateQuickClientSelector(allClients);
  } catch (e) {}
}

function renderClientsGrid(clients) {
  const container = document.getElementById('clientsGrid');
  if (!container) return;

  if (clients.length === 0) {
    container.innerHTML = '<div class="col-span-full py-6 text-center text-slate-500 font-mono text-xs">No hay clientes frecuentes registrados.</div>';
    return;
  }

  container.innerHTML = clients.map(c => `
    <div class="p-3.5 bg-obsidian-850 border border-obsidian-700 rounded space-y-2 font-mono text-xs hover:border-obsidian-600 transition">
      <div class="flex items-start justify-between">
        <div class="truncate">
          <strong class="text-slate-200 text-[13px] font-bold block truncate">${escapeHtml(c.razonSocial)}</strong>
          <span class="text-slate-500 text-[11px]">CUIT: ${c.cuit}</span>
        </div>
        <button onclick="deleteClient('${c.id}')" class="text-slate-600 hover:text-rose-400 transition p-1"><i class="fa-solid fa-trash-can text-xs"></i></button>
      </div>
      <div class="text-[11px] text-slate-400">Condición: <span class="text-amber-400/90">${c.condicionIva}</span></div>
      <div class="pt-1 border-t border-obsidian-700 flex justify-end">
        <button onclick="selectClientAndInvoice('${c.id}')" class="text-[11px] text-amber-400 hover:text-amber-300 font-bold flex items-center space-x-1">
          <span>Facturar a este cliente</span>
          <i class="fa-solid fa-arrow-right text-[10px]"></i>
        </button>
      </div>
    </div>
  `).join('');
}

function populateQuickClientSelector(clients) {
  const select = document.getElementById('facQuickClientSelect');
  if (!select) return;
  select.innerHTML = '<option value="">-- Cargar de Clientes --</option>' +
    clients.map(c => `<option value="${c.id}">${escapeHtml(c.razonSocial)} (${c.cuit})</option>`).join('');
}

function applySelectedClientToInvoice(clientId) {
  if (!clientId) return;
  const client = allClients.find(c => c.id === clientId);
  if (!client) return;
  document.getElementById('facRazonSocial').value = client.razonSocial;
  document.getElementById('facNroDoc').value = client.cuit;
  document.getElementById('facCondIva').value = client.condicionIva || 'Consumidor Final';
  showToast(`Datos de ${client.razonSocial} cargados.`, 'info');
}

function selectClientAndInvoice(clientId) {
  switchTab('facturacion');
  const select = document.getElementById('facQuickClientSelect');
  if (select) select.value = clientId;
  applySelectedClientToInvoice(clientId);
}

function openClientModal() {
  document.getElementById('clientModal')?.classList.remove('hidden');
}

function closeClientModal() {
  document.getElementById('clientModal')?.classList.add('hidden');
}

async function handleSaveClient(e) {
  e.preventDefault();
  const razonSocial = document.getElementById('crmRazonSocial').value.trim();
  const tipoDoc = document.getElementById('crmTipoDoc').value;
  const cuit = document.getElementById('crmCuit').value.replace(/\D/g, '');
  const condicionIva = document.getElementById('crmCondIva').value;

  try {
    const res = await fetchWithAuth('/api/erp/clientes', {
      method: 'POST',
      body: JSON.stringify({ razonSocial, tipoDoc, cuit, condicionIva })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Cliente guardado.', 'success');
      closeClientModal();
      await loadCRMClientes();
    } else {
      showToast(data.message, 'error');
    }
  } catch (e) {
    showToast('Error al guardar cliente.', 'error');
  }
}

async function deleteClient(id) {
  if (!confirm('¿Eliminar cliente?')) return;
  try {
    await fetchWithAuth(`/api/erp/clientes/${id}`, { method: 'DELETE' });
    showToast('Cliente eliminado.', 'info');
    await loadCRMClientes();
  } catch (e) {}
}

// --- MONOTRIBUTO & DFE ---
async function loadMonotributoStats() {
  try {
    const res = await fetchWithAuth('/api/erp/monotributo/status');
    if (!res.ok) return;
    const data = await res.json();
    if (data.categoria) {
      const badge = document.getElementById('monoCategoriaBadge');
      if (badge) badge.innerText = `Categoría ${data.categoria} (${data.tipoActividad || 'Servicios'})`;
    }
  } catch (e) {}
}

async function loadDfeNotifications() {
  try {
    const res = await fetchWithAuth('/api/erp/dfe/notificaciones');
    if (!res.ok) return;
    const data = await res.json();
    const list = data.notificaciones || [];
    const container = document.getElementById('dfeInboxList');
    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = '<div class="p-3 text-center text-slate-500 text-xs font-mono">Sin notificaciones pendientes en ARCA.</div>';
      return;
    }

    container.innerHTML = list.map(n => `
      <div class="p-3 bg-obsidian-850 rounded border border-obsidian-700 space-y-1 font-mono">
        <div class="flex justify-between text-[10px] text-slate-500">
          <span>${escapeHtml(n.organismo || 'ARCA')}</span>
          <span>${n.fecha || '-'}</span>
        </div>
        <div class="text-slate-200 font-semibold text-[11px]">${escapeHtml(n.asunto || 'Notificación Oficial')}</div>
        <p class="text-[10px] text-slate-400">${escapeHtml(n.resumen || '')}</p>
      </div>
    `).join('');
  } catch (e) {}
}

// --- CONFIG & SUPABASE ---
async function loadAuthStatus() {
  try {
    const res = await fetchWithAuth('/api/auth/status');
    if (!res.ok) return;
    const data = await res.json();
    if (data.cuit) {
      const facPto = document.getElementById('facPuntoVenta');
      if (facPto) facPto.value = data.puntoVentaDefault || 1;
    }
  } catch (e) {}
}

async function testArcaConnection() {
  showToast('Iniciando sesión en ARCA en modo Headless...', 'info');
  try {
    const res = await fetchWithAuth('/api/auth/test-login', { method: 'POST', body: JSON.stringify({}) });
    const data = await res.json();
    if (data.success) {
      showToast(`¡Conexión Exitosa con ARCA! Titular: ${data.razonSocial}`, 'success');
      await loadAccounts();
    } else {
      showToast(`Fallo de conexión: ${data.message}`, 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  }
}

async function handleSaveSupabase(e) {
  e.preventDefault();
  const url = document.getElementById('cfgSupaUrl').value.trim();
  const key = document.getElementById('cfgSupaKey').value.trim();

  try {
    const res = await fetchWithAuth('/api/erp/supabase/connect', {
      method: 'POST',
      body: JSON.stringify({ url, key })
    });
    const data = await res.json();
    if (data.success) {
      showToast('¡Supabase conectado y sincronizado exitosamente!', 'success');
      const badge = document.getElementById('supaStatusText');
      if (badge) badge.innerText = 'Supabase: OK';
    } else {
      showToast(data.message, 'warn');
    }
  } catch (e) {
    showToast('Error conectando con Supabase.', 'error');
  }
}

async function handleSaveKeepAlive(e) {
  e.preventDefault();
  const externalUrl = document.getElementById('cfgExternalUrl').value.trim();
  const uptimeRobotApiKey = document.getElementById('cfgUptimeRobotKey').value.trim();

  try {
    const res = await fetchWithAuth('/api/keepalive/config', {
      method: 'POST',
      body: JSON.stringify({ externalUrl, uptimeRobotApiKey, keepAliveEnabled: true, keepAliveIntervalMinutes: 5 })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Configuración de Keep-Alive guardada.', 'success');
    }
  } catch (e) {
    showToast('Error al guardar Keep-Alive.', 'error');
  }
}

async function loadKeepAliveSettings() {
  try {
    const res = await fetchWithAuth('/api/keepalive/health');
    if (!res.ok) return;
    const data = await res.json();
    if (data.settings) {
      if (data.settings.externalUrl) document.getElementById('cfgExternalUrl').value = data.settings.externalUrl;
      if (data.settings.uptimeRobotApiKey) document.getElementById('cfgUptimeRobotKey').value = data.settings.uptimeRobotApiKey;
    }
  } catch (e) {}
}

async function syncUptimeRobotMonitor() {
  const url = document.getElementById('cfgExternalUrl')?.value;
  showToast('Sincronizando monitor en UptimeRobot...', 'info');
  try {
    const res = await fetchWithAuth('/api/keepalive/uptimerobot/sync', {
      method: 'POST',
      body: JSON.stringify({ targetUrl: url })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
    } else {
      showToast(data.message, 'warn');
    }
  } catch (e) {
    showToast('Error al sincronizar con UptimeRobot.', 'error');
  }
}

// --- LIVE LOGS SSE ---
function connectLogsSSE() {
  if (sseSource) sseSource.close();
  try {
    sseSource = new EventSource('/api/logs/stream');
    sseSource.onmessage = (event) => {
      try {
        const log = JSON.parse(event.data);
        appendTerminalLog(log);
      } catch (e) {}
    };
    sseSource.onerror = () => {
      if (sseSource) sseSource.close();
    };
  } catch (e) {}
}

function appendTerminalLog(log) {
  const screen = document.getElementById('terminalScreen');
  if (!screen) return;

  const div = document.createElement('div');
  const levelClass = `log-level-${log.level.toLowerCase()}`;
  div.innerHTML = `<span class="text-slate-500">[${log.timestamp.split('T')[1].split('.')[0]}]</span> <strong class="${levelClass}">[${log.module}]</strong> <span>${escapeHtml(log.message)}</span>`;
  screen.appendChild(div);
  screen.scrollTop = screen.scrollHeight;
}

function clearLogsConsole() {
  const screen = document.getElementById('terminalScreen');
  if (screen) screen.innerHTML = '<div class="text-slate-600">[SISTEMA] Consola limpia.</div>';
}

function reconnectLogsSSE() {
  connectLogsSSE();
  showToast('Reconectando streaming de logs...', 'info');
}

// --- UTILS & TOASTS ---
function formatCuit(cuit) {
  if (!cuit) return '-';
  const c = String(cuit).replace(/\D/g, '');
  if (c.length === 11) {
    return `${c.substring(0, 2)}-${c.substring(2, 10)}-${c.substring(10, 11)}`;
  }
  return c;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  const colors = {
    success: 'bg-obsidian-850 border-emerald-500/60 text-emerald-300',
    error: 'bg-obsidian-850 border-rose-500/60 text-rose-300',
    warn: 'bg-obsidian-850 border-amber-500/60 text-amber-300',
    info: 'bg-obsidian-850 border-obsidian-600 text-slate-200',
  };

  const icons = {
    success: 'fa-circle-check text-emerald-400',
    error: 'fa-circle-exclamation text-rose-400',
    warn: 'fa-triangle-exclamation text-amber-400',
    info: 'fa-circle-info text-amber-400',
  };

  toast.className = `pointer-events-auto p-3 rounded border shadow-xl flex items-center space-x-2.5 text-xs font-mono transition-all duration-300 translate-y-2 opacity-0 ${colors[type] || colors.info}`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || icons.info} text-sm"></i>
    <span class="flex-1">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => toast.classList.remove('translate-y-2', 'opacity-0'), 10);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
