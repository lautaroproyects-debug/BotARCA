/* BotArca — panel web (vanilla JS, sin build).
   Tres pantallas: Facturar (una / varias / cola), Comprobantes y Ajustes. */
'use strict';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const ic = (nombre) => `<svg class="ic" aria-hidden="true"><use href="#i-${nombre}"/></svg>`;

const estado = {
  token: leerToken(),
  usuario: null,
  cuentas: [],
  cuitActivo: '',
  plataforma: null,
  clientes: [],
  comprobantes: [],
  cola: { items: [], isProcessing: false },
  borradores: [],
  sse: null,
  sondeoCola: null,
};

function leerToken() { try { return localStorage.getItem('botarca_token') || ''; } catch { return ''; } }
function guardarToken(t) { try { t ? localStorage.setItem('botarca_token', t) : localStorage.removeItem('botarca_token'); } catch {} }

/* ---------------- Utilidades ---------------- */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmtPesos = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCuit = (c) => { const s = String(c || '').replace(/\D/g, ''); return s.length === 11 ? `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}` : s; };
const fmtFecha = (iso) => { if (!iso) return ''; const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };
const puedeOperar = () => estado.usuario && ['admin', 'operator'].includes(estado.usuario.role);
const esAdmin = () => estado.usuario && estado.usuario.role === 'admin';
const cuentaActiva = () => estado.cuentas.find(c => c.cuit === estado.cuitActivo);

function aviso(msg, tipo = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
  el.innerHTML = `${ic(tipo === 'error' ? 'alerta' : 'check')}<span>${esc(msg)}</span>`;
  $('#avisos').appendChild(el);
  setTimeout(() => el.remove(), tipo === 'error' ? 7000 : 4000);
}

function ocupado(btn, si) {
  if (!btn) return;
  if (si) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
}

async function api(url, opciones = {}) {
  const headers = { ...(opciones.body && !(opciones.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(estado.token ? { Authorization: `Bearer ${estado.token}` } : {}), ...(opciones.headers || {}) };
  let res;
  try {
    res = await fetch(url, { ...opciones, headers, body: opciones.body && typeof opciones.body !== 'string' ? JSON.stringify(opciones.body) : opciones.body });
  } catch {
    return { ok: false, status: 0, data: { message: 'No hay conexión con el servidor. Revisá internet y probá de nuevo.' } };
  }
  if (res.status === 401 && !url.startsWith('/api/auth/login')) {
    cerrarSesion(false);
    return { ok: false, status: 401, data: { message: 'Tu sesión venció. Ingresá de nuevo.' } };
  }
  if (opciones.blob) {
    if (!res.ok) { let d = {}; try { d = await res.json(); } catch {} return { ok: false, status: res.status, data: d }; }
    return { ok: true, status: res.status, blob: await res.blob() };
  }
  let data = {};
  try { data = await res.json(); } catch { data = { message: `Respuesta inesperada del servidor (HTTP ${res.status}).` }; }
  return { ok: res.ok && data.success !== false, status: res.status, data };
}

/* ---------------- Diálogos ---------------- */
document.addEventListener('click', (e) => {
  const cerrar = e.target.closest('[data-cerrar]');
  if (cerrar) { e.preventDefault(); cerrar.closest('dialog')?.close(); }
});
$$('dialog').forEach(d => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

/* ======================================================================
   INGRESO
   ====================================================================== */
function mostrarFormIngreso(cual) {
  ['formIngreso', 'formOlvido', 'formRestablecer', 'formRegistro'].forEach(id => $('#' + id).classList.add('oculto'));
  const mapa = { ingreso: 'formIngreso', olvido: 'formOlvido', restablecer: 'formRestablecer', registro: 'formRegistro' };
  const form = $('#' + mapa[cual]);
  form.classList.remove('oculto');
  form.querySelector('input')?.focus();
}
$$('[data-vista-ingreso]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); mostrarFormIngreso(a.dataset.vistaIngreso); }));

function mensajeForm(id, texto, tipo = 'error') {
  const el = $('#' + id);
  el.className = `aviso ${tipo}`;
  el.textContent = texto;
  el.classList.toggle('oculto', !texto);
}

$('#formIngreso').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  const username = $('#ingUsuario').value.trim();
  const password = $('#ingClave').value;
  if (!username || !password) return mensajeForm('ingMensaje', 'Completá usuario y contraseña.');
  ocupado(btn, true);
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  ocupado(btn, false);
  if (!r.ok) return mensajeForm('ingMensaje', r.data.message || 'No se pudo ingresar.');
  estado.token = r.data.token; guardarToken(r.data.token);
  $('#ingClave').value = '';
  mensajeForm('ingMensaje', '');
  iniciarApp();
});

$('#formOlvido').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#olvEmail').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return mensajeForm('olvMensaje', 'Ingresá un email válido.', 'error');
  ocupado(e.submitter, true);
  const r = await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
  ocupado(e.submitter, false);
  mensajeForm('olvMensaje', r.data.message || 'Listo.', r.ok ? 'info' : 'error');
});

$('#formRestablecer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const clave = $('#resClave').value, clave2 = $('#resClave2').value;
  if (clave !== clave2) return mensajeForm('resMensaje', 'Las contraseñas no coinciden.');
  const token = (location.hash.match(/restablecer=([a-f0-9]+)/) || [])[1];
  ocupado(e.submitter, true);
  const r = await api('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: clave } });
  ocupado(e.submitter, false);
  if (!r.ok) return mensajeForm('resMensaje', r.data.message);
  history.replaceState(null, '', location.pathname);
  mostrarFormIngreso('ingreso');
  mensajeForm('ingMensaje', 'Contraseña creada. Ya podés ingresar.', 'ok');
});

$('#formRegistro').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('#regNombre').value.trim(), username: $('#regUsuario').value.trim(), email: $('#regEmail').value.trim(), password: $('#regClave').value };
  ocupado(e.submitter, true);
  const r = await api('/api/auth/register', { method: 'POST', body });
  ocupado(e.submitter, false);
  if (!r.ok) return mensajeForm('regMensaje', r.data.message || 'No se pudo crear el usuario.');
  estado.token = r.data.token; guardarToken(r.data.token);
  aviso(r.data.message);
  iniciarApp();
});

function cerrarSesion(avisar = true) {
  estado.token = ''; guardarToken('');
  estado.usuario = null;
  estado.sse?.close(); estado.sse = null;
  clearInterval(estado.sondeoCola);
  $('#vistaApp').classList.add('oculto');
  $('#vistaIngreso').classList.remove('oculto');
  mostrarFormIngreso('ingreso');
  if (avisar) aviso('Sesión cerrada.');
}

/* ======================================================================
   ARRANQUE Y NAVEGACIÓN
   ====================================================================== */
async function iniciarApp() {
  const r = await api('/api/auth/me');
  if (!r.ok) { cerrarSesion(false); return; }
  estado.usuario = r.data.user;
  $('#vistaIngreso').classList.add('oculto');
  $('#vistaApp').classList.remove('oculto');
  $('#ajustesUsuario').textContent = `${estado.usuario.name} · @${estado.usuario.username} · ${({ admin: 'Administrador', operator: 'Operador', viewer: 'Solo lectura' })[estado.usuario.role]}`;
  $$('[data-solo-admin]').forEach(el => el.classList.toggle('oculto', !esAdmin()));
  $('#avisoSinPermiso').classList.toggle('oculto', puedeOperar());

  if (!$('#items').children.length) agregarItem();
  await Promise.all([cargarCuentas(), cargarClientes(), cargarPlataforma()]);
  cargarCola();
  cambiarModo(estado.modo || 'paso');
  actualizarAvisoSinCuit();
  const nombre = String(estado.usuario?.name || '').trim().split(/\s+/)[0];
  $('#saludo').textContent = nombre ? `Hola, ${nombre}` : 'Inicio';
  $('#btnSalirBarra').title = `Cerrar sesión de @${estado.usuario?.username || ''} para entrar con otro usuario`;
  ir(location.hash.replace('#', '') || 'inicio');
}

function ir(pantalla) {
  if (pantalla === 'comprobantes') pantalla = 'inicio';
  if (!['inicio', 'facturar', 'ajustes'].includes(pantalla)) pantalla = 'inicio';
  $$('[data-pantalla]').forEach(s => s.classList.toggle('oculto', s.id !== 'pantalla-' + pantalla));
  $$('.nav button').forEach(b => b.setAttribute('aria-current', b.dataset.ir === pantalla ? 'page' : 'false'));
  if (location.hash !== '#' + pantalla) history.replaceState(null, '', '#' + pantalla);
  if (pantalla === 'inicio') cargarComprobantes();
  if (pantalla === 'ajustes') { renderEmpresas(); renderClientes(); if (esAdmin()) { cargarUsuarios(); cargarCorreo(); conectarLogs(); } }
  window.scrollTo({ top: 0 });
}
$$('.nav button').forEach(b => b.addEventListener('click', () => ir(b.dataset.ir)));
$$('[data-ir-a]').forEach(b => b.addEventListener('click', () => ir(b.dataset.irA)));
$$('.indice a').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); $(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));

/* ---------------- Cuentas / emisor ---------------- */
function actualizarAvisoSinCuit() {
  const sinCuit = !estado.cuentas.length;
  $('#avisoSinCuit').classList.toggle('oculto', !sinCuit || !puedeOperar());
}
$$('[data-ir-ajustes]').forEach(b => b.addEventListener('click', () => {
  ir('ajustes');
  if (b.dataset.irAjustes === 'agregar') abrirEmpresa(); else abrirGuia('');
}));

async function cargarCuentas() {
  const r = await api('/api/accounts');
  if (!r.ok) return;
  estado.cuentas = r.data.accounts || [];
  estado.cuitActivo = r.data.activeCuit || estado.cuentas[0]?.cuit || '';
  const sel = $('#selEmisor');
  sel.innerHTML = estado.cuentas.length
    ? estado.cuentas.map(c => `<option value="${c.cuit}" ${c.cuit === estado.cuitActivo ? 'selected' : ''}>${esc(c.razonSocial || c.cuit)} · ${fmtCuit(c.cuit)}</option>`).join('')
    : '<option value="">Agregá un CUIT en Ajustes</option>';
  actualizarBadgeAmbiente();
  renderEmpresas();
  actualizarAvisoSinCuit();
}

$('#selEmisor').addEventListener('change', async (e) => {
  const cuit = e.target.value;
  const r = await api('/api/accounts/switch', { method: 'POST', body: { cuit } });
  if (!r.ok) { aviso(r.data.message, 'error'); e.target.value = estado.cuitActivo; return; }
  estado.cuitActivo = cuit;
  actualizarBadgeAmbiente();
  aviso(`Ahora facturás como ${cuentaActiva()?.razonSocial || cuit}.`);
});

async function cargarPlataforma() {
  const r = await api('/api/accounts/ws/estado');
  if (r.ok) estado.plataforma = r.data;
  actualizarBadgeAmbiente();
}

function actualizarBadgeAmbiente() {
  const b = $('#badgeAmbiente');
  const c = cuentaActiva();
  if (!c || !estado.plataforma) { b.classList.add('oculto'); return; }
  const navegador = (c.ws?.modo || 'auto') === 'navegador';
  const real = navegador || estado.plataforma.ambiente === 'produccion';
  b.className = `ambiente ${real ? 'real' : 'prueba'}`;
  b.textContent = navegador ? 'ARCA real · navegador' : real ? 'ARCA real' : 'Modo prueba';
  b.title = real ? 'Las facturas que emitas son reales.' : 'Homologación: las facturas son de prueba y no tienen validez fiscal.';
}

/* ======================================================================
   FACTURAR · UNA FACTURA
   ====================================================================== */
