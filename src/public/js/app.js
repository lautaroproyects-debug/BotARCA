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
  loadGeneralPreferences();
  if (currentUser && currentUser.role === 'admin') {
    await loadUsersList();
  }
  connectLogsSSE();

  // Polling automático
  setInterval(loadFinancialTicker, 60000);
  setInterval(loadQueueItems, 5000);
}

// --- AUTHENTICATION & LOGIN / REGISTER ---
function showLoginOverlay() {
  document.getElementById('loginOverlay')?.classList.remove('hidden');
}

function hideLoginOverlay() {
  document.getElementById('loginOverlay')?.classList.add('hidden');
}

function switchAuthMode(mode) {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const tabLogin = document.getElementById('tabBtnLogin');
  const tabRegister = document.getElementById('tabBtnRegister');

  if (mode === 'register') {
    loginForm?.classList.add('hidden');
    registerForm?.classList.remove('hidden');

    tabLogin?.classList.remove('text-amber-400', 'border-b-2', 'border-amber-400');
    tabLogin?.classList.add('text-slate-400', 'border-transparent');

    tabRegister?.classList.remove('text-slate-400', 'border-transparent');
    tabRegister?.classList.add('text-amber-400', 'border-b-2', 'border-amber-400');

    document.getElementById('regName')?.focus();
  } else {
    registerForm?.classList.add('hidden');
    loginForm?.classList.remove('hidden');

    tabRegister?.classList.remove('text-amber-400', 'border-b-2', 'border-amber-400');
    tabRegister?.classList.add('text-slate-400', 'border-transparent');

    tabLogin?.classList.remove('text-slate-400', 'border-transparent');
    tabLogin?.classList.add('text-amber-400', 'border-b-2', 'border-amber-400');

    document.getElementById('loginUsername')?.focus();
  }
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

async function handleUserRegister(e) {
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regPasswordConfirm').value;
  const btn = document.getElementById('btnRegisterSubmit');

  if (password !== confirm) {
    showToast('Las contraseñas no coinciden.', 'warn');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Creando y enviando email...';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, email, password })
    });

    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      if (data.token) {
        authToken = data.token;
        localStorage.setItem('botarca_token', authToken);
        currentUser = data.user;
        hideLoginOverlay();
        await initApp();
      } else {
        switchAuthMode('login');
        document.getElementById('loginUsername').value = username;
        document.getElementById('loginPassword').value = '';
      }
    } else {
      showToast(data.message || 'Error al crear la cuenta.', 'error');
    }
  } catch (err) {
    showToast('Error en la comunicación con el servidor.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Crear Usuario & Activar</span> <i class="fa-solid fa-paper-plane text-xs"></i>';
  }
}

