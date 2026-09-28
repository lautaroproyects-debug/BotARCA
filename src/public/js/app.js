/**
 * BotArca Frontend Core Engine
 * Minimalist, high-reliability controller for ARCA headless automation and invoicing
 */

let authToken = localStorage.getItem('botarca_token') || '';
let currentUser = null;
let allClients = [];
let allComprobantes = [];
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
  await loadFinancialTicker();
  await loadAuthStatus();
  await loadCRMClientes();
  await loadComprobantesList();
  await loadMonotributoStats();
  await loadKeepAliveSettings();
  connectLogsSSE();

  // Polling discreto de cotizaciones financieras cada 60 segundos
  setInterval(loadFinancialTicker, 60000);
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
      showToast(data.message || 'Credenciales incorrectas.', 'error');
    }
  } catch (err) {
    showToast('Error de conexión con el servidor.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Iniciar Sesión</span> <i class="fa-solid fa-arrow-right text-xs"></i>';
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
    const res = await fetchWithAuth('/api/users/me');
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      const el = document.getElementById('headerUserName');
      if (el) el.innerText = currentUser.username;
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
  if (response.status === 401 || response.status === 403) {
    handleUserLogout();
    throw new Error('Sesión expirada');
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

  if (tabId === 'comprobantes') loadComprobantesList();
  if (tabId === 'crm') loadCRMClientes();
  if (tabId === 'monotributo') loadMonotributoStats();
  if (tabId === 'settings') loadKeepAliveSettings();
}

// --- DISCRETE FINANCIAL TICKER (ArgentinaDatos) ---
async function loadFinancialTicker() {
  try {
    const res = await fetch('/api/finanzas/resumen');
    if (!res.ok) return;
    const data = await res.json();

    const d = data.dolares || {};
    if (d.oficial) {
      document.getElementById('tickOficial').innerText = `$${d.oficial.compra} / $${d.oficial.venta}`;
    }
    if (d.blue) {
      document.getElementById('tickBlue').innerText = `$${d.blue.venta}`;
    }
    if (d.mep) {
      document.getElementById('tickMep').innerText = `$${d.mep.venta || d.mep.compra}`;
    }
    if (d.ccl) {
      document.getElementById('tickCcl').innerText = `$${d.ccl.venta || d.ccl.compra}`;
    }
    if (data.inflacion && data.inflacion.ultimoIpc) {
      document.getElementById('tickIpc').innerText = `${data.inflacion.ultimoIpc.valor}%`;
    }
    if (data.uva && data.uva.ultimoValor) {
      document.getElementById('tickUva').innerText = `$${data.uva.ultimoValor.valor}`;
    }

    const updatedEl = document.getElementById('tickerUpdated');
    if (updatedEl) {
      updatedEl.innerText = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    }
  } catch (e) {}
}

// --- FAST INVOICING (Facturador Rápido) ---
function addInvoiceItem() {
  const container = document.getElementById('invoiceItemsContainer');
  const div = document.createElement('div');
  div.className = 'invoice-item-row grid grid-cols-12 gap-2 items-center bg-obsidian-850 p-2.5 rounded border border-obsidian-700';
  div.innerHTML = `
    <div class="col-span-12 sm:col-span-6">
      <input type="text" class="item-desc input-field text-xs" placeholder="Descripción del servicio o producto..." required>
    </div>
    <div class="col-span-3 sm:col-span-2">
      <input type="number" class="item-qty input-field font-mono text-xs text-center" placeholder="Cant." value="1" min="1" step="1" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-7 sm:col-span-3">
      <div class="relative">
        <span class="absolute inset-y-0 left-0 pl-2 flex items-center text-slate-500 font-mono text-xs">$</span>
        <input type="number" class="item-price input-field font-mono text-xs !pl-6" placeholder="Precio" value="0" min="0" step="0.01" oninput="calculateInvoiceTotals()" required>
      </div>
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
  } else {
    showToast('El comprobante debe tener al menos un concepto.', 'warn');
  }
}

function setQuickItemDesc(desc) {
  const firstDesc = document.querySelector('.invoice-item-row .item-desc');
  if (firstDesc) {
    firstDesc.value = desc;
  }
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
  if (displayEl) {
    displayEl.innerText = `$${total.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
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
    items.push({
      descripcion,
      cantidad,
      precioUnitario,
      subtotal: cantidad * precioUnitario
    });
  });

  if (items.length === 0 || items[0].subtotal <= 0) {
    showToast('Ingresa un importe válido para el comprobante.', 'warn');
    return;
  }

  const payload = {
    tipoComprobante,
    puntoVenta,
    concepto,
    condicionVenta,
    receptor: {
      tipoDoc,
      nroDoc,
      razonSocial,
      condicionIva
    },
    items
  };

  const btn = document.getElementById('btnEmitirComprobante');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Conectando con ARCA...';
  showToast('Iniciando navegador headless y autorizando con ARCA...', 'info');

  try {
    const res = await fetchWithAuth('/api/erp/facturacion/emitir', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success) {
      showToast('¡Factura autorizada con éxito en ARCA!', 'success');
      
      // Update glance & modal
      document.getElementById('lastCaeNumber').innerText = data.cae || '-';
      document.getElementById('lastCaeVto').innerText = data.caeVencimiento || '-';
      document.getElementById('lastComprobanteNro').innerText = data.comprobanteNro || '-';
      document.getElementById('caeStatusDot').className = 'w-2 h-2 rounded-full bg-emerald-400';

      openCaeSuccessModal(data);
      loadComprobantesList();
    } else {
      showToast(`Error de emisión: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Fallo en la comunicación: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i> <span>EMITIR EN ARCA</span>';
  }
}

function openCaeSuccessModal(data) {
  document.getElementById('modalCaeNumber').innerText = data.cae || '-';
  document.getElementById('modalCaeVto').innerText = data.caeVencimiento || '-';
  document.getElementById('modalComprobanteNro').innerText = data.comprobanteNro || '-';
  document.getElementById('modalTotalImporte').innerText = `$${(data.totalImporte || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
  document.getElementById('caeSuccessModal').classList.remove('hidden');
}

function closeCaeSuccessModal() {
  document.getElementById('caeSuccessModal').classList.add('hidden');
}

// --- COMPROBANTES HISTORIAL ---
async function loadComprobantesList() {
  try {
    const res = await fetchWithAuth('/api/erp/comprobantes');
    const data = await res.json();
    allComprobantes = data.comprobantes || [];
    renderComprobantesTable(allComprobantes);
  } catch (e) {}
}

function renderComprobantesTable(list) {
  const tbody = document.getElementById('comprobantesTableBody');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-slate-500">No hay comprobantes emitidos aún.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(c => {
    const total = (c.importeTotal || c.importe_total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
    const cuit = c.cuitReceptor || c.cuit_receptor || '-';
    const razon = c.razonSocialReceptor || c.razon_social_receptor || 'Consumidor Final';
    const tipo = c.tipoComprobante || c.tipo_comprobante || 'Factura C';
    const pto = String(c.puntoVenta || c.punto_venta || 1).padStart(4, '0');
    const nro = String(c.numero || 1).padStart(8, '0');
    const cae = c.cae || '-';

    return `
      <tr class="hover:bg-obsidian-850/60 transition">
        <td class="py-2.5 px-3 text-slate-400">${c.fechaEmision || c.fecha_emision || '-'}</td>
        <td class="py-2.5 px-3">
          <strong class="text-amber-400 font-semibold">${escapeHtml(tipo)}</strong>
          <span class="text-slate-500 ml-1 font-mono">${pto}-${nro}</span>
        </td>
        <td class="py-2.5 px-3">
          <div class="text-slate-200 font-semibold truncate max-w-[200px]">${escapeHtml(razon)}</div>
          <div class="text-[10px] text-slate-500 font-mono">CUIT: ${cuit}</div>
        </td>
        <td class="py-2.5 px-3 text-right font-bold text-slate-100">$${total}</td>
        <td class="py-2.5 px-3">
          <span class="px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800 text-[10px] font-bold">CAE: ${cae}</span>
        </td>
      </tr>
    `;
  }).join('');
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
        <button onclick="deleteClient('${c.id}')" title="Eliminar" class="text-slate-600 hover:text-rose-400 transition p-1">
          <i class="fa-solid fa-trash-can text-xs"></i>
        </button>
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

// --- MONOTRIBUTO & DFE VIEW ---
async function loadMonotributoStats() {
  try {
    const res = await fetchWithAuth('/api/erp/monotributo/status');
    const data = await res.json();
    if (data.categoria) {
      document.getElementById('glanceCategoria').innerText = `Cat ${data.categoria} (${data.tipoActividad || 'Servicios'})`;
      document.getElementById('monoCategoriaBadge').innerText = `Categoría ${data.categoria} (${data.tipoActividad || 'Servicios'})`;
    }
  } catch (e) {}
}

async function loadDfeNotifications() {
  try {
    const res = await fetchWithAuth('/api/erp/dfe/notificaciones');
    const data = await res.json();
    const list = data.notificaciones || [];
    const container = document.getElementById('dfeInboxList');
    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = '<div class="p-3 text-center text-slate-500 text-xs">Sin notificaciones pendientes en ARCA.</div>';
      return;
    }

    container.innerHTML = list.map(n => `
      <div class="p-3 bg-obsidian-850 rounded border border-obsidian-700 space-y-1">
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

// --- CONFIG & CREDENTIALS ---
async function loadAuthStatus() {
  try {
    const res = await fetchWithAuth('/api/auth/status');
    const data = await res.json();

    const titularHeader = document.getElementById('arcaTitularHeader');
    const statusDot = document.getElementById('arcaStatusDot');
    const unconfiguredAlert = document.getElementById('unconfiguredAlert');

    if (data.cuit) {
      document.getElementById('cfgCuit').value = data.cuit;
      document.getElementById('cfgPuntoVenta').value = data.puntoVentaDefault || 1;
      document.getElementById('facPuntoVenta').value = data.puntoVentaDefault || 1;
      if (titularHeader) titularHeader.innerText = data.razonSocial || `CUIT: ${data.cuit}`;
      if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
      if (unconfiguredAlert) unconfiguredAlert.classList.add('hidden');
    } else {
      if (titularHeader) titularHeader.innerText = 'ARCA: Sin CUIT';
      if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-amber-400';
      if (unconfiguredAlert) unconfiguredAlert.classList.remove('hidden');
    }
  } catch (e) {}
}

async function handleSaveCreds(e) {
  e.preventDefault();
  const cuit = document.getElementById('cfgCuit').value;
  const claveFiscal = document.getElementById('cfgClaveFiscal').value;
  const puntoVentaDefault = parseInt(document.getElementById('cfgPuntoVenta').value || '1', 10);

  try {
    const res = await fetchWithAuth('/api/auth/credentials', {
      method: 'POST',
      body: JSON.stringify({ cuit, claveFiscal, puntoVentaDefault })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Credenciales guardadas y cifradas con éxito.', 'success');
      await loadAuthStatus();
    } else {
      showToast(data.message, 'error');
    }
  } catch (e) {
    showToast('Error al guardar credenciales.', 'error');
  }
}

async function testArcaConnection() {
  showToast('Iniciando sesión en ARCA en modo Headless...', 'info');
  try {
    const res = await fetchWithAuth('/api/auth/test-login', { method: 'POST', body: JSON.stringify({}) });
    const data = await res.json();
    if (data.success) {
      showToast(`¡Conexión Exitosa con ARCA! Titular: ${data.razonSocial}`, 'success');
      await loadAuthStatus();
    } else {
      showToast(`Fallo de conexión: ${data.message}`, 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
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
    const data = await res.json();
    if (data.settings) {
      if (data.settings.externalUrl) document.getElementById('cfgExternalUrl').value = data.settings.externalUrl;
      if (data.settings.uptimeRobotApiKey) document.getElementById('cfgUptimeRobotKey').value = data.settings.uptimeRobotApiKey;
    }
    if (data.uptimeFormatted) {
      const el = document.getElementById('headerUptimeText');
      if (el) el.innerText = `Uptime: ${data.uptimeFormatted}`;
    }
  } catch (e) {}
}

async function syncUptimeRobotMonitor() {
  const url = document.getElementById('cfgExternalUrl')?.value;
  showToast('Sincronizando con UptimeRobot...', 'info');
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

// --- UTILS & TOAST NOTIFICATIONS ---
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
  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

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