$$('[data-modo]').forEach(b => b.addEventListener('click', () => cambiarModo(b.dataset.modo)));
function cambiarModo(modo) {
  estado.modo = modo;
  $$('[data-modo]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.modo === modo)));
  $$('[data-modo-panel]').forEach(p => p.classList.toggle('oculto', p.dataset.modoPanel !== modo));
  $('#resultadoEmision').classList.add('oculto');
  if (modo === 'cola') cargarCola();
  if (modo === 'paso') asisMostrar();
}

const discriminaIva = () => /\b(A|B)$/.test($('#facTipo').value);

function agregarItem(datos = {}) {
  const fila = document.createElement('div');
  const n = $('#items').children.length + 1;
  fila.className = 'item' + (discriminaIva() ? ' con-iva' : '');
  fila.innerHTML = `
    <div class="desc"><label for="itD${n}">Descripción</label><input id="itD${n}" data-campo="descripcion" value="${esc(datos.descripcion || '')}" placeholder="Honorarios de octubre"></div>
    <div><label for="itC${n}">Cant.</label><input id="itC${n}" data-campo="cantidad" inputmode="decimal" value="${esc(datos.cantidad || 1)}"></div>
    <div><label for="itP${n}">${discriminaIva() ? 'Precio sin IVA' : 'Precio'}</label><input id="itP${n}" data-campo="precio" inputmode="decimal" value="${esc(datos.precio || '')}" placeholder="0,00"></div>
    ${discriminaIva() ? `<div><label for="itI${n}">IVA</label><select id="itI${n}" data-campo="iva"><option>21</option><option>10.5</option><option>27</option><option>5</option><option>2.5</option><option>0</option><option value="exento">Exento</option></select></div>` : ''}
    <button type="button" class="boton quitar" aria-label="Quitar ítem">${ic('basura')}</button>`;
  fila.querySelector('.quitar').addEventListener('click', () => { if ($('#items').children.length > 1) { fila.remove(); calcularTotal(); } else { fila.querySelectorAll('input').forEach(i => (i.value = i.dataset.campo === 'cantidad' ? '1' : '')); calcularTotal(); } });
  fila.addEventListener('input', calcularTotal);
  $('#items').appendChild(fila);
  calcularTotal();
  return fila;
}
$('#btnAgregarItem').addEventListener('click', () => agregarItem().querySelector('input').focus());

/** Interpreta "1.500,50", "1500.50" o "150000". */
function numero(v) {
  let s = String(v || '').replace(/[$\s]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  else if ((s.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function leerItems() {
  return $$('#items .item').map(f => {
    const cantidad = numero(f.querySelector('[data-campo=cantidad]').value) || 0;
    const precio = numero(f.querySelector('[data-campo=precio]').value);
    const iva = f.querySelector('[data-campo=iva]')?.value;
    return { descripcion: f.querySelector('[data-campo=descripcion]').value.trim(), cantidad, precioUnitario: precio, subtotal: Math.round(cantidad * precio * 100) / 100, alicuotaIva: iva };
  });
}

function calcularTotal() {
  const items = leerItems();
  let neto = 0, iva = 0;
  for (const it of items) {
    neto += it.subtotal;
    if (discriminaIva() && it.alicuotaIva && it.alicuotaIva !== 'exento') iva += Math.round(it.subtotal * parseFloat(it.alicuotaIva)) / 100;
  }
  const total = Math.round((neto + iva) * 100) / 100;
  $('#facTotal').textContent = fmtPesos(total);
  $('#facTotalFijo').textContent = fmtPesos(total);
  $('#facDesglose').textContent = discriminaIva() ? `Neto ${fmtPesos(neto)} + IVA ${fmtPesos(iva)}` : '';
  return { neto, iva, total };
}

function actualizarFormTipo() {
  const items = leerItems();
  $('#items').innerHTML = '';
  (items.length ? items : [{}]).forEach(it => agregarItem({ descripcion: it.descripcion, cantidad: it.cantidad, precio: it.precioUnitario || '' }));
  $('#ayudaIva').textContent = discriminaIva() ? 'En Factura A y B el precio va sin IVA: se suma la alícuota de cada ítem.' : 'El precio es el final.';
  $('#bloqueAsociado').classList.toggle('oculto', !/Nota de Crédito/.test($('#facTipo').value));
  const letra = ($('#facTipo').value.match(/\b([ABC])$/) || [])[1];
  if (letra) $('#asoTipo').value = `Factura ${letra}`;
}
$('#facTipo').addEventListener('change', actualizarFormTipo);

$('#facDocTipo').addEventListener('change', () => {
  const cf = $('#facDocTipo').value === 'Consumidor Final';
  $('#campoDocNro').classList.toggle('oculto', cf);
  if (cf) { $('#facCondIva').value = 'Consumidor Final'; if (!$('#facNombre').value) $('#facNombre').value = ''; }
});

$('#facCliente').addEventListener('change', () => {
  const c = estado.clientes.find(x => x.id === $('#facCliente').value);
  if (!c) return;
  $('#facDocTipo').value = c.tipoDoc === 'DNI' ? 'DNI' : c.cuit ? 'CUIT' : 'Consumidor Final';
  $('#facDocTipo').dispatchEvent(new Event('change'));
  $('#facDocNro').value = c.cuit || '';
  $('#facNombre').value = c.razonSocial || '';
  $('#facCondIva').value = c.condicionIva || '';
  $('#facEmail').value = c.email || '';
  $('#facDomicilio').value = c.domicilio || '';
});

function validarFactura() {
  const errores = [];
  const marcar = (id, mal) => $('#' + id).setAttribute('aria-invalid', String(!!mal));
  const docTipo = $('#facDocTipo').value;
  const doc = $('#facDocNro').value.replace(/\D/g, '');
  const conDoc = docTipo !== 'Consumidor Final';
  marcar('facDocNro', conDoc && ((docTipo === 'DNI' && !/^\d{7,8}$/.test(doc)) || (docTipo !== 'DNI' && doc.length !== 11)));
  if (conDoc && docTipo === 'DNI' && !/^\d{7,8}$/.test(doc)) errores.push('El DNI tiene que tener 7 u 8 números.');
  if (conDoc && docTipo !== 'DNI' && doc.length !== 11) errores.push(`El ${docTipo} tiene que tener 11 números.`);
  marcar('facCondIva', !$('#facCondIva').value);
  if (!$('#facCondIva').value) errores.push('Elegí la condición frente al IVA del cliente.');
  if (conDoc && docTipo !== 'DNI' && !$('#facNombre').value.trim()) errores.push('Falta el nombre o razón social.');
  if (/\bA$/.test($('#facTipo').value) && docTipo !== 'CUIT') errores.push('Una Factura A necesita CUIT del cliente.');
  const email = $('#facEmail').value.trim();
  marcar('facEmail', email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errores.push('El email no es válido.');
  if (/Nota de Crédito/.test($('#facTipo').value) && (!$('#asoPv').value || !$('#asoNro').value)) errores.push('Indicá punto de venta y número de la factura que anula la nota de crédito.');
  const items = leerItems();
  items.forEach((it, i) => {
    if (!it.descripcion) errores.push(`Ítem ${i + 1}: falta la descripción.`);
    if (it.cantidad <= 0) errores.push(`Ítem ${i + 1}: la cantidad tiene que ser mayor a cero.`);
    if (it.precioUnitario <= 0) errores.push(`Ítem ${i + 1}: falta el precio.`);
  });
  return errores;
}

let facturaPendiente = null;

$('#formFactura').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!puedeOperar()) return aviso('Tu usuario es de solo lectura.', 'error');
  const c = cuentaActiva();
  if (!c) return aviso('Primero cargá la empresa que factura en Ajustes.', 'error');
  const errores = validarFactura();
  if (errores.length) {
    aviso(errores[0], 'error');
    $('[aria-invalid="true"]')?.focus();
    return;
  }
  const t = calcularTotal();
  const docTipo = $('#facDocTipo').value;
  facturaPendiente = {
    cuitEmisor: c.cuit,
    razonSocialEmisor: c.razonSocial,
    tipoComprobante: $('#facTipo').value,
    puntoVenta: c.ws?.puntoVentaWs || c.puntoVentaDefault || 1,
    concepto: Number($('#facConcepto').value),
    condicionVenta: $('#facCondVenta').value,
    fechaEmision: $('#facFecha').value || undefined,
    periodoDesde: $('#facDesde').value || undefined,
    periodoHasta: $('#facHasta').value || undefined,
    vencimientoPago: $('#facVto').value || undefined,
    receptor: {
      tipoDoc: docTipo,
      nroDoc: docTipo === 'Consumidor Final' ? '' : $('#facDocNro').value.replace(/\D/g, ''),
      razonSocial: $('#facNombre').value.trim() || (docTipo === 'Consumidor Final' ? 'Consumidor Final' : ''),
      condicionIva: $('#facCondIva').value,
      email: $('#facEmail').value.trim() || undefined,
      domicilio: $('#facDomicilio').value.trim() || undefined,
    },
    items: leerItems(),
    comprobanteAsociado: /Nota de Crédito/.test($('#facTipo').value) ? { tipo: $('#asoTipo').value, puntoVenta: Number($('#asoPv').value), numero: $('#asoNro').value } : undefined,
  };
  mostrarConfirmacion(facturaPendiente);
});

const NOMBRE_CONCEPTO = { 1: 'Productos', 2: 'Servicios', 3: 'Productos y servicios' };

function totalesDe(items, conIva) {
  let neto = 0, iva = 0;
  for (const it of items) {
    neto += it.subtotal;
    if (conIva && it.alicuotaIva && it.alicuotaIva !== 'exento') iva += Math.round(it.subtotal * parseFloat(it.alicuotaIva)) / 100;
  }
  return { neto, iva, total: Math.round((neto + iva) * 100) / 100 };
}

/** Muestra el resumen y pide confirmar. Lo usan el formulario y el paso a paso. */
function mostrarConfirmacion(f) {
  const c = cuentaActiva();
  const t = totalesDe(f.items, /\b(A|B)$/.test(f.tipoComprobante));
  const real = $('#badgeAmbiente').classList.contains('real');
  $('#confirmarCuerpo').innerHTML = `
    <div class="aviso ${real ? 'atencion' : 'info'}">${ic(real ? 'alerta' : 'info')}<span>${real ? 'Esto emite una factura <strong>real</strong> en ARCA. No se puede borrar: solo se anula con una nota de crédito.' : 'Modo prueba: se autoriza en el entorno de prueba de ARCA, sin validez fiscal.'}</span></div>
    <dl class="ficha">
      <dt>Emite</dt><dd>${esc(c.razonSocial)} · <span class="dato">${fmtCuit(c.cuit)}</span></dd>
      <dt>Comprobante</dt><dd>${esc(f.tipoComprobante)} · ${esc(NOMBRE_CONCEPTO[f.concepto] || '')}${f.fechaEmision ? ` · ${fmtFecha(f.fechaEmision)}` : ''}</dd>
      <dt>Cliente</dt><dd>${esc(f.receptor.razonSocial || 'Consumidor Final')}${f.receptor.nroDoc ? ` · <span class="dato">${fmtCuit(f.receptor.nroDoc)}</span>` : ''}<br><span class="tenue">${esc(f.receptor.condicionIva)}</span></dd>
      <dt>Ítems</dt><dd>${f.items.map(i => `${esc(i.descripcion)} × ${i.cantidad}`).join('<br>')}</dd>
      <dt>Total</dt><dd class="monto" style="font-size:22px">${fmtPesos(t.total)}</dd>
      ${f.receptor.email ? `<dt>Se envía a</dt><dd>${esc(f.receptor.email)}${real ? '' : ' <span class="tenue">(en modo prueba no se manda)</span>'}</dd>` : ''}
    </dl>`;
  $('#btnConfirmarEmision').textContent = real ? `Emitir ${fmtPesos(t.total)}` : 'Emitir de prueba';
  $('#dlgConfirmar').showModal();
  $('#btnConfirmarEmision').focus(); // Enter confirma
}

$('#btnConfirmarEmision').addEventListener('click', async () => {
  const btn = $('#btnConfirmarEmision');
  if (!facturaPendiente || btn.getAttribute('aria-busy')) return;
  ocupado(btn, true);
  btn.textContent = 'Emitiendo…';
  const datos = facturaPendiente;
  const r = await api('/api/erp/facturacion/emitir', { method: 'POST', body: datos });
  ocupado(btn, false);
  $('#dlgConfirmar').close();
  mostrarResultado(r, datos);
  if (r.ok) {
    facturaPendiente = null;
    guardarClienteSiEsNuevo(datos.receptor);
  }
});

function mostrarResultado(r, datos) {
  const caja = $('#resultadoEmision');
  const d = r.data || {};
  caja.classList.remove('oculto');
  if (!r.ok) {
    const posible = /puede haber quedado emitido|ATENCIÓN/i.test(d.message || '');
    caja.innerHTML = `<div class="seccion">
      <h2>${posible ? 'Revisá en ARCA antes de reintentar' : 'No se emitió'}</h2>
      <div class="aviso ${posible ? 'atencion' : 'error'}" style="margin-top:12px">${ic('alerta')}<span>${esc(d.message || 'Error desconocido.')}</span></div>
      <div class="fila-acciones" style="margin-top:16px"><button class="boton" data-accion="cerrar-resultado">Volver a la factura</button></div></div>`;
  } else {
    caja.innerHTML = `<div class="seccion">
      <p class="tenue">${esc(d.message || 'Comprobante emitido')}</p>
      <h2 style="margin:6px 0 16px">${esc(d.tipoComprobante)} <span class="dato">${esc(d.comprobanteNro)}</span></h2>
      <dl class="ficha">
        <dt>CAE</dt><dd class="cae">${esc(d.cae || 'no leído')}</dd>
        <dt>Vence</dt><dd>${esc(d.caeVencimiento || '-')}</dd>
        <dt>Total</dt><dd class="monto" style="font-size:22px">${fmtPesos(d.totalImporte)}</dd>
        <dt>Cliente</dt><dd>${esc(datos.receptor.razonSocial || 'Consumidor Final')}</dd>
        ${datos.receptor.email ? `<dt>Mail</dt><dd>${d.emailEnviado ? `Enviado a ${esc(datos.receptor.email)}` : d.ambiente === 'homologacion' ? 'No se manda en modo prueba' : 'No se pudo enviar: reintentalo desde el botón'}</dd>` : ''}
      </dl>
      <div class="fila-acciones" style="margin-top:20px">
        ${d.comprobanteId ? `<button class="boton" data-accion="pdf" data-id="${d.comprobanteId}">${ic('pdf')}Ver PDF</button><button class="boton" data-accion="enviar" data-id="${d.comprobanteId}">${ic('mail')}Enviar por mail</button>` : ''}
        <button class="boton principal" data-accion="nueva">${ic('mas')}Nueva factura</button>
      </div></div>`;
    $$('[data-modo-panel]').forEach(p => p.classList.add('oculto'));
  }
  caja.focus();
  caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#resultadoEmision').addEventListener('click', (e) => {
  const b = e.target.closest('[data-accion]');
  if (!b) return;
  const accion = b.dataset.accion;
  if (accion === 'pdf') verPdf(b.dataset.id, b);
  if (accion === 'enviar') abrirComprobante(b.dataset.id, true);
  if (accion === 'cerrar-resultado') $('#resultadoEmision').classList.add('oculto');
  if (accion === 'nueva') limpiarFactura();
});

function limpiarFactura() {
  $('#formFactura').reset();
  $('#items').innerHTML = '';
  agregarItem();
  actualizarFormTipo();
  $('#facDocTipo').dispatchEvent(new Event('change'));
  $$('#formFactura [aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  asisReiniciar();
  cambiarModo(estado.modo === 'una' ? 'una' : 'paso');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ======================================================================
   FACTURAR · PASO A PASO (una pregunta por pantalla, Enter para avanzar)
   ====================================================================== */
const hoyIso = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const CONDICIONES = ['Consumidor Final', 'Responsable Inscripto', 'Monotributo', 'Exento'];
const ALICUOTAS = [['21', '21 %'], ['10.5', '10,5 %'], ['27', '27 %'], ['5', '5 %'], ['2.5', '2,5 %'], ['0', '0 %'], ['exento', 'Exento']];

function asisNuevo() {
  return { fecha: hoyIso(), tipo: 'Factura C', concepto: 2, doc: '', clienteConocido: false, nombre: '', condIva: '', email: '', items: [], item: { descripcion: '', importe: '', alicuota: '21' } };
}
let asis = asisNuevo();
let asisPaso = 0;

function cuitOk(c) {
  if (!/^\d{11}$/.test(c)) return false;
  const p = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let dv = 11 - (p.reduce((a, x, i) => a + x * Number(c[i]), 0) % 11);
  if (dv === 11) dv = 0; if (dv === 10) dv = 9;
  return dv === Number(c[10]);
}
const conIva = () => /\b(A|B)$/.test(asis.tipo);
const docLimpio = () => asis.doc.replace(/\D/g, '');

/* Definición de cada paso. "saltar" oculta pasos que no aplican; "resumen" muestra lo cargado. */
const PASOS = [
  { id: 'fecha', pregunta: 'Fecha de la factura', ayuda: 'Ya está la de hoy: si es esa, apretá Enter.', tipo: 'fecha',
    valor: () => asis.fecha, validar: (v) => (!v ? 'Elegí una fecha.' : null), guardar: (v) => { asis.fecha = v; },
    chip: () => fmtFecha(asis.fecha) },
  { id: 'tipo', pregunta: '¿Qué comprobante?', ayuda: 'Tocá una opción o apretá su número. Las notas de crédito se cargan desde "Formulario".', tipo: 'opciones',
    opciones: () => [['Factura C', 'Monotributo'], ['Factura B', 'Responsable Inscripto a consumidor final o monotributista'], ['Factura A', 'Responsable Inscripto a otro Responsable Inscripto'], ['Recibo C', 'Monotributo']],
    valor: () => asis.tipo, guardar: (v) => { asis.tipo = v; }, chip: () => asis.tipo },
  { id: 'concepto', pregunta: '¿Qué se factura?', tipo: 'opciones',
    opciones: () => [['2', 'Servicios'], ['1', 'Productos'], ['3', 'Productos y servicios']],
    valor: () => String(asis.concepto), guardar: (v) => { asis.concepto = Number(v); }, chip: () => NOMBRE_CONCEPTO[asis.concepto] },
  { id: 'doc', pregunta: '¿A quién? CUIT o DNI del cliente', ayuda: 'Podés escribir el nombre de un cliente guardado. Vacío = Consumidor Final sin identificar.', tipo: 'cliente',
    valor: () => asis.doc,
    validar: (v) => {
      const d = String(v).replace(/\D/g, '');
      if (!d) return /^A$/.test(asis.tipo.slice(-1)) ? 'Una Factura A necesita el CUIT del cliente.' : null;
      if (d.length === 11) return cuitOk(d) ? null : 'Ese CUIT no es válido (revisá los números).';
      if (d.length >= 7 && d.length <= 8) return asis.tipo === 'Factura A' ? 'Una Factura A necesita CUIT, no DNI.' : null;
      return 'Un CUIT tiene 11 números y un DNI 7 u 8.';
    },
    guardar: (v) => {
      const d = String(v).replace(/\D/g, '');
      asis.doc = d;
      const c = d && estado.clientes.find(x => String(x.cuit).replace(/\D/g, '') === d);
      asis.clienteConocido = !!c;
      if (c) { asis.nombre = c.razonSocial || ''; asis.condIva = c.condicionIva || ''; asis.email = c.email || ''; }
      else if (!d) { asis.nombre = ''; asis.condIva = 'Consumidor Final'; }
    },
    chip: () => (docLimpio() ? fmtCuit(docLimpio()) : 'Consumidor Final') },
  { id: 'nombre', pregunta: 'Nombre o razón social', tipo: 'texto', placeholder: 'Acme SA',
    saltar: () => !docLimpio(),
    ayuda: () => (asis.clienteConocido ? 'Cliente guardado: si está bien, Enter.' : docLimpio().length === 11 ? '' : 'Opcional para DNI.'),
    valor: () => asis.nombre,
    validar: (v) => (docLimpio().length === 11 && !String(v).trim() ? 'Falta el nombre o razón social.' : null),
    guardar: (v) => { asis.nombre = String(v).trim(); }, chip: () => asis.nombre },
  { id: 'condIva', pregunta: 'Condición frente al IVA del cliente', tipo: 'opciones',
    saltar: () => !docLimpio(),
    opciones: () => CONDICIONES.filter(c => asis.tipo !== 'Factura A' || ['Responsable Inscripto', 'Monotributo'].includes(c)).map(c => [c, '']),
    valor: () => asis.condIva, validar: (v) => (!v ? 'Elegí una opción.' : null), guardar: (v) => { asis.condIva = v; }, chip: () => asis.condIva },
  { id: 'descripcion', pregunta: () => (asis.items.length ? `Ítem ${asis.items.length + 1}: ¿qué se factura?` : 'Descripción'), tipo: 'texto', placeholder: 'Honorarios de octubre',
    valor: () => asis.item.descripcion, validar: (v) => (!String(v).trim() ? 'Escribí qué se factura.' : null),
    guardar: (v) => { asis.item.descripcion = String(v).trim(); }, chip: () => asis.item.descripcion },
  { id: 'importe', pregunta: () => (conIva() ? 'Importe sin IVA' : 'Importe'), tipo: 'importe',
    ayuda: () => (conIva() ? 'Sin IVA: el IVA lo sumás en el paso siguiente.' : 'El total final de este ítem.'),
    valor: () => asis.item.importe, validar: (v) => (numero(v) > 0 ? null : 'Escribí un importe mayor a cero.'),
    guardar: (v) => { asis.item.importe = String(v); }, chip: () => fmtPesos(numero(asis.item.importe)) },
  { id: 'alicuota', pregunta: 'Alícuota de IVA', tipo: 'opciones', saltar: () => !conIva(),
    opciones: () => ALICUOTAS.map(([v, n]) => [v, '', n]),
    valor: () => asis.item.alicuota, guardar: (v) => { asis.item.alicuota = v; }, chip: () => `IVA ${(ALICUOTAS.find(a => a[0] === asis.item.alicuota) || [, ''])[1]}` },
  { id: 'email', pregunta: 'Email para mandarle la factura', ayuda: 'Opcional: si no querés mandarla, dejalo vacío y Enter.', tipo: 'email', placeholder: 'cliente@empresa.com',
    valor: () => asis.email, validar: (v) => (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? 'Ese email no es válido.' : null),
    guardar: (v) => { asis.email = String(v).trim(); }, chip: () => asis.email || 'sin email' },
  { id: 'resumen', pregunta: 'Revisá y emití', tipo: 'resumen' },
];

const pasosVisibles = () => PASOS.filter(p => !(p.saltar && p.saltar()));
const textoDe = (x) => (typeof x === 'function' ? x() : x || '');

function asisReiniciar() {
  asis = asisNuevo();
  asisPaso = 0;
  asisMostrar();
}

function itemsDelAsistente() {
  const todos = [...asis.items];
  if (asis.item.descripcion && numero(asis.item.importe) > 0) todos.push(asis.item);
  return todos.map(it => {
    const p = numero(it.importe);
    return { descripcion: it.descripcion, cantidad: 1, precioUnitario: p, subtotal: p, alicuotaIva: conIva() ? it.alicuota : undefined };
  });
}

function asisMostrar() {
  if (!$('#asistente')) return;
  const visibles = pasosVisibles();
  asisPaso = Math.min(asisPaso, visibles.length - 1);
  const p = visibles[asisPaso];
  $('#asisBarra').style.width = `${Math.round((asisPaso / (visibles.length - 1)) * 100)}%`;
  $('#asisNum').textContent = p.tipo === 'resumen' ? 'Último paso' : `Paso ${asisPaso + 1} de ${visibles.length - 1}`;
  $('#asisPregunta').textContent = textoDe(p.pregunta);
  $('#asisAyuda').textContent = textoDe(p.ayuda);
  $('#asisError').textContent = '';
  $('#asisAtras').style.visibility = asisPaso === 0 ? 'hidden' : 'visible';
  $('#asisSiguiente').classList.toggle('oculto', p.tipo === 'resumen');
  $('.asis-tecla').classList.toggle('oculto', p.tipo === 'resumen');
  const campo = $('#asisCampo');

  if (p.tipo === 'opciones') {
    const ops = p.opciones();
    const actual = p.valor();
    campo.innerHTML = `<div class="opciones" role="radiogroup" aria-labelledby="asisPregunta">${ops.map(([v, sub, nombre], i) =>
      `<button type="button" class="opcion" role="radio" data-valor="${esc(v)}" aria-checked="${String(v === actual)}"><kbd>${i + 1}</kbd><span>${esc(nombre || v)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`).join('')}</div>`;
    (campo.querySelector('[aria-checked="true"]') || campo.querySelector('.opcion')).focus();
  } else if (p.tipo === 'resumen') {
    campo.innerHTML = asisResumenHtml();
    campo.querySelector('[data-asis="emitir"]')?.focus();
  } else {
    const tipoInput = { fecha: 'date', email: 'email' }[p.tipo] || 'text';
    const modo = p.tipo === 'importe' ? 'decimal' : p.tipo === 'cliente' ? 'search' : '';
    campo.innerHTML = `<input id="asisEntrada" type="${tipoInput}" ${modo ? `inputmode="${modo === 'search' ? 'text' : modo}"` : ''} class="${p.tipo === 'importe' ? 'monto-entrada' : ''}" placeholder="${esc(p.placeholder || (p.tipo === 'importe' ? '0,00' : p.tipo === 'cliente' ? '20123456786 o nombre del cliente' : ''))}" value="${esc(p.valor())}" aria-labelledby="asisPregunta" autocomplete="off" enterkeyhint="next">
      ${p.tipo === 'cliente' ? '<div id="asisSugerencias" class="asis-sugerencias" role="listbox" aria-label="Clientes guardados"></div>' : ''}`;
    const entrada = $('#asisEntrada');
    entrada.focus();
    if (entrada.type !== 'date' && entrada.type !== 'email') entrada.select?.();
    if (p.tipo === 'cliente') { entrada.addEventListener('input', asisSugerir); asisSugerir(); }
  }
  asisRespuestas();
}

function asisSugerir() {
  const caja = $('#asisSugerencias');
  if (!caja) return;
  const q = $('#asisEntrada').value.trim().toLowerCase();
  const soloNumeros = q.replace(/\D/g, '');
  const lista = !q ? [] : estado.clientes.filter(c =>
    String(c.razonSocial || '').toLowerCase().includes(q) || (soloNumeros.length >= 3 && String(c.cuit).includes(soloNumeros))).slice(0, 5);
  // Si escribe un nombre, la primera coincidencia queda marcada: Enter la elige, las flechas cambian
  const marcarPrimera = /[a-záéíóúñ]/i.test(q);
  caja.innerHTML = lista.map((c, i) => `<button type="button" role="option" aria-selected="${String(marcarPrimera && i === 0)}" data-doc="${esc(c.cuit)}">${esc(c.razonSocial)} · ${fmtCuit(c.cuit)}</button>`).join('');
}

function asisRespuestas() {
  const visibles = pasosVisibles();
  $('#asisRespuestas').innerHTML = visibles.slice(0, asisPaso).filter(p => p.chip).map(p => {
    const i = visibles.indexOf(p);
    return `<li><button type="button" data-ir-paso="${i}" title="Cambiar">${esc(textoDe(p.pregunta).replace(/\?$/, '').replace(/^¿/, ''))}: <b>${esc(p.chip())}</b></button></li>`;
  }).join('');
}

function asisResumenHtml() {
  const items = itemsDelAsistente();
  const t = totalesDe(items, conIva());
  const c = cuentaActiva();
  return `<div class="asis-resumen">
    <div class="monto-grande">${fmtPesos(t.total)}</div>
    ${conIva() ? `<p class="tenue">Neto ${fmtPesos(t.neto)} + IVA ${fmtPesos(t.iva)}</p>` : ''}
    <dl class="ficha" style="margin-top:16px">
      <dt>Emite</dt><dd>${esc(c?.razonSocial || '—')}</dd>
      <dt>Comprobante</dt><dd>${esc(asis.tipo)} · ${esc(NOMBRE_CONCEPTO[asis.concepto])} · ${fmtFecha(asis.fecha)}</dd>
      <dt>Cliente</dt><dd>${esc(asis.nombre || 'Consumidor Final')}${docLimpio() ? ` · <span class="dato">${fmtCuit(docLimpio())}</span>` : ''}<br><span class="tenue">${esc(asis.condIva || 'Consumidor Final')}</span></dd>
      <dt>Detalle</dt><dd>${items.map(i => `${esc(i.descripcion)} · ${fmtPesos(i.precioUnitario)}${i.alicuotaIva ? ` + IVA ${esc(i.alicuotaIva === 'exento' ? 'exento' : i.alicuotaIva + ' %')}` : ''}`).join('<br>')}</dd>
      ${asis.email ? `<dt>Se envía a</dt><dd>${esc(asis.email)}</dd>` : ''}
    </dl>
    <div class="asis-acciones">
      <button type="button" class="boton principal" data-asis="emitir">${ic('factura')}Emitir ahora</button>
      <button type="button" class="boton" data-asis="cola">${ic('cola')}Mandar a la cola</button>
      <button type="button" class="boton" data-asis="otro-item">${ic('mas')}Agregar otro ítem</button>
    </div>
    <p class="ayuda" style="text-align:center"><button type="button" class="boton texto" data-asis="reiniciar">Empezar de nuevo</button></p>
  </div>`;
}

function asisDatosFactura() {
  const c = cuentaActiva();
  const d = docLimpio();
  return {
    cuitEmisor: c?.cuit,
    razonSocialEmisor: c?.razonSocial,
    tipoComprobante: asis.tipo,
    puntoVenta: c?.ws?.puntoVentaWs || c?.puntoVentaDefault || 1,
    concepto: asis.concepto,
    condicionVenta: 'Contado',
    fechaEmision: asis.fecha !== hoyIso() ? asis.fecha : undefined,
    receptor: {
      tipoDoc: !d ? 'Consumidor Final' : d.length === 11 ? 'CUIT' : 'DNI',
      nroDoc: d,
      razonSocial: asis.nombre || (d ? '' : 'Consumidor Final'),
      condicionIva: d ? asis.condIva : 'Consumidor Final',
      email: asis.email || undefined,
    },
    items: itemsDelAsistente(),
  };
}

function asisAvanzar() {
  const visibles = pasosVisibles();
  const p = visibles[asisPaso];
  if (p.tipo === 'resumen') return;
  let valor;
  if (p.tipo === 'opciones') valor = $('#asisCampo .opcion[aria-checked="true"]')?.dataset.valor || '';
  else valor = $('#asisEntrada').value;
  if (p.tipo === 'cliente') {
    // Si escribió un nombre y hay un único cliente que coincide, se toma ese
    const elegido = $('#asisSugerencias [aria-selected="true"]');
    if (elegido) valor = elegido.dataset.doc;
    else if (/[a-záéíóúñ]/i.test(valor)) { $('#asisError').textContent = 'No hay ningún cliente guardado con ese nombre: escribí el CUIT o DNI.'; return; }
  }
  const error = p.validar ? p.validar(valor) : null;
  if (error) {
    $('#asisError').textContent = error;
    ($('#asisEntrada') || $('#asisCampo .opcion'))?.focus();
    return;
  }
  p.guardar(valor);
  asisPaso = Math.min(asisPaso + 1, pasosVisibles().length - 1);
  asisMostrar();
}

$('#asistente').addEventListener('submit', (e) => { e.preventDefault(); asisAvanzar(); });
$('#asisAtras').addEventListener('click', () => { if (asisPaso > 0) { asisPaso--; asisMostrar(); } });

$('#asisCampo').addEventListener('click', (e) => {
  const op = e.target.closest('.opcion');
  if (op) {
    $$('#asisCampo .opcion').forEach(o => o.setAttribute('aria-checked', String(o === op)));
    asisAvanzar(); // tocar una opción ya avanza
    return;
  }
  const sug = e.target.closest('#asisSugerencias button');
  if (sug) { $('#asisEntrada').value = sug.dataset.doc; $('#asisSugerencias').innerHTML = ''; asisAvanzar(); return; }
  const accion = e.target.closest('[data-asis]')?.dataset.asis;
  if (!accion) return;
  if (accion === 'reiniciar') { asisReiniciar(); return; }
  if (accion === 'otro-item') {
    asis.items.push(asis.item);
    asis.item = { descripcion: '', importe: '', alicuota: asis.item.alicuota };
    asisPaso = pasosVisibles().findIndex(p => p.id === 'descripcion');
    asisMostrar();
    return;
  }
  if (!puedeOperar()) return aviso('Tu usuario es de solo lectura.', 'error');
  if (!cuentaActiva()) return aviso('Primero cargá la empresa que factura en Ajustes.', 'error');
  if (accion === 'emitir') { facturaPendiente = asisDatosFactura(); mostrarConfirmacion(facturaPendiente); }
  if (accion === 'cola') asisACola(e.target.closest('button'));
});

// Teclado en las opciones: números para elegir, flechas para moverse, Enter para aceptar
$('#asisCampo').addEventListener('keydown', (e) => {
  const ops = $$('#asisCampo .opcion');
  if (ops.length) {
    const n = Number(e.key);
    if (n >= 1 && n <= ops.length) { e.preventDefault(); ops[n - 1].click(); return; }
    const i = ops.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault();
      const sig = ops[(Math.max(i, 0) + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : ops.length - 1)) % ops.length];
      ops.forEach(o => o.setAttribute('aria-checked', String(o === sig)));
      sig.focus();
    }
    if (e.key === 'Enter' && i >= 0) { e.preventDefault(); ops[i].click(); }
    return;
  }
  const sugs = $$('#asisSugerencias button');
  if (sugs.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const i = sugs.findIndex(s => s.getAttribute('aria-selected') === 'true');
    const j = e.key === 'ArrowDown' ? Math.min(i + 1, sugs.length - 1) : Math.max(i - 1, -1);
    sugs.forEach((s, k) => s.setAttribute('aria-selected', String(k === j)));
  }
});

$('#asisRespuestas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ir-paso]');
  if (b) { asisPaso = Number(b.dataset.irPaso); asisMostrar(); }
});

async function asisACola(btn) {
  const f = asisDatosFactura();
  if (f.items.length > 1) return aviso('La cola carga un ítem por factura. Emitila ahora o dejá un solo ítem.', 'error');
  const it = f.items[0];
  const total = totalesDe(f.items, conIva()).total;
  ocupado(btn, true);
  const r = await api('/api/queue/add', { method: 'POST', body: { items: [{
    cuitEmisor: f.cuitEmisor, puntoVenta: f.puntoVenta, tipoComprobante: f.tipoComprobante, concepto: f.concepto,
    docTipo: f.receptor.tipoDoc === 'CUIT' ? 'CUIT' : f.receptor.tipoDoc === 'DNI' ? 'DNI' : 'Consumidor Final',
    docNro: f.receptor.nroDoc, razonSocial: f.receptor.razonSocial, condicionIva: f.receptor.condicionIva,
    condicionVenta: f.condicionVenta, descripcion: it.descripcion, cantidad: 1, precioUnitario: total, importeTotal: total, email: f.receptor.email || '',
  }] } });
  ocupado(btn, false);
  if (!r.ok) return aviso((r.data.problemas || [])[0] || r.data.message, 'error');
  aviso('Quedó en la cola como pendiente.');
  guardarClienteSiEsNuevo(f.receptor);
  asisReiniciar();
  cargarCola();
}

async function guardarClienteSiEsNuevo(rec) {
  if (!rec.nroDoc || estado.clientes.some(c => String(c.cuit).replace(/\D/g, '') === rec.nroDoc)) return;
  const r = await api('/api/erp/clientes', { method: 'POST', body: { cuit: rec.nroDoc, razonSocial: rec.razonSocial, tipoDoc: rec.tipoDoc === 'DNI' ? 'DNI' : 'CUIT', condicionIva: rec.condicionIva, email: rec.email, domicilio: rec.domicilio } });
  if (r.ok) cargarClientes();
}

/* ======================================================================
   FACTURAR · VARIAS (borradores)
   ====================================================================== */
$('#btnInterpretar').addEventListener('click', async () => {
  const texto = $('#txtLote').value.trim();
  if (!texto) return aviso('Pegá una lista o un mensaje primero.', 'error');
  const btn = $('#btnInterpretar');
  ocupado(btn, true);
  const r = await api('/api/queue/parse-excel', { method: 'POST', body: { text: texto, forceAi: $('#chkIa').checked } });
  ocupado(btn, false);
  const msg = $('#loteMensaje');
  if (!r.ok) { msg.className = 'aviso error'; msg.textContent = r.data.message || 'No se pudo leer el texto.'; return; }
  const leidos = r.data.items || [];
  const lector = { groq_ai: 'Leído con IA (Groq).', heuristic_nlp: 'Leído sin IA.', tabular: 'Leído como tabla.' }[r.data.parserUsed] || '';
  if (!leidos.length) {
    msg.className = 'aviso atencion';
    msg.textContent = `No se encontraron facturas en el texto. ${r.data.message || 'Revisá que cada línea tenga un importe.'}`;
    estado.borradores = []; renderBorradores();
    return;
  }
  // Las completas van directo a la cola; las dudosas quedan para revisar
  const completos = leidos.filter(b => !problemasBorrador(b).length && !(b.advertencias || []).some(a => /no es válido/.test(a)));
  const aRevisar = leidos.filter(b => !completos.includes(b));
  let agregados = 0;
  if (completos.length) {
    if (!puedeOperar()) { aviso('Tu usuario es de solo lectura.', 'error'); estado.borradores = leidos; renderBorradores(); return; }
    ocupado(btn, true);
    const rc = await api('/api/queue/add', { method: 'POST', body: { items: completos.map(prepararParaCola) } });
    ocupado(btn, false);
    if (rc.ok) agregados = rc.data.count;
    else aRevisar.unshift(...completos);
  }
  estado.borradores = aRevisar;
  msg.className = aRevisar.length ? 'aviso atencion' : 'aviso ok';
  msg.textContent = `${lector} ${agregados ? `${agregados} quedaron en la cola como pendientes.` : ''} ${aRevisar.length ? `${aRevisar.length} necesitan revisión: corregilas abajo y pasalas a la cola.` : ''}${r.data.message ? ' ' + r.data.message : ''}`.trim();
  renderBorradores();
  if (agregados) {
    cargarCola();
    if (!aRevisar.length) { $('#txtLote').value = ''; aviso(`${agregados} factura(s) pendiente(s) en la cola.`); cambiarModo('cola'); }
  }
});

function prepararParaCola(b) {
  const c = cuentaActiva();
  const doc = String(b.docNro || '').replace(/\D/g, '');
  const imp = numero(b.importeTotal);
  return { ...b, docNro: doc, docTipo: doc.length === 11 ? 'CUIT' : doc ? 'DNI' : 'Consumidor Final', condicionIva: b.condicionIva || (doc.length === 11 ? '' : 'Consumidor Final'), importeTotal: imp, precioUnitario: imp, cantidad: 1, cuitEmisor: c?.cuit, puntoVenta: c?.ws?.puntoVentaWs || c?.puntoVentaDefault || 1 };
}

$('#archivoLote').addEventListener('change', () => {
  const f = $('#archivoLote').files[0];
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) return aviso('El archivo pesa más de 2 MB.', 'error');
  const lector = new FileReader();
  lector.onload = () => { $('#txtLote').value = String(lector.result || ''); $('#archivoLote').value = ''; aviso(`Cargado "${f.name}". Revisalo y tocá "Agregar a la cola".`); };
  lector.readAsText(f, 'utf-8');
});