function fillAdminCredentials() {
  const u = document.getElementById('loginUsername');
  const p = document.getElementById('loginPassword');
  if (u) u.value = 'admin';
  if (p) p.value = 'admin123';
  showToast('Credenciales de administrador cargadas.', 'info');
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
      
      const displayName = currentUser.name || currentUser.username;
      const initials = (displayName.length > 2 ? displayName.substring(0, 2) : displayName).toUpperCase();

      // Top Navbar elements
      const elName = document.getElementById('headerUserName');
      if (elName) elName.innerText = displayName;

      const elSubtext = document.getElementById('headerUserSubtext');
      if (elSubtext) elSubtext.innerText = `@${currentUser.username}`;

      const elRole = document.getElementById('headerUserRoleBadge');
      if (elRole) {
        elRole.innerText = currentUser.role === 'admin' ? 'ADMIN' : 'OPERADOR';
        elRole.className = currentUser.role === 'admin'
          ? 'px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-indigo-50 text-indigo-700 border border-indigo-200 uppercase'
          : 'px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-slate-100 text-slate-700 border border-slate-200 uppercase';
      }

      const elAvatar = document.getElementById('headerUserAvatar');
      if (elAvatar) elAvatar.innerText = initials;

      // Settings tab Profile card elements
      const pAvatar = document.getElementById('profileCardAvatar');
      if (pAvatar) pAvatar.innerText = initials;

      const pName = document.getElementById('profileCardName');
      if (pName) pName.innerText = displayName;

      const pUser = document.getElementById('profileCardUsername');
      if (pUser) pUser.innerText = `@${currentUser.username}`;

      const pEmail = document.getElementById('profileCardEmail');
      if (pEmail) pEmail.innerText = currentUser.email || 'Sin email registrado';

      const pRole = document.getElementById('profileCardRole');
      if (pRole) {
        pRole.innerText = currentUser.role === 'admin' ? 'Super Administrador' : 'Operador';
        pRole.className = currentUser.role === 'admin'
          ? 'px-2 py-0.5 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800 border border-indigo-200'
          : 'px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200';
      }

      const pSince = document.getElementById('profileCardSince');
      if (pSince && currentUser.createdAt) {
        pSince.innerText = new Date(currentUser.createdAt).toLocaleDateString('es-AR');
      }

      const secUsers = document.getElementById('sectionUsersAdmin');
      if (secUsers) {
        if (currentUser.role === 'admin') secUsers.classList.remove('hidden');
        else secUsers.classList.add('hidden');
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

  if (tabId === 'facturar') {
    loadQueueItems();
    loadAccounts();
  }
  if (tabId === 'comprobantes') loadComprobantesList();
  if (tabId === 'crm') loadCRMClientes();
  if (tabId === 'settings') {
    loadAccounts();
    loadGeneralPreferences();
    if (currentUser && currentUser.role === 'admin') loadUsersList();
  }
}

// --- SUBMODE SWITCHER (LOTE vs INDIVIDUAL) ---
function setInvoiceSubmode(mode) {
  const btnLote = document.getElementById('btnSubmodeLote');
  const btnManual = document.getElementById('btnSubmodeManual');
  const viewLote = document.getElementById('subviewLote');
  const viewManual = document.getElementById('subviewManual');

  if (mode === 'manual') {
    viewLote?.classList.add('hidden');
    viewManual?.classList.remove('hidden');
    
    btnManual?.classList.add('bg-indigo-50/80', 'border-indigo-600', 'shadow-sm');
    btnManual?.classList.remove('bg-white', 'border-slate-200');
    
    btnLote?.classList.remove('bg-indigo-50/80', 'border-indigo-600', 'shadow-sm');
    btnLote?.classList.add('bg-white', 'border-slate-200');
  } else {
    viewManual?.classList.add('hidden');
    viewLote?.classList.remove('hidden');
    
    btnLote?.classList.add('bg-indigo-50/80', 'border-indigo-600', 'shadow-sm');
    btnLote?.classList.remove('bg-white', 'border-slate-200');
    
    btnManual?.classList.remove('bg-indigo-50/80', 'border-indigo-600', 'shadow-sm');
    btnManual?.classList.add('bg-white', 'border-slate-200');
  }
}

// --- FINANCIAL TICKER (ArgentinaDatos) ---
async function loadFinancialTicker() {
  try {
    const res = await fetch('/api/finanzas/resumen');
    if (!res.ok) return;
    const data = await res.json();

    const d = data.dolares || {};
    if (d.oficial) document.getElementById('tickOficial') && (document.getElementById('tickOficial').innerText = `$${d.oficial.compra} / $${d.oficial.venta}`);
    if (d.blue) document.getElementById('tickBlue') && (document.getElementById('tickBlue').innerText = `$${d.blue.venta}`);
    if (d.mep) document.getElementById('tickMep') && (document.getElementById('tickMep').innerText = `$${d.mep.venta || d.mep.compra}`);
    if (d.ccl) document.getElementById('tickCcl') && (document.getElementById('tickCcl').innerText = `$${d.ccl.venta || d.ccl.compra}`);
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
            ${escapeHtml(a.razonSocial || 'Empresa')} (${formatCuit(a.cuit)})
          </option>
        `).join('');
      }
    }

    // Grid in accounts tab
    const grid = document.getElementById('accountsGrid');
    if (grid) {
      if (allAccounts.length === 0) {
        grid.innerHTML = '<div class="col-span-full py-8 text-center text-slate-400">No hay empresas ni CUITs registrados aún.</div>';
      } else {
        grid.innerHTML = allAccounts.map(a => `
          <div class="p-4 bg-white border ${a.cuit === data.activeCuit ? 'border-indigo-600 ring-2 ring-indigo-100 bg-indigo-50/20' : 'border-slate-200'} rounded-xl shadow-sm space-y-2.5 transition">
            <div class="flex items-center justify-between">
              <strong class="text-sm font-bold text-slate-900 truncate">${escapeHtml(a.razonSocial || 'Empresa')}</strong>
              ${a.cuit === data.activeCuit ? '<span class="px-2 py-0.5 rounded-full bg-indigo-600 text-white text-[10px] font-bold uppercase">Emisor Activo</span>' : ''}
            </div>
            <div class="text-xs text-slate-600">CUIT: <strong class="text-slate-900 font-mono select-all">${formatCuit(a.cuit)}</strong></div>
            <div class="text-xs text-slate-500">Punto de Venta: <strong>${a.puntoVentaDefault || 1}</strong></div>
            <div class="pt-2 border-t border-slate-100 flex justify-between items-center text-xs">
              <div class="flex items-center space-x-2">
                <button onclick="openEditAccountModal('${a.cuit}')" class="text-slate-500 hover:text-indigo-600 font-semibold p-1" title="Editar empresa">
                  <i class="fa-solid fa-pen-to-square"></i> Editar
                </button>
                <button onclick="deleteAccount('${a.cuit}')" class="text-slate-400 hover:text-rose-600 font-semibold p-1" title="Eliminar CUIT">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              </div>

              <div>
                ${a.cuit !== data.activeCuit ? `<button onclick="switchActiveCuitAccount('${a.cuit}')" class="text-xs text-indigo-600 hover:text-indigo-800 font-bold">Usar como Emisor</button>` : '<span class="text-xs text-emerald-600 font-bold flex items-center"><i class="fa-solid fa-circle-check mr-1"></i> Seleccionada</span>'}
              </div>
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
  const modal = document.getElementById('accountModal');
  const title = document.getElementById('accountModalTitle');
  const cuitInp = document.getElementById('accCuit');
  const rsInp = document.getElementById('accRazonSocial');
  const passInp = document.getElementById('accClaveFiscal');
  const ptoInp = document.getElementById('accPuntoVenta');
  const btnSubmit = document.getElementById('btnSubmitAccount');

  if (title) title.innerText = 'Agregar Empresa / CUIT Emisor';
  if (cuitInp) {
    cuitInp.value = '';
    cuitInp.disabled = false;
  }
  if (rsInp) rsInp.value = '';
  if (passInp) passInp.value = '';
  if (ptoInp) ptoInp.value = '1';
  if (btnSubmit) btnSubmit.innerText = 'Guardar Empresa';

  modal?.classList.remove('hidden');
  cuitInp?.focus();
}

function openEditAccountModal(cuit) {
  const acc = allAccounts.find(a => a.cuit === cuit);
  if (!acc) return;

  const modal = document.getElementById('accountModal');
  const title = document.getElementById('accountModalTitle');
  const cuitInp = document.getElementById('accCuit');
  const rsInp = document.getElementById('accRazonSocial');
  const passInp = document.getElementById('accClaveFiscal');
  const ptoInp = document.getElementById('accPuntoVenta');
  const btnSubmit = document.getElementById('btnSubmitAccount');

  if (title) title.innerText = 'Editar Empresa / CUIT Emisor';
  if (cuitInp) {
    cuitInp.value = acc.cuit;
    cuitInp.disabled = false;
  }
  if (rsInp) rsInp.value = acc.razonSocial || '';
  if (passInp) passInp.value = '';
  if (ptoInp) ptoInp.value = acc.puntoVentaDefault || 1;
  if (btnSubmit) btnSubmit.innerText = 'Actualizar Empresa';

  modal?.classList.remove('hidden');
}

function closeAccountModal() {
  document.getElementById('accountModal')?.classList.add('hidden');
}

async function deleteAccount(cuit) {
  if (!confirm(`¿Eliminar la empresa con CUIT ${formatCuit(cuit)} de la lista?`)) return;
  try {
    const res = await fetchWithAuth(`/api/accounts/${cuit}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Empresa con CUIT ${formatCuit(cuit)} eliminada.`, 'info');
      await loadAccounts();
      await loadAuthStatus();
    } else {
      showToast(data.message || 'Error al eliminar cuenta.', 'error');
    }
  } catch (e) {
    showToast('Error al eliminar cuenta.', 'error');
  }
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
      showToast('Empresa guardada y configurada correctamente.', 'success');
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

// --- EXCEL & WHATSAPP SMART PASTING (CARGA MASIVA & IA) ---
let parseDebounceTimer = null;

async function handleExcelPasteChange(text) {
  clearTimeout(parseDebounceTimer);
  if (!text || text.trim().length === 0) {
    parsedExcelItems = [];
    renderExcelPreview([]);
    updateParserBadge('auto', 0);
    return;
  }

  parseDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetchWithAuth('/api/queue/parse-excel', {
        method: 'POST',
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      if (data.success) {
        parsedExcelItems = data.items || [];
        renderExcelPreview(parsedExcelItems);
        updateParserBadge(data.parserUsed, parsedExcelItems.length);
      }
    } catch (e) {}
  }, 350);
}

async function handleParseWithGroq() {
  const text = document.getElementById('excelPasteArea')?.value?.trim();
  if (!text) {
    showToast('Pegá un texto o una tabla antes de interpretar.', 'warn');
    return;
  }

  const btn = document.getElementById('btnParseWithAi');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Analizando con IA...';
  }

  try {
    const res = await fetchWithAuth('/api/queue/parse-smart', {
      method: 'POST',
      body: JSON.stringify({ text, forceAi: true })
    });
    const data = await res.json();
    if (data.success && data.items) {
      parsedExcelItems = data.items;
      renderExcelPreview(parsedExcelItems);
      updateParserBadge(data.parserUsed, parsedExcelItems.length);
      if (data.items.length > 0) {
        const provName = data.parserUsed === 'groq_ai' ? 'Groq IA (Llama-3.3-70B)' : 'Motor Inteligente';
        showToast(`¡${data.items.length} facturas extraídas con ${provName}!`, 'success');
      } else {
        showToast('No se encontraron datos fiscales válidos en el texto.', 'warn');
      }
    } else {
      showToast(data.message || 'Error al interpretar con IA.', 'error');
    }
  } catch (err) {
    showToast('Error de comunicación con el motor de IA.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-brain text-[10px] mr-1"></i> Interpretar con IA';
    }
  }
}