const CONDS = ['', 'Consumidor Final', 'Responsable Inscripto', 'Monotributo', 'Exento'];
function problemasBorrador(b) {
  const p = [];
  const doc = String(b.docNro || '').replace(/\D/g, '');
  if (doc && doc.length !== 11 && (doc.length < 7 || doc.length > 8)) p.push('Documento inválido.');
  if (doc.length === 11 && !b.condicionIva) p.push('Falta la condición frente al IVA.');
  if (doc.length === 11 && !String(b.razonSocial || '').trim()) p.push('Falta el nombre.');
  if (!String(b.descripcion || '').trim()) p.push('Falta la descripción.');
  if (!(numero(b.importeTotal) > 0)) p.push('Falta el importe.');
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) p.push('Email inválido.');
  return p;
}

function renderBorradores() {
  const caja = $('#borradores');
  caja.classList.toggle('oculto', !estado.borradores.length);
  if (!estado.borradores.length) { caja.innerHTML = ''; return; }
  caja.innerHTML = estado.borradores.map((b, i) => {
    const p = [...new Set([...(b.advertencias || []).filter(a => /CUIT .* no es válido/.test(a)), ...problemasBorrador(b)])];
    return `<div class="borrador" data-i="${i}">
      <div class="cabecera"><strong>Borrador ${i + 1}</strong>
        <div class="fila-acciones">${p.length ? `<span class="etiqueta-estado e-prueba">Revisar</span>` : `<span class="etiqueta-estado e-ok">Listo</span>`}
        <button class="boton chico texto peligro" data-quitar="${i}" aria-label="Quitar borrador ${i + 1}">${ic('basura')}</button></div></div>
      ${p.length ? `<ul class="problemas">${p.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <div class="campos tres">
        <div><label for="b${i}doc">CUIT / DNI</label><input id="b${i}doc" data-c="docNro" value="${esc(b.docNro)}" inputmode="numeric" placeholder="Vacío = Consumidor Final"></div>
        <div><label for="b${i}nom">Nombre</label><input id="b${i}nom" data-c="razonSocial" value="${esc(b.razonSocial)}"></div>
        <div><label for="b${i}iva">Condición IVA</label><select id="b${i}iva" data-c="condicionIva">${CONDS.map(c => `<option value="${c}" ${c === b.condicionIva ? 'selected' : ''}>${c || 'Elegir…'}</option>`).join('')}</select></div>
        <div><label for="b${i}des">Descripción</label><input id="b${i}des" data-c="descripcion" value="${esc(b.descripcion)}"></div>
        <div><label for="b${i}imp">Importe</label><input id="b${i}imp" data-c="importeTotal" value="${esc(b.importeTotal)}" inputmode="decimal"></div>
        <div><label for="b${i}tip">Tipo</label><select id="b${i}tip" data-c="tipoComprobante">${['Factura C', 'Factura B', 'Factura A', 'Recibo C'].map(t => `<option ${t === b.tipoComprobante ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="ancho-total"><label for="b${i}mail">Email (opcional)</label><input id="b${i}mail" data-c="email" type="email" value="${esc(b.email || '')}"></div>
      </div></div>`;
  }).join('') + `<div class="seccion" style="border-top:1px solid var(--linea);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
      <span class="tenue">${estado.borradores.length} borrador(es) · total ${fmtPesos(estado.borradores.reduce((a, b) => a + numero(b.importeTotal), 0))}</span>
      <button class="boton principal" id="btnACola">${ic('cola')}Pasar a la cola</button></div>`;
}

$('#borradores').addEventListener('input', (e) => {
  const campo = e.target.dataset.c;
  const fila = e.target.closest('[data-i]');
  if (!campo || !fila) return;
  const b = estado.borradores[Number(fila.dataset.i)];
  b[campo] = e.target.value;
  if (campo === 'importeTotal') { b.precioUnitario = numero(e.target.value); b.cantidad = 1; }
  if (campo === 'docNro') b.advertencias = [];
  const p = problemasBorrador(b);
  const etiqueta = fila.querySelector('.etiqueta-estado');
  etiqueta.className = `etiqueta-estado ${p.length ? 'e-prueba' : 'e-ok'}`;
  etiqueta.textContent = p.length ? 'Revisar' : 'Listo';
  let ul = fila.querySelector('.problemas');
  if (p.length) { if (!ul) { ul = document.createElement('ul'); ul.className = 'problemas'; fila.querySelector('.cabecera').after(ul); } ul.innerHTML = p.map(x => `<li>${esc(x)}</li>`).join(''); }
  else ul?.remove();
});

$('#borradores').addEventListener('click', async (e) => {
  const q = e.target.closest('[data-quitar]');
  if (q) { estado.borradores.splice(Number(q.dataset.quitar), 1); renderBorradores(); return; }
  if (e.target.closest('#btnACola')) {
    if (!puedeOperar()) return aviso('Tu usuario es de solo lectura.', 'error');
    const malos = estado.borradores.map((b, i) => problemasBorrador(b).length ? i + 1 : 0).filter(Boolean);
    if (malos.length) return aviso(`Revisá ${malos.length === 1 ? 'el borrador' : 'los borradores'} ${malos.join(', ')} antes de pasarlos a la cola.`, 'error');
    const c = cuentaActiva();
    const items = estado.borradores.map(prepararParaCola);
    const btn = e.target.closest('#btnACola');
    ocupado(btn, true);
    const r = await api('/api/queue/add', { method: 'POST', body: { items } });
    ocupado(btn, false);
    if (!r.ok) return aviso((r.data.problemas || [])[0] || r.data.message, 'error');
    aviso(`${r.data.count} comprobante(s) en la cola. Nada se emite hasta que toques "Emitir pendientes".`);
    estado.borradores = []; renderBorradores(); $('#txtLote').value = ''; $('#loteMensaje').classList.add('oculto');
    cambiarModo('cola');
  }
});

/* ======================================================================
   FACTURAR · COLA
   ====================================================================== */
const ESTADO_COLA = { pendiente: ['e-espera', 'Pendiente'], procesando: ['e-proceso', 'Emitiendo'], emitida: ['e-ok', 'Emitida'], error: ['e-error', 'Con error'] };

async function cargarCola() {
  const r = await api('/api/queue');
  if (!r.ok) return;
  estado.cola = r.data;
  const pend = (r.data.items || []).filter(i => i.estado === 'pendiente').length;
  $('#navCola').textContent = pend; $('#navCola').classList.toggle('oculto', !pend);
  $('#segCola').textContent = pend ? `(${pend})` : '';
  renderCola();
  clearInterval(estado.sondeoCola);
  if (r.data.isProcessing) estado.sondeoCola = setInterval(cargarCola, 3000);
}

function renderCola() {
  const items = estado.cola.items || [];
  const pend = items.filter(i => i.estado === 'pendiente');
  $('#btnProcesarCola').innerHTML = `${ic('play')}Emitir pendientes${pend.length ? ` (${pend.length})` : ''}`;
  $('#colaEstado').textContent = estado.cola.isProcessing ? 'Emitiendo… podés cerrar esta pantalla, sigue en el servidor.' : '';
  $('#listaCola').innerHTML = items.length ? items.map(it => {
    const [cls, txt] = ESTADO_COLA[it.estado] || ['e-espera', it.estado];
    return `<li><div class="fila" style="cursor:default">
      <div style="min-width:0"><div class="principal-txt">${esc(it.razonSocial || 'Consumidor Final')}</div>
        <div class="secundario">${esc(it.tipoComprobante)} · ${esc(it.descripcion)}${it.docNro ? ` · <span class="dato">${fmtCuit(it.docNro)}</span>` : ''}</div>
        ${it.estado === 'emitida' ? `<div class="secundario">N° <span class="dato">${esc(it.comprobanteNro)}</span> · CAE <span class="dato">${esc(it.cae || '-')}</span></div>` : ''}
        ${it.estado === 'error' ? `<div class="secundario" style="color:var(--error);white-space:normal">${esc(it.errorMensaje)}</div>` : ''}</div>
      <div class="derecha"><div class="monto">${fmtPesos(it.importeTotal)}</div>
        <div class="fila-acciones" style="justify-content:flex-end;margin-top:4px"><span class="etiqueta-estado ${cls}">${txt}</span>
        ${it.estado !== 'procesando' ? `<button class="boton chico texto peligro" data-borrar-cola="${it.id}" aria-label="Quitar de la cola">${ic('basura')}</button>` : ''}</div></div>
    </div></li>`;
  }).join('') : `<li class="vacio"><h3>La cola está vacía</h3><p>Cargá varias facturas desde "Varias": se revisan y quedan acá hasta que decidas emitirlas.</p></li>`;
}

$('#listaCola').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-borrar-cola]');
  if (!b) return;
  const r = await api(`/api/queue/${b.dataset.borrarCola}`, { method: 'DELETE' });
  if (!r.ok) return aviso(r.data.message || 'No se pudo quitar.', 'error');
  cargarCola();
});

$('#btnProcesarCola').addEventListener('click', () => {
  if (!puedeOperar()) return aviso('Tu usuario es de solo lectura.', 'error');
  const pend = (estado.cola.items || []).filter(i => i.estado === 'pendiente');
  if (!pend.length) return aviso('No hay comprobantes pendientes.', 'error');
  const real = $('#badgeAmbiente').classList.contains('real');
  const total = pend.reduce((a, i) => a + Number(i.importeTotal || 0), 0);
  $('#confirmarCuerpo').innerHTML = `
    <div class="aviso ${real ? 'atencion' : 'info'}">${ic(real ? 'alerta' : 'info')}<span>${real ? `Se van a emitir <strong>${pend.length} facturas reales</strong> en ARCA, una por una.` : `Se van a autorizar ${pend.length} comprobantes de prueba.`}</span></div>
    <dl class="ficha"><dt>Cantidad</dt><dd>${pend.length}</dd><dt>Total</dt><dd class="monto" style="font-size:22px">${fmtPesos(total)}</dd></dl>`;
  $('#btnConfirmarEmision').textContent = real ? `Emitir ${pend.length} facturas` : 'Emitir de prueba';
  facturaPendiente = '__cola__';
  $('#dlgConfirmar').showModal();
});

// El mismo diálogo confirma una factura o la cola
$('#btnConfirmarEmision').addEventListener('click', async (e) => {
  if (facturaPendiente !== '__cola__') return;
  e.stopImmediatePropagation();
  facturaPendiente = null;
  $('#dlgConfirmar').close();
  const r = await api('/api/queue/process', { method: 'POST', body: {} });
  if (!r.ok) return aviso(r.data.message || 'No se pudo iniciar.', 'error');
  aviso('Emitiendo la cola. El estado se actualiza solo.');
  setTimeout(cargarCola, 800);
}, true);