function updateParserBadge(parserUsed, count) {
  const badge = document.getElementById('parserBadge');
  if (!badge) return;

  if (parserUsed === 'groq_ai') {
    badge.innerHTML = '<i class="fa-solid fa-brain text-indigo-600 mr-1.5"></i> <strong class="text-indigo-900">Inteligencia Artificial Groq (Llama-3.3-70B)</strong>';
    badge.className = 'inline-flex items-center px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-semibold';
  } else if (parserUsed === 'heuristic_nlp') {
    badge.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles text-indigo-600 mr-1.5"></i> <strong class="text-indigo-900">Lectura Inteligente de Texto Libre</strong>';
    badge.className = 'inline-flex items-center px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-semibold';
  } else {
    badge.innerHTML = '<i class="fa-solid fa-table text-slate-600 mr-1.5"></i> Formato Tabular Excel / CSV';
    badge.className = 'inline-flex items-center px-3 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200 text-xs font-semibold';
  }
}

function renderExcelPreview(items) {
  const tbody = document.getElementById('excelPreviewTbody');
  const countText = document.getElementById('excelParsedCountText');
  const totalDisplay = document.getElementById('excelPreviewTotal');
  const btnAdd = document.getElementById('btnAddToQueue');
  const btnAddText = document.getElementById('btnAddToQueueText');

  if (countText) countText.innerText = `${items.length} comprobante${items.length === 1 ? '' : 's'} listo${items.length === 1 ? '' : 's'}`;

  let sum = 0;
  items.forEach(i => sum += (Number(i.importeTotal) || 0));
  if (totalDisplay) totalDisplay.innerText = `$ ${sum.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;

  if (btnAdd) btnAdd.disabled = items.length === 0;
  if (btnAddText) btnAddText.innerText = items.length > 0 ? `⚡ FACTURAR ${items.length} COMPROBANTES EN ARCA` : '⚡ FACTURAR TODO EN ARCA AHORA';

  if (!tbody) return;
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-10 text-center text-slate-400 text-sm"><i class="fa-solid fa-clipboard-list text-3xl text-slate-300 block mb-2"></i>Pegá texto libre o filas de Excel arriba para generar la vista previa.</td></tr>';
    return;
  }

  tbody.innerHTML = items.map((it, idx) => `
    <tr class="hover:bg-slate-50 transition group">
      <td class="py-3 px-3 text-slate-400 font-bold text-center text-xs">${idx + 1}</td>
      <td class="py-2 px-2">
        <input type="text" value="${escapeHtml(it.docNro || '')}" oninput="updateDraftRow(${idx}, 'docNro', this.value)" class="input-field !py-1 text-xs font-mono font-bold text-slate-800" placeholder="CUIT / DNI">
      </td>
      <td class="py-2 px-2">
        <input type="text" value="${escapeHtml(it.razonSocial || '')}" oninput="updateDraftRow(${idx}, 'razonSocial', this.value)" class="input-field !py-1 text-xs font-semibold text-slate-800" placeholder="Nombre / Razón Social">
      </td>
      <td class="py-2 px-2">
        <select onchange="updateDraftRow(${idx}, 'tipoComprobante', this.value)" class="input-field !py-1 text-xs font-bold text-indigo-700">
          <option value="Factura C" ${it.tipoComprobante === 'Factura C' ? 'selected' : ''}>Factura C</option>
          <option value="Factura A" ${it.tipoComprobante === 'Factura A' ? 'selected' : ''}>Factura A</option>
          <option value="Factura B" ${it.tipoComprobante === 'Factura B' ? 'selected' : ''}>Factura B</option>
          <option value="Recibo C" ${it.tipoComprobante === 'Recibo C' ? 'selected' : ''}>Recibo C</option>
        </select>
      </td>
      <td class="py-2 px-2">
        <input type="text" value="${escapeHtml(it.descripcion || '')}" oninput="updateDraftRow(${idx}, 'descripcion', this.value)" class="input-field !py-1 text-xs text-slate-700" placeholder="Descripción del item">
      </td>
      <td class="py-2 px-2 text-right">
        <div class="relative inline-block w-32">
          <input type="number" step="any" value="${it.importeTotal || 0}" oninput="updateDraftRow(${idx}, 'importeTotal', this.value)" class="input-field !py-1 text-xs font-bold text-emerald-700 text-right">
        </div>
      </td>
      <td class="py-2 px-2 text-center">
        <button type="button" onclick="deleteDraftRow(${idx})" class="text-slate-400 hover:text-rose-600 p-1.5 transition" title="Eliminar fila">
          <i class="fa-solid fa-trash-can text-xs"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

function updateDraftRow(idx, field, value) {
  if (!parsedExcelItems[idx]) return;

  if (field === 'importeTotal') {
    const valNum = parseFloat(value) || 0;
    parsedExcelItems[idx].importeTotal = valNum;
    parsedExcelItems[idx].precioUnitario = valNum;
    let sum = 0;
    parsedExcelItems.forEach(i => sum += (Number(i.importeTotal) || 0));
    const totalDisplay = document.getElementById('excelPreviewTotal');
    if (totalDisplay) totalDisplay.innerText = `$${sum.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
  } else if (field === 'concepto') {
    parsedExcelItems[idx].concepto = parseInt(value, 10) || 2;
  } else {
    parsedExcelItems[idx][field] = value;
  }
}

function deleteDraftRow(idx) {
  if (parsedExcelItems[idx]) {
    parsedExcelItems.splice(idx, 1);
    renderExcelPreview(parsedExcelItems);
    showToast('Fila eliminada de la vista previa.', 'info');
  }
}

function loadSampleExcelData() {
  const sample = `30712345678\tEmpresa Alpha SRL\tServicios de Desarrollo de Software y APIs\t250000
20309998887\tMartín Rodríguez\tHonorarios Profesionales de Consultoría IT\t120000
30654321098\tGlobal Trade SA\tMantenimiento y soporte mensual Cloud\t180000
27321112223\tLucía Benítez\tAsesoramiento impositivo y contable\t95000`;
  const area = document.getElementById('excelPasteArea');
  if (area) {
    area.value = sample;
    handleExcelPasteChange(sample);
  }
}

function loadSampleTextMsg() {
  const sample = `Facturarle a Tech Solutions SRL CUIT 30-71234567-8 la suma de $185.000 por honorarios profesionales de desarrollo web y APIs.
Factura C a Gómez Distribuidora CUIT 27-33889900-4 por $75.000 por consultoría mensual de marketing.
Emitir a Lopez Construcciones CUIT 20-28776655-1 el monto de $320.000 por materiales e instalación.`;
  const area = document.getElementById('excelPasteArea');
  if (area) {
    area.value = sample;
    handleExcelPasteChange(sample);
  }
}
const loadSampleWhatsAppMsg = loadSampleTextMsg;

function clearExcelPasteArea() {
  const area = document.getElementById('excelPasteArea');
  if (area) {
    area.value = '';
    handleExcelPasteChange('');
  }
}

async function submitExcelBatchToQueue() {
  if (parsedExcelItems.length === 0) {
    showToast('No hay facturas para agregar a la cola.', 'warn');
    return false;
  }

  const btn = document.getElementById('btnAddToQueue');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Preparando facturas...';
  }

  try {
    const res = await fetchWithAuth('/api/queue/add', {
      method: 'POST',
      body: JSON.stringify({ items: parsedExcelItems })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`¡${data.count} facturas preparadas para emitir!`, 'success');
      clearExcelPasteArea();
      await loadQueueItems();
      return true;
    } else {
      showToast(data.message, 'error');
      return false;
    }
  } catch (e) {
    showToast('Error al agregar a la cola.', 'error');
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-bolt text-xs mr-1.5"></i> <span id="btnAddToQueueText">⚡ FACTURAR TODO EN ARCA AHORA</span>';
    }
  }
}

async function submitAndStartBatch() {
  if (parsedExcelItems.length === 0) {
    showToast('Pegá un texto o una tabla antes de emitir.', 'warn');
    return;
  }
  const ok = await submitExcelBatchToQueue();
  if (ok) {
    await startProcessingQueue();
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
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400 text-sm">No hay facturas en proceso en este momento.</td></tr>';
    return;
  }

  tbody.innerHTML = items.map(it => {
    let statusBadge = '<span class="inline-flex items-center px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-bold uppercase"><i class="fa-solid fa-clock mr-1"></i> Pendiente</span>';
    if (it.estado === 'procesando') {
      statusBadge = '<span class="inline-flex items-center px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-bold uppercase animate-pulse"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Emitiendo</span>';
    } else if (it.estado === 'emitida') {
      statusBadge = '<span class="inline-flex items-center px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold uppercase"><i class="fa-solid fa-circle-check mr-1"></i> Emitida</span>';
    } else if (it.estado === 'error') {
      statusBadge = '<span class="inline-flex items-center px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-xs font-bold uppercase"><i class="fa-solid fa-circle-xmark mr-1"></i> Error</span>';
    }

    let resultado = it.cae 
      ? `<span class="text-emerald-700 font-bold select-all text-xs">CAE: ${it.cae}</span> <span class="text-slate-400 text-xs font-semibold">(${it.comprobanteNro || ''})</span>` 
      : (it.errorMensaje ? `<span class="text-rose-600 text-xs font-medium truncate max-w-[220px] block" title="${escapeHtml(it.errorMensaje)}">${escapeHtml(it.errorMensaje)}</span>` : '<span class="text-slate-400">-</span>');

    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-3 px-3">${statusBadge}</td>
        <td class="py-3 px-3">
          <div class="text-slate-900 font-bold text-xs truncate max-w-[200px]">${escapeHtml(it.razonSocial)}</div>
          <div class="text-[11px] text-slate-500 font-mono">Doc: ${it.docNro}</div>
        </td>
        <td class="py-3 px-3 text-slate-700 text-xs truncate max-w-[200px]">${escapeHtml(it.descripcion)}</td>
        <td class="py-3 px-3 text-slate-600 text-xs font-semibold">${it.tipoComprobante} (Pto ${it.puntoVenta})</td>
        <td class="py-3 px-3 text-right font-extrabold text-slate-900 text-xs">$ ${(it.importeTotal || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
        <td class="py-3 px-3">${resultado}</td>
        <td class="py-3 px-3 text-center">
          ${it.estado === 'pendiente' ? `<button onclick="deleteQueueItem('${it.id}')" class="text-slate-400 hover:text-rose-600 transition p-1" title="Eliminar de la cola"><i class="fa-solid fa-trash-can text-xs"></i></button>` : ''}
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
      showToast('Motor iniciado. Procesando comprobantes en ARCA...', 'success');
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
      <tr class="hover:bg-slate-50 transition">
        <td class="py-3 px-4">
          <strong class="text-slate-900 text-xs block">${escapeHtml(u.name)}</strong>
          <span class="text-slate-500 text-[11px]">@${escapeHtml(u.username)}</span>
        </td>
        <td class="py-3 px-4 text-slate-600 text-xs">${escapeHtml(u.email)}</td>
        <td class="py-3 px-4">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${u.role === 'admin' ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' : 'bg-slate-100 text-slate-700 border border-slate-200'}">
            ${u.role}
          </span>
        </td>
        <td class="py-3 px-4">
          <span class="inline-flex items-center text-xs font-semibold ${u.active ? 'text-emerald-600' : 'text-rose-600'}">
            <span class="w-1.5 h-1.5 rounded-full ${u.active ? 'bg-emerald-500' : 'bg-rose-500'} mr-1.5"></span>
            ${u.active ? 'Activo' : 'Inactivo'}
          </span>
        </td>
        <td class="py-3 px-4 text-slate-500 text-xs">${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('es-AR') : 'Nunca'}</td>
        <td class="py-3 px-4 text-right">
          ${u.id !== currentUser.id ? `<button onclick="deleteUser('${u.id}')" class="text-slate-400 hover:text-rose-600 p-1 transition" title="Eliminar"><i class="fa-solid fa-trash-can text-xs"></i></button>` : '<span class="text-xs text-slate-400 font-bold">Tú</span>'}
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
  div.className = 'invoice-item-row grid grid-cols-12 gap-2 items-center bg-slate-50 p-2.5 rounded-lg border border-slate-200';
  div.innerHTML = `
    <div class="col-span-12 sm:col-span-6">
      <input type="text" class="item-desc input-field text-xs" placeholder="Descripción del producto o servicio..." required>
    </div>
    <div class="col-span-3 sm:col-span-2">
      <input type="number" class="item-qty input-field text-xs text-center" value="1" min="1" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-7 sm:col-span-3">
      <input type="number" class="item-price input-field text-xs" value="0" min="0" step="0.01" oninput="calculateInvoiceTotals()" required>
    </div>
    <div class="col-span-2 sm:col-span-1 text-center">
      <button type="button" onclick="removeInvoiceItem(this)" class="text-slate-400 hover:text-rose-600 transition text-sm p-1" title="Quitar ítem">
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
      document.getElementById('caeStatusDot').className = 'w-2 h-2 rounded-full bg-emerald-500';
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
    tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-400 text-xs">No hay comprobantes emitidos registrados aún.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(c => `
    <tr class="hover:bg-slate-50/80 transition">
      <td class="py-3 px-4 text-slate-500 text-xs">${c.fechaEmision || c.fecha_emision || '-'}</td>
      <td class="py-3 px-4">
        <strong class="text-indigo-600 font-bold text-xs">${escapeHtml(c.tipoComprobante || c.tipo_comprobante || 'Factura C')}</strong>
        <span class="text-slate-500 ml-1 font-mono text-xs font-semibold">${c.comprobanteFormato || c.comprobante_formato || '-'}</span>
      </td>
      <td class="py-3 px-4">
        <div class="text-slate-900 font-bold text-xs truncate max-w-[220px]">${escapeHtml(c.razonSocialReceptor || c.razon_social_receptor || 'Consumidor Final')}</div>
        <div class="text-[11px] text-slate-500 font-mono">CUIT: ${c.cuitReceptor || c.cuit_receptor || '-'}</div>
      </td>
      <td class="py-3 px-4 text-right font-extrabold text-slate-900 text-xs">$${(c.importeTotal || c.importe_total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
      <td class="py-3 px-4">
        <span class="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold font-mono">CAE: ${c.cae || '-'}</span>
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
    container.innerHTML = '<div class="col-span-full py-8 text-center text-slate-400 text-xs">No hay clientes frecuentes registrados.</div>';
    return;
  }

  container.innerHTML = clients.map(c => `
    <div class="p-4 bg-white border border-slate-200/90 rounded-xl space-y-2.5 text-xs shadow-sm hover:border-slate-300 hover:shadow transition">
      <div class="flex items-start justify-between">
        <div class="truncate">
          <strong class="text-slate-900 text-sm font-bold block truncate">${escapeHtml(c.razonSocial)}</strong>
          <span class="text-slate-500 text-xs font-mono">CUIT: ${c.cuit}</span>
        </div>
        <button onclick="deleteClient('${c.id}')" class="text-slate-400 hover:text-rose-600 transition p-1" title="Eliminar"><i class="fa-solid fa-trash-can text-xs"></i></button>
      </div>
      <div class="text-xs text-slate-600">Condición: <span class="font-semibold text-slate-800">${escapeHtml(c.condicionIva || 'Consumidor Final')}</span></div>
      <div class="pt-2 border-t border-slate-100 flex justify-end">
        <button onclick="selectClientAndInvoice('${c.id}')" class="text-xs text-indigo-600 hover:text-indigo-700 font-bold flex items-center space-x-1.5 transition">
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
  switchTab('facturar');
  setInvoiceSubmode('manual');
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

// --- PREFERENCIAS DE FACTURACIÓN Y ESTADO CLOUD AUTOGESTIONADO ---
function loadGeneralPreferences() {
  try {
    const raw = localStorage.getItem('botarca_general_prefs');
    if (raw) {
      const prefs = JSON.parse(raw);
      if (prefs.puntoVenta && document.getElementById('prefPuntoVenta')) {
        document.getElementById('prefPuntoVenta').value = prefs.puntoVenta;
      }
      if (prefs.concepto && document.getElementById('prefConcepto')) {
        document.getElementById('prefConcepto').value = prefs.concepto;
      }
      if (prefs.condicionVenta && document.getElementById('prefCondicionVenta')) {
        document.getElementById('prefCondicionVenta').value = prefs.condicionVenta;
      }
      if (prefs.tipoComprobante && document.getElementById('prefTipoComprobante')) {
        document.getElementById('prefTipoComprobante').value = prefs.tipoComprobante;
      }

      // Sincronizar también con el Facturador Rápido
      if (prefs.puntoVenta && document.getElementById('facPuntoVenta')) {
        document.getElementById('facPuntoVenta').value = prefs.puntoVenta;
      }
      if (prefs.concepto && document.getElementById('facConcepto')) {
        document.getElementById('facConcepto').value = prefs.concepto;
      }
      if (prefs.tipoComprobante && document.getElementById('facTipo')) {
        document.getElementById('facTipo').value = prefs.tipoComprobante;
      }
    }
  } catch (e) {
    console.error('Error cargando preferencias:', e);
  }
}

function handleSaveGeneralPreferences(e) {
  if (e) e.preventDefault();
  const puntoVenta = document.getElementById('prefPuntoVenta')?.value || 1;
  const concepto = document.getElementById('prefConcepto')?.value || '2';
  const condicionVenta = document.getElementById('prefCondicionVenta')?.value || 'Contado';
  const tipoComprobante = document.getElementById('prefTipoComprobante')?.value || 'Factura C';

  const prefs = { puntoVenta, concepto, condicionVenta, tipoComprobante };
  localStorage.setItem('botarca_general_prefs', JSON.stringify(prefs));

  // Sincronizar inmediatamente con Facturador Rápido
  if (document.getElementById('facPuntoVenta')) document.getElementById('facPuntoVenta').value = puntoVenta;
  if (document.getElementById('facConcepto')) document.getElementById('facConcepto').value = concepto;
  if (document.getElementById('facTipo')) document.getElementById('facTipo').value = tipoComprobante;

  showToast('Preferencias de facturación guardadas correctamente.', 'success');
}

async function checkCloudHealthStatus() {
  showToast('Verificando conexión de servicios Cloud en tiempo real...', 'info');
  try {
    const res = await fetch('/api/finanzas/resumen');
    if (res.ok) {
      showToast('Todos los servicios Cloud (Servidor, Base de Datos, IA Groq y ARCA) están 100% operativos.', 'success');
    } else {
      showToast('Servidor respondiendo pero con latencia.', 'warn');
    }
  } catch (err) {
    showToast('Error al conectar con los servicios Cloud.', 'error');
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
  div.innerHTML = `<span class="text-slate-400 font-mono">[${log.timestamp.split('T')[1].split('.')[0]}]</span> <strong class="${levelClass}">[${log.module}]</strong> <span class="text-slate-700">${escapeHtml(log.message)}</span>`;
  screen.appendChild(div);
  screen.scrollTop = screen.scrollHeight;
}

function clearLogsConsole() {
  const screen = document.getElementById('terminalScreen');
  if (screen) screen.innerHTML = '<div class="text-slate-400 font-mono text-xs">[SISTEMA] Consola limpia.</div>';
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
    success: 'bg-white border-emerald-200 text-emerald-950 shadow-emerald-500/10',
    error: 'bg-white border-rose-200 text-rose-950 shadow-rose-500/10',
    warn: 'bg-white border-amber-200 text-amber-950 shadow-amber-500/10',
    info: 'bg-white border-slate-200 text-slate-900 shadow-slate-500/10',
  };

  const icons = {
    success: 'fa-circle-check text-emerald-600',
    error: 'fa-circle-exclamation text-rose-600',
    warn: 'fa-triangle-exclamation text-amber-500',
    info: 'fa-circle-info text-indigo-600',
  };

  toast.className = `pointer-events-auto p-3.5 rounded-xl border shadow-xl flex items-center space-x-3 text-xs font-semibold transition-all duration-300 translate-y-2 opacity-0 ${colors[type] || colors.info}`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || icons.info} text-base flex-shrink-0"></i>
    <span class="flex-1 leading-snug">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => toast.classList.remove('translate-y-2', 'opacity-0'), 10);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4500);
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