$('#btnLimpiarCola').addEventListener('click', async () => {
  const r = await api('/api/queue/clear', { method: 'POST', body: { status: 'emitida' } });
  if (r.ok) { aviso('Se quitaron las emitidas de la cola (siguen en Comprobantes).'); cargarCola(); }
});

/* ======================================================================
   COMPROBANTES
   ====================================================================== */
const mesActual = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const nombreMes = (m) => { const [a, n] = m.split('-').map(Number); return new Date(a, n - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }); };
function moverMes(m, delta) { const [a, n] = m.split('-').map(Number); const d = new Date(a, n - 1 + delta, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
const fmtNum = (n) => Number(n || 0).toLocaleString('es-AR');

async function cargarComprobantes() {
  if (!$('#mesComp').value) $('#mesComp').value = mesActual();
  const mes = $('#mesComp').value;
  $('#mesSiguiente').disabled = mes >= mesActual();
  // Selector de CUIT solo si hay más de uno
  const selCuit = $('#cuitComp');
  const previo = selCuit.value;
  selCuit.innerHTML = '<option value="">Todos mis CUITs</option>' + estado.cuentas.map(c => `<option value="${c.cuit}">${esc(c.razonSocial || c.cuit)} · ${fmtCuit(c.cuit)}</option>`).join('');
  selCuit.value = estado.cuentas.some(c => c.cuit === previo) ? previo : '';
  selCuit.classList.toggle('oculto', estado.cuentas.length < 2);

  $('#listaComp').innerHTML = '<li class="vacio">Cargando…</li>';
  const qs = new URLSearchParams({ mes, ...(selCuit.value ? { cuit: selCuit.value } : {}) });
  const r = await api('/api/erp/comprobantes?' + qs);
  if ($('#mesComp').value !== mes) return; // cambió de mes mientras cargaba
  estado.comprobantes = r.ok ? r.data.comprobantes || [] : [];
  const res = r.ok ? r.data.resumen : null;
  estado.resumenMes = res;
  await cargarGrafico(mes, selCuit.value);
  const mesPrevio = (estado.serie || []).find(s => s.mes === moverMes(mes, -1));
  const delta = mesPrevio && mesPrevio.neto ? Math.round(((res?.total || 0) - mesPrevio.neto) / Math.abs(mesPrevio.neto) * 100) : null;
  $('#resumenComp').innerHTML = `
    <div><dt>Neto de ${esc(nombreMes(mes).split(' ')[0])}</dt><dd class="acento">${fmtPesos(res?.total || 0)}</dd>${delta !== null ? `<span class="delta">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs. mes anterior</span>` : ''}</div>
    <div><dt>Facturado</dt><dd>${fmtPesos(res?.facturado || 0)}</dd><span class="delta">${fmtNum(res?.facturas || 0)} facturas</span></div>
    <div><dt>Notas de crédito</dt><dd class="${res?.notasCredito ? 'negativo' : ''}">${res?.notasCredito ? '−' : ''}${fmtPesos(res?.notasCredito || 0)}</dd><span class="delta">${fmtNum(res?.notas || 0)} emitidas</span></div>
    <div><dt>De prueba</dt><dd>${fmtNum(res?.pruebas || 0)}</dd><span class="delta">sin validez fiscal</span></div>`;
  renderTopClientes(res?.topClientes || []);
  const hay = estado.comprobantes.length > 0;
  $('#btnZipMes').disabled = !hay;
  $('#btnPlanillaMes').disabled = !hay;
  if (!r.ok) aviso(r.data.message || 'No se pudieron cargar los comprobantes.', 'error');
  renderComprobantes();
  cargarUso();
}

async function cargarUso() {
  const r = await api('/api/erp/uso');
  const el = $('#usoComp');
  if (!r.ok || r.data.sinLimites) { el.classList.add('oculto'); return; }
  const { uso, limites } = r.data;
  const partes = [
    `${fmtNum(uso.comprobantesMes)} de ${fmtNum(limites.comprobantesMes)} comprobantes este mes`,
    `${fmtNum(uso.cuits)} de ${fmtNum(limites.cuits)} CUITs`,
    `${fmtNum(uso.clientes)} de ${fmtNum(limites.clientes)} clientes`,
  ];
  el.textContent = 'Tu uso: ' + partes.join(' · ') + '.';
  el.classList.remove('oculto');
}

$('#mesComp').addEventListener('change', () => { if ($('#mesComp').value > mesActual()) $('#mesComp').value = mesActual(); cargarComprobantes(); });
$('#mesAnterior').addEventListener('click', () => { $('#mesComp').value = moverMes($('#mesComp').value || mesActual(), -1); cargarComprobantes(); });
$('#mesSiguiente').addEventListener('click', () => { const s = moverMes($('#mesComp').value || mesActual(), 1); if (s <= mesActual()) { $('#mesComp').value = s; cargarComprobantes(); } });
$('#cuitComp').addEventListener('change', cargarComprobantes);

/* ---------- Tablero ---------- */
let graficoClave = '';
async function cargarGrafico(mesSel, cuit) {
  const clave = mesActual() + '|' + cuit;
  if (clave !== graficoClave || !estado.serie) {
    const qs = new URLSearchParams({ meses: '12', ...(cuit ? { cuit } : {}) });
    const r = await api('/api/erp/estadisticas?' + qs);
    estado.serie = r.ok ? r.data.serie || [] : [];
    graficoClave = clave;
  }
  const serie = estado.serie;
  const max = Math.max(1, ...serie.map(s => Math.max(0, s.neto)));
  const total = serie.reduce((a, s) => a + s.neto, 0);
  $('#graficoTotal').textContent = serie.length ? `${fmtPesos(total)} en el año` : '';
  $('#grafico').innerHTML = serie.map(s => {
    const alto = Math.max(1, Math.round(Math.max(0, s.neto) / max * 100));
    const nombre = nombreMes(s.mes);
    return `<button type="button" class="gbarra" data-mes="${s.mes}" aria-pressed="${s.mes === mesSel}" title="${esc(nombre)}: ${fmtPesos(s.neto)}" aria-label="${esc(nombre)}: ${fmtPesos(s.neto)}">
      <span class="valor" style="height:${alto}%"></span><span class="etq">${esc(nombre.slice(0, 3))}</span></button>`;
  }).join('');
}
$('#grafico').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mes]');
  if (!b) return;
  $('#mesComp').value = b.dataset.mes;
  cargarComprobantes();
});

function renderTopClientes(top) {
  $('#topClientes').innerHTML = top.length
    ? top.map(c => `<li><span class="nombre" title="${esc(c.nombre)}">${esc(c.nombre)}</span><span class="monto">${fmtPesos(c.total)}</span></li>`).join('')
    : '<li><span class="vacio-top">Todavía no hay ventas este mes.</span></li>';
}

estado.tipoLista = 'facturas';
$('#segTipo').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tipo]');
  if (!b) return;
  estado.tipoLista = b.dataset.tipo;
  $$('#segTipo [data-tipo]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  renderComprobantes();
});
const esNC = (c) => /nota de cr[eé]dito/i.test(c.tipoComprobante || '');

async function descargarMes(formato, btn) {
  const mes = $('#mesComp').value || mesActual();
  const qs = new URLSearchParams({ mes, ...(formato === 'csv' ? { formato: 'csv' } : {}), ...($('#cuitComp').value ? { cuit: $('#cuitComp').value } : {}) });
  ocupado(btn, true);
  if (formato !== 'csv') aviso('Armando el ZIP con los PDF del mes… puede tardar un poco.', 'info');
  const r = await api('/api/erp/comprobantes/descarga?' + qs, { blob: true });
  ocupado(btn, false);
  if (!r.ok) return aviso(r.data?.message || 'No se pudo descargar.', 'error');
  const url = URL.createObjectURL(r.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `comprobantes-${mes}${$('#cuitComp').value ? '-' + $('#cuitComp').value : ''}.${formato === 'csv' ? 'csv' : 'zip'}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  aviso(formato === 'csv' ? 'Planilla descargada.' : 'Listo: ZIP con los PDF y la planilla del mes.', 'ok');
}
$('#btnZipMes').addEventListener('click', (e) => descargarMes('zip', e.currentTarget));
$('#btnPlanillaMes').addEventListener('click', (e) => descargarMes('csv', e.currentTarget));

function renderComprobantes() {
  const q = $('#buscarComp').value.trim().toLowerCase();
  const filtro = $('#filtroComp').value;
  const lista = estado.comprobantes.filter(c => {
    if (estado.tipoLista === 'facturas' && esNC(c)) return false;
    if (estado.tipoLista === 'notas' && !esNC(c)) return false;
    if (filtro === 'Autorizado' && (c.estado !== 'Autorizado' || c.anuladoPor)) return false;
    if (filtro === 'Anulada' && !c.anuladoPor) return false;
    if (filtro === 'Prueba' && !/Prueba/.test(c.estado)) return false;
    if (!q) return true;
    return [c.razonSocialReceptor, c.cuitReceptor, c.comprobanteFormato, c.cae, c.tipoComprobante].join(' ').toLowerCase().includes(q.replace(/-/g, '')) ||
      [c.razonSocialReceptor, c.comprobanteFormato].join(' ').toLowerCase().includes(q);
  });
  $('#listaComp').innerHTML = lista.length ? lista.map(c => `<li><button class="fila" data-comp="${c.id}">
      <div style="min-width:0"><div class="principal-txt">${esc(c.razonSocialReceptor || 'Consumidor Final')}</div>
        <div class="secundario">${fmtFecha(c.fechaEmision)} · ${esc(c.tipoComprobante)} <span class="dato">${esc(c.comprobanteFormato)}</span></div></div>
      <div class="derecha"><div class="monto ${esNC(c) ? 'negativo' : ''}">${esNC(c) ? '−' : ''}${fmtPesos(c.importeTotal)}</div>
        ${c.anuladoPor ? '<span class="etiqueta-estado e-anulada" style="margin-top:4px">Anulada</span>'
          : esNC(c) ? '<span class="etiqueta-estado e-nc" style="margin-top:4px">Nota de crédito</span>'
          : `<span class="etiqueta-estado ${/Prueba/.test(c.estado) ? 'e-prueba' : 'e-ok'}" style="margin-top:4px">${/Prueba/.test(c.estado) ? 'Prueba' : 'Autorizada'}</span>`}</div>
    </button></li>`).join('')
    : estado.comprobantes.length
      ? `<li class="vacio"><h3>Sin resultados</h3><p>${estado.tipoLista === 'notas' ? 'No hay notas de crédito con ese filtro en este mes.' : 'Probá con otra búsqueda o filtro.'}</p></li>`
      : `<li class="vacio"><h3>Sin comprobantes en ${esc(nombreMes($('#mesComp').value || mesActual()))}</h3><p>Lo que emitas aparece acá, con su PDF y la opción de mandarlo por mail. Usá las flechas para ver otros meses.</p></li>`;
}
$('#buscarComp').addEventListener('input', renderComprobantes);
$('#filtroComp').addEventListener('change', renderComprobantes);
$('#listaComp').addEventListener('click', (e) => { const b = e.target.closest('[data-comp]'); if (b) abrirComprobante(b.dataset.comp); });

async function abrirComprobante(id, enfocarMail = false) {
  const r = await api(`/api/erp/comprobantes/${encodeURIComponent(id)}`);
  if (!r.ok) return aviso(r.data.message || 'No se encontró el comprobante.', 'error');
  const c = r.data.comprobante;
  const nc = esNC(c);
  $('#dlgCompTitulo').innerHTML = `${esc(c.tipoComprobante)} <span class="dato">${esc(c.comprobanteFormato)}</span>`;
  $('#dlgCompSub').textContent = `${fmtFecha(c.fechaEmision)} · ${c.anuladoPor ? 'Anulada con nota de crédito' : c.estado}`;
  const envios = c.envios || [];
  const items = c.items || [];
  $('#dlgCompCuerpo').innerHTML = `
    ${c.anuladoPor ? `<div class="aviso atencion">${ic('anular')}<span>Esta factura está <strong>anulada</strong> con una nota de crédito.</span></div>` : ''}
    <dl class="ficha">
      <dt>Cliente</dt><dd>${esc(c.razonSocialReceptor)}${c.cuitReceptor ? ` · <span class="dato">${fmtCuit(c.cuitReceptor)}</span>` : ''}</dd>
      <dt>Condición IVA</dt><dd>${esc(c.condicionIvaReceptor || '-')}</dd>
      ${c.periodo ? `<dt>Período</dt><dd>${esc(c.periodo.desde)} al ${esc(c.periodo.hasta)}</dd>` : ''}
      <dt>Total</dt><dd class="monto ${nc ? 'negativo' : ''}" style="font-size:22px">${nc ? '−' : ''}${fmtPesos(c.importeTotal)}</dd>
      <dt>CAE</dt><dd class="dato">${esc(c.cae || '-')}</dd>
      <dt>Vence CAE</dt><dd>${esc(c.caeVencimiento || '-')}</dd>
      <dt>Emisor</dt><dd>${esc(c.razonSocialEmisor || '')} <span class="dato">${fmtCuit(c.cuitEmisor)}</span></dd>
    </dl>
    ${items.length ? `<table class="tabla-items"><thead><tr><th>Detalle</th><th class="num">Cant.</th><th class="num">Subtotal</th></tr></thead><tbody>
      ${items.map(it => `<tr><td>${esc(it.descripcion)}</td><td class="num">${fmtNum(it.cantidad)}</td><td class="num">${fmtPesos(it.subtotal)}</td></tr>`).join('')}
    </tbody></table>` : ''}
    ${c.tienePdf ? `<form id="formEnviar" class="campos" novalidate>
      <div><label for="envEmail">Mandar por mail a</label><input id="envEmail" type="email" value="${esc(c.emailReceptor || '')}" placeholder="cliente@empresa.com"></div>
    </form>` : `<div class="aviso info">${ic('info')}<span>Se emitió por "Comprobantes en línea": el PDF original está en ARCA.</span></div>`}
    ${c.motivo && !c.anuladoPor && !nc ? `<p class="ayuda">${esc(c.motivo)}</p>` : ''}
    ${envios.length ? `<div><span class="etiqueta">Envíos</span><ul class="lista">${envios.map(v => `<li class="paso-prueba"><span class="${v.ok ? 'ok' : 'mal'}">${ic(v.ok ? 'check' : 'x')}</span><span>${new Date(v.fecha).toLocaleString('es-AR')} · ${esc(v.email)}${v.ok ? '' : ` · ${esc(v.mensaje || 'falló')}`}</span></li>`).join('')}</ul></div>` : ''}`;
  const opera = puedeOperar();
  $('#dlgCompPie').className = 'd-pie acciones-comp';
  $('#dlgCompPie').innerHTML = [
    opera && c.puedeAnular ? `<button class="boton texto peligro separar" id="btnAnularComp">${ic('anular')}Anular</button>` : '',
    opera && c.puedeRefacturar ? `<button class="boton" id="btnRefacturarComp">${ic('repetir')}Refacturar</button>` : '',
    c.tienePdf ? `<button class="boton" id="btnBajarPdf">${ic('descarga')}Descargar</button><button class="boton" id="btnPdfComp">${ic('pdf')}Ver PDF</button>` : '',
    c.tienePdf ? `<button class="boton principal" id="btnEnviarComp">${ic('mail')}Enviar</button>` : '<button class="boton" data-cerrar>Cerrar</button>',
  ].join('');
  $('#dlgComprobante').showModal();
  if (enfocarMail) $('#envEmail')?.focus();

  $('#btnPdfComp')?.addEventListener('click', (e) => verPdf(c.id, e.currentTarget));
  $('#btnBajarPdf')?.addEventListener('click', async (e) => {
    ocupado(e.currentTarget, true);
    const rp = await api(`/api/erp/comprobantes/${c.id}/pdf`, { blob: true });
    ocupado(e.currentTarget, false);
    if (!rp.ok) return aviso(rp.data?.message || 'No se pudo descargar el PDF.', 'error');
    const url = URL.createObjectURL(rp.blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${c.tipoComprobante} ${c.comprobanteFormato}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  $('#btnEnviarComp')?.addEventListener('click', async (e) => {
    const email = $('#envEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('#envEmail').setAttribute('aria-invalid', 'true'); return aviso('Ingresá un email válido.', 'error'); }
    ocupado(e.currentTarget, true);
    const re = await api(`/api/erp/comprobantes/${c.id}/enviar`, { method: 'POST', body: { email } });
    ocupado(e.currentTarget, false);
    aviso(re.data.message, re.ok ? 'ok' : 'error');
    if (re.ok) { $('#dlgComprobante').close(); cargarComprobantes(); }
  });
  $('#btnAnularComp')?.addEventListener('click', () => confirmarAccion('anular', c));
  $('#btnRefacturarComp')?.addEventListener('click', () => confirmarAccion('refacturar', c));
}

/* Anular (nota de crédito) o refacturar: siempre con una confirmación explícita antes de emitir */
let accionPendiente = null;
function confirmarAccion(accion, c) {
  const real = !/Prueba/.test(c.estado);
  const letra = String(c.tipoComprobante).trim().slice(-1);
  const email = $('#envEmail')?.value.trim() || c.emailReceptor || '';
  accionPendiente = { accion, id: c.id, email };
  if (accion === 'anular') {
    $('#dlgAccionTitulo').textContent = 'Anular con nota de crédito';
    $('#dlgAccionCuerpo').innerHTML = `
      <div class="aviso ${real ? 'atencion' : 'info'}">${ic(real ? 'alerta' : 'info')}<span>${real
        ? `Se va a emitir una <strong>Nota de Crédito ${esc(letra)} real</strong> en ARCA por el total de la factura. Una nota de crédito no se puede borrar.`
        : 'Se va a emitir una nota de crédito de prueba (sin validez fiscal).'}</span></div>
      <dl class="ficha">
        <dt>Anula</dt><dd>${esc(c.tipoComprobante)} <span class="dato">${esc(c.comprobanteFormato)}</span> del ${fmtFecha(c.fechaEmision)}</dd>
        <dt>Cliente</dt><dd>${esc(c.razonSocialReceptor)}</dd>
        <dt>Importe</dt><dd class="monto negativo" style="font-size:22px">−${fmtPesos(c.importeTotal)}</dd>
        <dt>Fecha</dt><dd>Hoy</dd>
      </dl>`;
    $('#btnAccionConfirmar').textContent = real ? 'Emitir nota de crédito' : 'Emitir de prueba';
    $('#btnAccionConfirmar').classList.add('peligro-fondo');
  } else {
    $('#dlgAccionTitulo').textContent = 'Refacturar';
    $('#dlgAccionCuerpo').innerHTML = `
      <div class="aviso ${real ? 'atencion' : 'info'}">${ic(real ? 'alerta' : 'info')}<span>${real
        ? `Se va a emitir una <strong>${esc(c.tipoComprobante)} real</strong> nueva, igual a esta, con fecha de hoy.`
        : 'Se va a emitir una copia de prueba (sin validez fiscal), con fecha de hoy.'}</span></div>
      <dl class="ficha">
        <dt>Cliente</dt><dd>${esc(c.razonSocialReceptor)}${c.cuitReceptor ? ` · <span class="dato">${fmtCuit(c.cuitReceptor)}</span>` : ''}</dd>
        <dt>Detalle</dt><dd>${(c.items || []).map(it => esc(it.descripcion)).join(', ') || '-'}</dd>
        <dt>Total</dt><dd class="monto" style="font-size:22px">${fmtPesos(c.importeTotal)}</dd>
        ${c.periodo ? '<dt>Período</dt><dd>El mes en curso</dd>' : ''}
        ${email ? `<dt>Se manda a</dt><dd>${esc(email)}</dd>` : ''}
      </dl>`;
    $('#btnAccionConfirmar').textContent = real ? 'Emitir factura' : 'Emitir de prueba';
    $('#btnAccionConfirmar').classList.remove('peligro-fondo');
  }
  $('#dlgAccion').showModal();
}
$('#btnAccionConfirmar').addEventListener('click', async (e) => {
  if (!accionPendiente) return;
  const { accion, id, email } = accionPendiente;
  accionPendiente = null;
  ocupado(e.currentTarget, true);
  const r = await api(`/api/erp/comprobantes/${id}/${accion}`, { method: 'POST', body: { confirmado: true, ...(email ? { email } : {}) } });
  ocupado(e.currentTarget, false);
  $('#dlgAccion').close();
  if (!r.ok) return aviso(r.data.message || 'ARCA no autorizó el comprobante.', 'error');
  $('#dlgComprobante').close();
  aviso(accion === 'anular' ? `Nota de crédito ${r.data.comprobanteNro || ''} emitida. La factura quedó anulada.` : `Factura ${r.data.comprobanteNro || ''} emitida.`, 'ok');
  estado.serie = null;
  $('#mesComp').value = mesActual();
  await cargarComprobantes();
  if (r.data.comprobanteId) abrirComprobante(r.data.comprobanteId);
});

/**
 * Abre un PDF en una pestaña nueva. La pestaña se abre EN EL MISMO CLIC (si se abre después de
 * esperar al servidor, el navegador la bloquea como ventana emergente) y después se le carga el
 * enlace temporal que arma el servidor.
 */
async function abrirPdfEnPestana(btn, pedirEnlace) {
  const ventana = window.open('', '_blank');
  if (ventana) {
    try { ventana.document.write('<!doctype html><meta charset="utf-8"><title>Generando PDF…</title><p style="font-family:sans-serif;padding:24px;color:#45464a">Generando el PDF…</p>'); } catch {}
  }
  ocupado(btn, true);
  const r = await pedirEnlace();
  ocupado(btn, false);
  if (!r.ok || !r.data.url) {
    ventana?.close();
    return aviso(r.data.message || 'No se pudo generar el PDF.', 'error');
  }
  if (ventana && !ventana.closed) ventana.location.href = r.data.url;
  else window.location.href = r.data.url; // el navegador bloqueó la pestaña: se abre en esta
}

function verPdf(id, btn) {
  return abrirPdfEnPestana(btn, () => api(`/api/erp/comprobantes/${id}/enlace`, { method: 'POST', body: {} }));
}

/* ======================================================================
   AJUSTES · EMPRESAS, CONEXIÓN Y DISEÑO
   ====================================================================== */
const MODOS = {
  auto: ['Automático', 'Usa el certificado propio de la empresa si está cargado; si no, el de la plataforma (la empresa tiene que haber delegado el servicio). Nunca usa el navegador.'],
  propio: ['Certificado propio', 'Todo a nombre de la empresa: el certificado es de su CUIT y no hace falta delegar nada.'],
  delegado: ['Delegado', 'Usa el certificado de la plataforma. La empresa delega "Facturación Electrónica" al CUIT de la plataforma en el Administrador de Relaciones de ARCA.'],
  navegador: ['Navegador', 'Flujo anterior: entra a "Comprobantes en línea" con la Clave Fiscal y completa las pantallas. Es lento y se traba si ARCA cambia algo.'],
};

function renderEmpresas() {
  const caja = $('#listaEmpresas');
  if (!caja) return;
  caja.innerHTML = estado.cuentas.length ? estado.cuentas.map(c => {
    const ws = c.ws || {};
    const prueba = ws.ultimaPrueba;
    const listo = prueba?.ok;
    const compartido = esAdmin() && Array.isArray(c.usuarios) ? c.usuarios.length : null;
    return `<div class="cuenta">
      <div class="titulo"><div style="min-width:0"><h3>${esc(c.razonSocial || c.cuit)}</h3><span class="tenue dato">${fmtCuit(c.cuit)}</span>${c.cuitRepresentante ? ` <span class="tenue">· representado por ${esc(c.nombreRepresentante || fmtCuit(c.cuitRepresentante))}</span>` : ''}</div>
        ${c.cuit === estado.cuitActivo ? '<span class="etiqueta-estado e-ok">Factura ahora</span>' : `<button class="boton chico" data-usar="${c.cuit}">Usar para facturar</button>`}</div>
      <p style="font-size:14px;margin:0">
        <span class="etiqueta-estado ${listo ? 'e-ok' : prueba ? 'e-error' : 'e-prueba'}">${listo ? 'Conectado con ARCA' : prueba ? 'Revisar conexión' : 'Falta conectar con ARCA'}</span>
        <span class="tenue"> ${esc(MODOS[ws.modo || 'auto'][0])}${ws.tieneCertificadoPropio ? ' · certificado propio' : ''}${ws.puntoVentaWs ? ` · punto de venta ${ws.puntoVentaWs}` : ''} · diseño ${c.disenoModo === 'personalizado' ? 'personalizado' : 'genérico'}${compartido !== null ? ` · ${compartido} usuario(s)` : ''}</span></p>
      <div class="fila-acciones">
        <button class="boton chico" data-conexion="${c.cuit}">${ic('enchufe')}Conexión ARCA</button>
        ${listo ? '' : `<button class="boton chico" data-guia="${c.cuit}">${ic('info')}Guía paso a paso</button>`}
        <button class="boton chico" data-diseno="${c.cuit}">${ic('factura')}Diseño de factura</button>
        <button class="boton chico texto" data-editar-emp="${c.cuit}">Editar</button>
        <button class="boton chico texto peligro" data-borrar-emp="${c.cuit}">${esAdmin() ? 'Eliminar' : 'Quitar'}</button>
      </div></div>`;
  }).join('') : `<div class="vacio"><h3>Agregá tu primer CUIT</h3><p>El tuyo, el de una empresa que representás o el de un cliente que te autorizó. Después lo conectás con ARCA siguiendo la guía.</p>
      <div class="fila-acciones" style="justify-content:center;margin-top:14px"><button class="boton principal" data-agregar-emp>Agregar CUIT</button><button class="boton" data-guia="">Ver la guía</button></div></div>`;
}

$('#listaEmpresas').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.usar) { $('#selEmisor').value = b.dataset.usar; $('#selEmisor').dispatchEvent(new Event('change')); setTimeout(renderEmpresas, 300); }
  if (b.dataset.conexion) abrirConexion(b.dataset.conexion);
  if (b.dataset.guia !== undefined) abrirGuia(b.dataset.guia);
  if (b.dataset.diseno) abrirDiseno(b.dataset.diseno);
  if (b.dataset.editarEmp) abrirEmpresa(b.dataset.editarEmp);
  if (b.dataset.agregarEmp !== undefined) abrirEmpresa();
  if (b.dataset.borrarEmp) {
    const pregunta = esAdmin()
      ? '¿Eliminar este CUIT del sistema para todos los usuarios? Los comprobantes ya emitidos no se borran.'
      : '¿Quitar este CUIT de tu cuenta? Si nadie más lo usa, se elimina. Los comprobantes ya emitidos no se borran.';
    if (!confirm(pregunta)) return;
    const r = await api(`/api/accounts/${b.dataset.borrarEmp}`, { method: 'DELETE' });
    aviso(r.data.message, r.ok ? 'ok' : 'error');
    if (r.ok) cargarCuentas();
  }
});

$('#btnNuevaEmpresa').addEventListener('click', () => abrirEmpresa());
$('#btnGuia').addEventListener('click', () => abrirGuia(estado.cuitActivo));
let empCuitOriginal = '';
function abrirEmpresa(cuit) {
  const c = estado.cuentas.find(x => x.cuit === cuit);
  $('#dlgEmpresaTitulo').textContent = c ? 'Editar CUIT' : 'Agregar CUIT';
  $('#empCuit').value = c?.cuit || ''; $('#empCuit').readOnly = false;
  empCuitOriginal = c?.cuit || '';
  $('#empCuitAyuda').textContent = c
    ? 'Si lo cambiás, después hay que volver a conectarlo con ARCA. Un CUIT que ya emitió comprobantes no se puede cambiar.'
    : 'El de la persona o empresa que emite las facturas.';
  $('#empRazon').value = c?.razonSocial || '';
  $('#empEmail').value = c?.emailNotificaciones || '';
  $('#empPv').value = c?.puntoVentaDefault || 1;
  $('#empCuitRep').value = c?.cuitRepresentante || '';
  $('#empNombreRep').value = c?.nombreRepresentante || '';
  $('#empClave').value = '';
  $$('#formEmpresa [aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  $('#dlgEmpresa').showModal();
}
$('#formEmpresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cuit = $('#empCuit').value.replace(/\D/g, '');
  const rep = $('#empCuitRep').value.replace(/\D/g, '');
  const marcar = (id, mal) => $('#' + id).setAttribute('aria-invalid', String(!!mal));
  marcar('empCuit', !cuitOk(cuit)); marcar('empRazon', !$('#empRazon').value.trim()); marcar('empCuitRep', rep && !cuitOk(rep));
  if (!cuitOk(cuit)) return aviso(cuit.length !== 11 ? 'El CUIT tiene que tener 11 números.' : 'Ese CUIT no es válido: revisá los números.', 'error');
  if (!$('#empRazon').value.trim()) return aviso('Falta la razón social.', 'error');
  if (rep && !cuitOk(rep)) return aviso('El CUIT de quien representa no es válido.', 'error');
  const cambia = empCuitOriginal && empCuitOriginal !== cuit;
  if (cambia && !confirm(`¿Cambiar el CUIT ${fmtCuit(empCuitOriginal)} por ${fmtCuit(cuit)}? Después vas a tener que volver a conectarlo con ARCA.`)) return;
  const nuevo = !estado.cuentas.some(c => c.cuit === cuit) && !cambia;
  const r = await api('/api/accounts', { method: 'POST', body: { cuit, cuitAnterior: empCuitOriginal || undefined, razonSocial: $('#empRazon').value.trim(), emailNotificaciones: $('#empEmail').value.trim(), puntoVentaDefault: Number($('#empPv').value) || 1, cuitRepresentante: rep, nombreRepresentante: $('#empNombreRep').value.trim(), claveFiscal: $('#empClave').value || undefined } });
  aviso(r.data.message, r.ok ? 'ok' : 'error');
  if (!r.ok) return;
  $('#dlgEmpresa').close();
  await cargarCuentas();
  // Recién cargado (o con CUIT nuevo): el siguiente paso natural es conectarlo con ARCA
  if (nuevo || r.data.renombrado) abrirGuia(cuit);
});

/* ---------------- Guía de ARCA ---------------- */
let guiaCuit = '';
const claveGuia = () => `botarca_guia_${guiaCuit || 'general'}`;
function leerGuia() { try { return JSON.parse(localStorage.getItem(claveGuia()) || '{}'); } catch { return {}; } }
function guardarGuia(v) { try { localStorage.setItem(claveGuia(), JSON.stringify(v)); } catch {} }

async function abrirGuia(cuit) {
  guiaCuit = cuit || '';
  const c = estado.cuentas.find(x => x.cuit === guiaCuit);
  $('#guiaCuit').textContent = c
    ? `Para ${c.razonSocial} · ${fmtCuit(c.cuit)}. Se hace una sola vez. Tildá cada paso cuando lo termines: queda guardado.`
    : 'Se hace una sola vez por CUIT. Tildá cada paso cuando lo termines: queda guardado.';
  if (!estado.plataforma) await cargarPlataforma();
  const p = estado.plataforma?.plataforma;
  $('#guiaCuitPlataforma').textContent = p?.configurado ? fmtCuit(p.cuit) : '(todavía no configurado: usá el certificado propio)';
  const guardado = leerGuia();
  $$('#dlgGuia [data-paso]').forEach(ch => { ch.checked = !!guardado[ch.dataset.paso]; });
  if (c) $('#dlgGuia [data-paso="cuit-cargado"]').checked = true;
  guiaCamino(guardado.camino || (c?.ws?.modo === 'delegado' ? 'delegado' : 'propio'));
  $('#btnGuiaConexion').classList.toggle('oculto', !c);
  $('#dlgGuia').showModal();
}

function guiaCamino(camino) {
  $$('[data-guia-camino]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.guiaCamino === camino)));
  $$('#dlgGuia [data-camino]').forEach(el => el.classList.toggle('oculto', el.dataset.camino !== camino));
  $('#guiaCaminoAyuda').textContent = camino === 'propio'
    ? 'Recomendado si el CUIT es tuyo o de tu empresa: todo queda a su nombre y no dependés de nadie.'
    : 'Más rápido: no manejás certificados. El CUIT le da permiso a la plataforma para facturar en su nombre.';
  const g = leerGuia(); g.camino = camino; guardarGuia(g);
  guiaProgreso();
}

function guiaProgreso() {
  const visibles = $$('#dlgGuia [data-paso]').filter(ch => !ch.closest('.oculto'));
  const hechos = visibles.filter(ch => ch.checked).length;
  $('#guiaBarra').style.width = `${Math.round((hechos / visibles.length) * 100)}%`;
  $('#guiaAvance').textContent = hechos === visibles.length ? 'Listo: todos los pasos hechos.' : `${hechos} de ${visibles.length} pasos hechos`;
}

$$('[data-guia-camino]').forEach(b => b.addEventListener('click', () => guiaCamino(b.dataset.guiaCamino)));
$('#dlgGuia').addEventListener('change', (e) => {
  const ch = e.target.closest('[data-paso]');
  if (!ch) return;
  const g = leerGuia(); g[ch.dataset.paso] = ch.checked; guardarGuia(g);
  guiaProgreso();
});
$('#btnGuiaConexion').addEventListener('click', () => { $('#dlgGuia').close(); abrirConexion(guiaCuit); });

let conCuit = '';
async function abrirConexion(cuit) {
  conCuit = cuit;
  const c = estado.cuentas.find(x => x.cuit === cuit);
  const ws = c?.ws || {};
  $('#conEmpresa').textContent = `${c?.razonSocial || ''} · ${fmtCuit(cuit)}`;
  $('#conModo').value = ws.modo || 'auto';
  $('#conModoAyuda').textContent = MODOS[$('#conModo').value][1];
  $('#conPv').value = ws.puntoVentaWs || '';
  $('#conCondIva').value = ws.condicionIvaEmisor || '';
  $('#conDomicilio').value = ws.domicilioComercial || '';
  $('#conIibb').value = ws.iibb || '';
  $('#conInicio').value = ws.inicioActividades || '';
  $('#conCert').value = ''; $('#conKey').value = '';
  $('#conCsrCaja').classList.add('oculto');
  $('#conPrueba').innerHTML = ws.ultimaPrueba ? `<p class="tenue" style="font-size:14px">Última prueba: ${new Date(ws.ultimaPrueba.fecha).toLocaleString('es-AR')} — ${esc(ws.ultimaPrueba.mensaje)}</p>` : '';
  pintarCert(ws.tieneCertificadoPropio);
  await cargarPlataforma();
  const p = estado.plataforma?.plataforma;
  $('#conDelegacion').innerHTML = p?.configurado
    ? `Para usar el modo delegado, la empresa entra a ARCA con su Clave Fiscal → <em>Administrador de Relaciones</em> → <em>Nueva Relación</em> → WebServices → <em>Facturación Electrónica</em>, y pone como representante el CUIT <strong class="dato">${fmtCuit(p.cuit)}</strong>.${p.vencido ? ' <strong style="color:var(--error)">El certificado de la plataforma está vencido.</strong>' : ''}`
    : 'El certificado de la plataforma todavía no está configurado (variables WSFE_PLATFORM_CERT y WSFE_PLATFORM_KEY en Render). Mientras tanto, usá el certificado propio.';
  $('#dlgConexion').showModal();
}
function pintarCert(tiene) {
  const el = $('#conCertEstado');
  el.className = `etiqueta-estado ${tiene ? 'e-ok' : 'e-espera'}`;
  el.textContent = tiene ? 'Cargado' : 'No cargado';
  $('#btnQuitarCert').classList.toggle('oculto', !tiene);
}
$('#btnGuiaDesdeConexion').addEventListener('click', () => { $('#dlgConexion').close(); abrirGuia(conCuit); });
$('#conModo').addEventListener('change', () => { $('#conModoAyuda').textContent = MODOS[$('#conModo').value][1]; });

async function refrescarCuentaConexion() {
  await cargarCuentas();
  pintarCert(estado.cuentas.find(x => x.cuit === conCuit)?.ws?.tieneCertificadoPropio);
}

$('#btnGuardarConexion').addEventListener('click', async (e) => {
  ocupado(e.currentTarget, true);
  const r = await api(`/api/accounts/${conCuit}/ws`, { method: 'PUT', body: { modo: $('#conModo').value, puntoVentaWs: $('#conPv').value, condicionIvaEmisor: $('#conCondIva').value, domicilioComercial: $('#conDomicilio').value, iibb: $('#conIibb').value, inicioActividades: $('#conInicio').value } });
  ocupado(e.currentTarget, false);
  aviso(r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) refrescarCuentaConexion();
});
$('#btnCsr').addEventListener('click', async (e) => {
  ocupado(e.currentTarget, true);
  const r = await api(`/api/accounts/${conCuit}/ws/csr`, { method: 'POST', body: {} });
  ocupado(e.currentTarget, false);
  if (!r.ok) return aviso(r.data.message, 'error');
  $('#conCsr').value = r.data.csrPem;
  $('#conCsrCaja').classList.remove('oculto');
  aviso('Pedido generado. Subilo a ARCA.');
});
$('#btnCopiarCsr').addEventListener('click', () => navigator.clipboard?.writeText($('#conCsr').value).then(() => aviso('Copiado.')).catch(() => aviso('Seleccioná el texto y copialo a mano.', 'error')));
$('#btnBajarCsr').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('#conCsr').value], { type: 'application/pkcs10' }));
  a.download = `pedido_${conCuit}.csr`; a.click();
});
$('#btnCargarCert').addEventListener('click', async (e) => {
  const certPem = $('#conCert').value.trim();
  if (!certPem) return aviso('Pegá el certificado que te dio ARCA.', 'error');
  ocupado(e.currentTarget, true);
  const r = await api(`/api/accounts/${conCuit}/ws/certificado`, { method: 'POST', body: { certPem, keyPem: $('#conKey').value.trim() || undefined } });
  ocupado(e.currentTarget, false);
  aviso(r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) { $('#conCert').value = ''; $('#conKey').value = ''; $('#conCsrCaja').classList.add('oculto'); refrescarCuentaConexion(); }
});
$('#btnQuitarCert').addEventListener('click', async () => {
  if (!confirm('¿Quitar el certificado propio de esta empresa?')) return;
  const r = await api(`/api/accounts/${conCuit}/ws/certificado`, { method: 'DELETE' });
  aviso(r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) refrescarCuentaConexion();
});
$('#btnProbarConexion').addEventListener('click', async (e) => {
  ocupado(e.currentTarget, true);
  $('#conPrueba').innerHTML = '<p class="tenue">Consultando a ARCA…</p>';
  const r = await api(`/api/accounts/${conCuit}/ws/probar`, { method: 'POST', body: {} });
  ocupado(e.currentTarget, false);
  if (!r.ok) { $('#conPrueba').innerHTML = `<div class="aviso error">${ic('alerta')}<span>${esc(r.data.message)}</span></div>`; return; }
  $('#conPrueba').innerHTML = r.data.pasos.map(p => `<div class="paso-prueba"><span class="${p.ok ? 'ok' : 'mal'}">${ic(p.ok ? 'check' : 'x')}</span><span><strong>${esc(p.paso)}.</strong> ${esc(p.detalle)}</span></div>`).join('') +
    `<div class="aviso ${r.data.ok ? 'ok' : 'atencion'}" style="margin-top:8px">${ic(r.data.ok ? 'check' : 'alerta')}<span>${r.data.ok ? 'Lista para facturar por web service.' : 'Todavía no puede facturar por web service.'}</span></div>`;
  refrescarCuentaConexion();
});

/* Diseño */
let disCuit = '';
let disLogo = '';
let disModo = 'generico';
async function abrirDiseno(cuit) {
  disCuit = cuit;
  const c = estado.cuentas.find(x => x.cuit === cuit);
  $('#disEmpresa').textContent = `${c?.razonSocial || ''} · ${fmtCuit(cuit)}`;
  const r = await api(`/api/accounts/${cuit}/diseno`);
  if (!r.ok) return aviso(r.data.message, 'error');
  const d = r.data.diseno;
  disLogo = d.logoDataUrl || '';
  $('#disLogoPos').value = d.logoPosicion; $('#disEsquema').value = d.esquema;
  $('#disColor1').value = d.colorPrincipal; $('#disColor2').value = d.colorAcento;
  $('#disFuente').value = d.tipografia; $('#disFantasia').value = d.nombreFantasia || '';
  $('#disTel').value = d.telefono || ''; $('#disWeb').value = d.web || ''; $('#disEmailContacto').value = d.emailContacto || '';
  $('#disNotas').value = d.notas || ''; $('#disPie').value = d.leyendaPie || '';
  $('#disAsunto').value = d.mail?.asunto || ''; $('#disAsunto').placeholder = r.data.asuntoDefault;
  $('#disCuerpo').value = d.mail?.cuerpo || ''; $('#disCuerpo').placeholder = r.data.cuerpoDefault;
  $('#disResponder').value = d.mail?.responderA || '';
  $('#disLogo').value = '';
  pintarLogo();
  modoDiseno(d.modo);
  $('#dlgDiseno').showModal();
}
function modoDiseno(m) {
  disModo = m;
  $$('[data-dis-modo]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.disModo === m)));
  $('#disCampos').classList.toggle('oculto', m !== 'personalizado');
  $('#disAyuda').textContent = m === 'personalizado'
    ? 'Logo, colores, tipografía y textos propios para esta empresa.'
    : 'El diseño estándar de BotArca: sobrio, con todo lo que exige ARCA. Sirve para cualquier cliente.';
}
$$('[data-dis-modo]').forEach(b => b.addEventListener('click', () => modoDiseno(b.dataset.disModo)));
function pintarLogo() {
  $('#disLogoPrevia').innerHTML = disLogo ? '<img class="logo-previa" alt="Logo cargado">' : '';
  if (disLogo) $('#disLogoPrevia img').src = disLogo;
  $('#btnQuitarLogo').classList.toggle('oculto', !disLogo);
}
$('#disLogo').addEventListener('change', () => {
  const f = $('#disLogo').files[0];
  if (!f) return;
  if (!/image\/(png|jpeg)/.test(f.type)) return aviso('El logo tiene que ser PNG o JPG.', 'error');
  if (f.size > 400 * 1024) return aviso('El logo pesa más de 400 KB.', 'error');
  const lector = new FileReader();
  lector.onload = () => { disLogo = lector.result; pintarLogo(); };
  lector.readAsDataURL(f);
});
$('#btnQuitarLogo').addEventListener('click', () => { disLogo = ''; $('#disLogo').value = ''; pintarLogo(); });
function leerDiseno() {
  return {
    modo: disModo, esquema: $('#disEsquema').value, colorPrincipal: $('#disColor1').value, colorAcento: $('#disColor2').value,
    tipografia: $('#disFuente').value, logoDataUrl: disLogo || undefined, logoPosicion: $('#disLogoPos').value,
    nombreFantasia: $('#disFantasia').value, telefono: $('#disTel').value, web: $('#disWeb').value, emailContacto: $('#disEmailContacto').value,
    notas: $('#disNotas').value, leyendaPie: $('#disPie').value,
    mail: { asunto: $('#disAsunto').value, cuerpo: $('#disCuerpo').value, responderA: $('#disResponder').value },
  };
}
$('#btnVistaPrevia').addEventListener('click', (e) => {
  abrirPdfEnPestana(e.currentTarget, () => api(`/api/accounts/${disCuit}/diseno/vista-previa`, { method: 'POST', body: { diseno: leerDiseno() } }));
});
$('#btnGuardarDiseno').addEventListener('click', async (e) => {
  ocupado(e.currentTarget, true);
  const r = await api(`/api/accounts/${disCuit}/diseno`, { method: 'PUT', body: { diseno: leerDiseno() } });
  ocupado(e.currentTarget, false);
  aviso(r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) { $('#dlgDiseno').close(); cargarCuentas(); }
});

/* ======================================================================
   AJUSTES · CLIENTES
   ====================================================================== */
async function cargarClientes() {
  const r = await api('/api/erp/clientes');
  estado.clientes = r.ok ? r.data.clientes || [] : [];
  $('#facCliente').innerHTML = '<option value="">Cargar a mano</option>' + estado.clientes
    .slice().sort((a, b) => String(a.razonSocial).localeCompare(String(b.razonSocial)))
    .map(c => `<option value="${c.id}">${esc(c.razonSocial)}${c.cuit ? ' · ' + fmtCuit(c.cuit) : ''}</option>`).join('');
  renderClientes();
}
function renderClientes() {
  $('#listaClientes').innerHTML = estado.clientes.length ? estado.clientes.map(c => `<li><button class="fila" data-cli="${c.id}">
    <div style="min-width:0"><div class="principal-txt">${esc(c.razonSocial)}</div><div class="secundario">${c.cuit ? `<span class="dato">${fmtCuit(c.cuit)}</span> · ` : ''}${esc(c.condicionIva)}${c.email ? ' · ' + esc(c.email) : ''}</div></div>
    <span class="tenue">${ic('lapiz')}</span></button></li>`).join('')
    : '<li class="vacio"><p>Los clientes a los que les facturás se guardan acá automáticamente.</p></li>';
}
let cliId = '';
function abrirCliente(id) {
  const c = estado.clientes.find(x => x.id === id);
  cliId = id || '';
  $('#dlgClienteTitulo').textContent = c ? 'Editar cliente' : 'Agregar cliente';
  $('#cliTipoDoc').value = c?.tipoDoc || 'CUIT'; $('#cliDoc').value = c?.cuit || ''; $('#cliNombre').value = c?.razonSocial || '';
  $('#cliCondIva').value = c?.condicionIva || 'Consumidor Final'; $('#cliEmail').value = c?.email || ''; $('#cliDomicilio').value = c?.domicilio || '';
  $('#formCliente').querySelector('.d-pie').querySelector('[data-borrar-cli]')?.remove();
  if (c) $('#formCliente .d-pie').insertAdjacentHTML('afterbegin', `<button type="button" class="boton texto peligro" data-borrar-cli="${c.id}" style="margin-right:auto">Eliminar</button>`);
  $('#dlgCliente').showModal();
}
$('#btnNuevoCliente').addEventListener('click', () => abrirCliente());
$('#listaClientes').addEventListener('click', (e) => { const b = e.target.closest('[data-cli]'); if (b) abrirCliente(b.dataset.cli); });
$('#formCliente').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-borrar-cli]');
  if (!b || !confirm('¿Eliminar este cliente? Sus comprobantes no se borran.')) return;
  const r = await api(`/api/erp/clientes/${b.dataset.borrarCli}`, { method: 'DELETE' });
  if (r.ok) { $('#dlgCliente').close(); cargarClientes(); aviso('Cliente eliminado.'); }
});
$('#formCliente').addEventListener('submit', async (e) => {
  e.preventDefault();
  const doc = $('#cliDoc').value.replace(/\D/g, '');
  if (!$('#cliNombre').value.trim()) return aviso('Falta el nombre.', 'error');
  if (!doc) return aviso('Falta el número de documento (los clientes se identifican por CUIT o DNI).', 'error');
  const r = await api('/api/erp/clientes', { method: 'POST', body: { id: cliId || undefined, cuit: doc, tipoDoc: $('#cliTipoDoc').value, razonSocial: $('#cliNombre').value.trim(), condicionIva: $('#cliCondIva').value, email: $('#cliEmail').value.trim(), domicilio: $('#cliDomicilio').value.trim() } });
  aviso(r.ok ? 'Cliente guardado.' : r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) { $('#dlgCliente').close(); cargarClientes(); }
});

/* ======================================================================
   AJUSTES · USUARIOS (admin)
   ====================================================================== */
let usuarios = [];
const ROL = { admin: 'Administrador', operator: 'Operador', viewer: 'Solo lectura' };
const CAMPOS_LIMITE = { cuits: '#limCuits', comprobantesMes: '#limComprobantesMes', clientes: '#limClientes', colaPendientes: '#limColaPendientes' };
let limitesPorDefecto = {};
async function cargarUsuarios() {
  const r = await api('/api/users');
  usuarios = r.ok ? r.data.users || [] : [];
  limitesPorDefecto = r.ok ? r.data.limitesPorDefecto || {} : {};
  const nombreCuit = (c) => (estado.cuentas.find(a => a.cuit === c)?.razonSocial || fmtCuit(c));
  $('#listaUsuarios').innerHTML = usuarios.length ? usuarios.map(u => `<li><button class="fila" data-usr="${u.id}">
    <div style="min-width:0"><div class="principal-txt">${esc(u.name)} <span class="tenue">@${esc(u.username)}</span></div>
      <div class="secundario">${esc(u.email)} · ${u.lastLoginAt ? 'último ingreso ' + new Date(u.lastLoginAt).toLocaleDateString('es-AR') : 'nunca ingresó'}</div>
      <div class="secundario">${u.role === 'admin' ? 'Ve todos los CUITs' : (u.cuits || []).length ? 'CUITs: ' + (u.cuits || []).map(c => esc(nombreCuit(c))).join(', ') : 'Sin CUITs todavía'}</div></div>
    <span class="etiqueta-estado ${!u.active ? 'e-error' : u.role === 'viewer' ? 'e-espera' : 'e-ok'}">${u.active ? ROL[u.role] : 'Desactivado'}</span></button></li>`).join('')
    : '<li class="vacio"><p>Todavía no hay otros usuarios.</p></li>';
}
let usrId = '';
function abrirUsuario(id) {
  const u = usuarios.find(x => x.id === id);
  usrId = id || '';
  $('#dlgUsuarioTitulo').textContent = u ? 'Editar usuario' : 'Agregar usuario';
  $('#usrNombre').value = u?.name || ''; $('#usrUsuario').value = u?.username || ''; $('#usrUsuario').readOnly = !!u;
  $('#usrEmail').value = u?.email || ''; $('#usrRol').value = u?.role || 'operator'; $('#usrActivo').value = u && !u.active ? '0' : '1';
  $('#usrClave').value = '';
  $('#usrClaveCampo').classList.toggle('oculto', !!u);
  $('#usrActivoCampo').classList.toggle('oculto', !u);
  $('#btnBorrarUsuario').classList.toggle('oculto', !u || u.id === estado.usuario.id);
  $('#btnResetClave').classList.toggle('oculto', !u);
  // CUITs que puede usar (el admin los ve todos, por eso no se le asignan)
  const suyos = new Set(u?.cuits || []);
  $('#usrCuits').innerHTML = estado.cuentas.length
    ? estado.cuentas.map(c => `<label><input type="checkbox" value="${c.cuit}" ${suyos.has(c.cuit) ? 'checked' : ''}> ${esc(c.razonSocial)} <span class="tenue dato">${fmtCuit(c.cuit)}</span></label>`).join('')
    : '<p class="ayuda" style="margin:0">Todavía no hay CUITs cargados.</p>';
  $('#usrCuitsCampo').classList.toggle('oculto', $('#usrRol').value === 'admin');
  // Límites: vacío = valor por defecto
  const def = limitesPorDefecto || {};
  const propios = u?.limitesPropios ? u.limites || {} : {};
  for (const [k, id] of Object.entries(CAMPOS_LIMITE)) {
    $(id).placeholder = def[k] ? `${fmtNum(def[k])} (por defecto)` : '';
    $(id).value = propios[k] && propios[k] !== def[k] ? propios[k] : '';
  }
  $('#usrLimitesCampo').classList.toggle('oculto', $('#usrRol').value === 'admin');
  $('#dlgUsuario').showModal();
}
$('#usrRol').addEventListener('change', () => {
  $('#usrCuitsCampo').classList.toggle('oculto', $('#usrRol').value === 'admin');
  $('#usrLimitesCampo').classList.toggle('oculto', $('#usrRol').value === 'admin');
});
$('#btnNuevoUsuario').addEventListener('click', () => abrirUsuario());
$('#listaUsuarios').addEventListener('click', (e) => { const b = e.target.closest('[data-usr]'); if (b) abrirUsuario(b.dataset.usr); });
$('#formUsuario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('#usrNombre').value.trim(), email: $('#usrEmail').value.trim(), role: $('#usrRol').value };
  if (body.name.length < 2) return aviso('Falta el nombre.', 'error');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return aviso('El email no es válido.', 'error');
  if (!usrId) {
    const clave = $('#usrClave').value;
    if (clave.length < 8 || !/[A-Za-z]/.test(clave) || !/\d/.test(clave)) return aviso('La contraseña inicial necesita 8 caracteres o más, con letras y números.', 'error');
  }
  const btn = e.submitter;
  ocupado(btn, true);
  const r = usrId
    ? await api(`/api/users/${usrId}`, { method: 'PUT', body: { ...body, active: $('#usrActivo').value === '1' } })
    : await api('/api/users', { method: 'POST', body: { ...body, username: $('#usrUsuario').value.trim(), password: $('#usrClave').value } });
  if (r.ok && body.role !== 'admin') {
    const id = usrId || r.data.user?.id;
    const cuits = $$('#usrCuits input:checked').map(i => i.value);
    if (id) await api(`/api/users/${id}/cuits`, { method: 'PUT', body: { cuits } });
    if (id) {
      const limites = {};
      for (const [k, campo] of Object.entries(CAMPOS_LIMITE)) limites[k] = $(campo).value.trim();
      const rl = await api(`/api/users/${id}/limites`, { method: 'PUT', body: limites });
      if (!rl.ok) { ocupado(btn, false); return aviso(rl.data.message, 'error'); }
    }
  }
  ocupado(btn, false);
  aviso(r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) { $('#dlgUsuario').close(); await cargarCuentas(); cargarUsuarios(); }
});
$('#btnResetClave').addEventListener('click', async () => {
  const clave = prompt('Contraseña nueva para este usuario (mínimo 8 caracteres, con letras y números). Se le cierran las sesiones y le llega un aviso por mail.');
  if (!clave) return;
  const r = await api(`/api/users/${usrId}/reset-password`, { method: 'PUT', body: { newPassword: clave } });
  aviso(r.data.message, r.ok ? 'ok' : 'error');
});
$('#btnBorrarUsuario').addEventListener('click', async () => {
  if (!confirm('¿Eliminar este usuario? No se puede deshacer.')) return;
  const r = await api(`/api/users/${usrId}`, { method: 'DELETE' });
  aviso(r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) { $('#dlgUsuario').close(); cargarUsuarios(); }
});

/* ======================================================================
   AJUSTES · CORREO, MI CUENTA, SISTEMA
   ====================================================================== */
async function cargarCorreo() {
  const r = await api('/api/settings/mail');
  if (!r.ok) return;
  const m = r.data.mail;
  $('#mailProveedor').value = m.provider || 'auto';
  $('#mailRemitente').value = m.senderEmail || ''; $('#mailNombre').value = m.senderName || ''; $('#mailAdmin').value = m.adminNotifyEmail || '';
  const servicios = [
    ['Resend', 'manda los mails', m.hasResendKey],
    ['Brevo', 'alternativa para mails (opcional)', m.hasBrevoKey],
    ['Groq', 'lee listas y mensajes con IA', m.hasGroqKey],
  ];
  $('#estadoServicios').innerHTML = servicios.map(([n, para, ok]) => `<li><span class="etiqueta-estado ${ok ? 'e-ok' : 'e-espera'}">${ok ? 'Conectado' : 'Sin configurar'}</span> <strong>${n}</strong> <span class="tenue">· ${para}</span></li>`).join('');
}
$('#aj-correo').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('/api/settings/mail', { method: 'POST', body: { provider: $('#mailProveedor').value, senderEmail: $('#mailRemitente').value, senderName: $('#mailNombre').value, adminNotifyEmail: $('#mailAdmin').value } });
  aviso(r.ok ? 'Configuración guardada.' : r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) cargarCorreo();
});
$('#btnProbarMail').addEventListener('click', async (e) => {
  ocupado(e.currentTarget, true);
  const r = await api('/api/settings/mail/test', { method: 'POST', body: { testEmail: $('#mailPrueba').value.trim() || undefined } });
  ocupado(e.currentTarget, false);
  aviso(r.data.message, r.ok ? 'ok' : 'error');
});

$('#aj-cuenta').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#clvNueva').value !== $('#clvNueva2').value) return aviso('Las contraseñas nuevas no coinciden.', 'error');
  const r = await api('/api/users/me/password', { method: 'PUT', body: { currentPassword: $('#clvActual').value, newPassword: $('#clvNueva').value } });
  aviso(r.data.message, r.ok ? 'ok' : 'error');
  if (r.ok) { aviso('Ingresá de nuevo con la contraseña nueva.'); setTimeout(() => cerrarSesion(false), 1200); }
});
$('#btnSalir').addEventListener('click', () => cerrarSesion());
$('#btnSalirBarra').addEventListener('click', () => cerrarSesion());

function conectarLogs() {
  if (estado.sse) return;
  const term = $('#terminal');
  const p = estado.plataforma;
  $('#sisResumen').textContent = p ? `Ambiente: ${p.ambiente === 'produccion' ? 'producción (facturas reales)' : 'homologación (pruebas)'}. Certificado de la plataforma: ${p.plataforma?.configurado ? `CUIT ${fmtCuit(p.plataforma.cuit)}, vence ${String(p.plataforma.vence || '').slice(0, 10)}` : 'no configurado'}.` : '';
  api('/api/logs?limit=80').then(r => { if (r.status === 200) (r.data.logs || []).forEach(agregarLog); });
  estado.sse = new EventSource(`/api/logs/stream?token=${encodeURIComponent(estado.token)}`);
  estado.sse.onmessage = (ev) => { try { agregarLog(JSON.parse(ev.data)); } catch {} };
  function agregarLog(l) {
    const linea = document.createElement('div');
    linea.className = { error: 't-error', success: 't-ok', warn: 't-warn' }[l.level] || '';
    linea.textContent = `${l.timestamp || ''} ${l.category ? `[${l.category}] ` : ''}${l.message || ''}`;
    term.appendChild(linea);
    while (term.childElementCount > 400) term.firstChild.remove();
    term.scrollTop = term.scrollHeight;
  }
}
$('#btnLimpiarLog').addEventListener('click', () => { $('#terminal').innerHTML = ''; });

/* ======================================================================
   INICIO
   ====================================================================== */
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#restablecer=')) { $('#vistaApp').classList.add('oculto'); $('#vistaIngreso').classList.remove('oculto'); mostrarFormIngreso('restablecer'); return; }
  if (estado.usuario) ir(location.hash.replace('#', ''));
});

(function arrancar() {
  if (location.hash.startsWith('#restablecer=')) {
    $('#vistaIngreso').classList.remove('oculto');
    mostrarFormIngreso('restablecer');
    return;
  }
  if (estado.token) iniciarApp();
  else { $('#vistaIngreso').classList.remove('oculto'); mostrarFormIngreso('ingreso'); }
})();
