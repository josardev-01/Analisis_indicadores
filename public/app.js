// Bitácora — lógica del dashboard. Lee la API local y pinta cada sección.
// Las reglas de cálculo del lado del cliente (balance, winrate agregado,
// distribución, top del mes, totales del calendario) siguen las observadas en
// el dashboard original; ver README.

import { clasePnl, esc, fmt, fmtCompacto, fmtConSigno, fmtMoneda, fmtPorcentaje, hoyLocal, partesFecha } from './formato.js';
import { dibujarDona, dibujarLinea } from './graficos.js';
import { TEXTOS } from './i18n.js';

const $ = (selector) => document.querySelector(selector);
const MAX_SECTORES = 8;
const MAX_EVENTOS = 6;

// ---------- Preferencias (por navegador) ----------

function leerPreferencia(clave, porDefecto) {
  try {
    return localStorage.getItem(clave) ?? porDefecto;
  } catch {
    return porDefecto;
  }
}

function guardarPreferencia(clave, valor) {
  try {
    localStorage.setItem(clave, valor);
  } catch {
    // Sin almacenamiento (modo privado): la preferencia dura lo que dure la pestaña.
  }
}

const ahora = new Date();
const estado = {
  idioma: leerPreferencia('bitacora-idioma', 'es') === 'en' ? 'en' : 'es',
  tema: leerPreferencia('bitacora-tema', 'dark') === 'light' ? 'light' : 'dark',
  cuentas: [],
  cargandoCuentas: true,
  puntaje: null,
  cargandoPuntaje: true,
  mensual: 0,
  mensualPorCuenta: {},
  mensualCargado: false,
  curva: [],
  cargandoResumen: true,
  dias: [],
  cargandoCalendario: false,
  anio: ahora.getFullYear(),
  mes: ahora.getMonth(),
  eventos: null,
  errorEventos: false,
};

let t = TEXTOS[estado.idioma];

// ---------- API ----------

async function api(ruta, opciones = {}) {
  const respuesta = await fetch(ruta, {
    ...opciones,
    headers: opciones.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  const cuerpo = await respuesta.json().catch(() => null);
  if (!respuesta.ok) throw new Error(cuerpo?.error || `${respuesta.status}`);
  return cuerpo;
}

async function cargarDatos() {
  const cuentas = api('/api/accounts?status=ACTIVE&leafOnly=true')
    .then((r) => {
      estado.cuentas = Array.isArray(r) ? r : (r.accounts ?? []);
    })
    .catch(() => avisar(t.avisos.error, true))
    .finally(() => {
      estado.cargandoCuentas = false;
    });
  const puntaje = api('/api/metrics/tn-score?accountId=all')
    .then((r) => {
      estado.puntaje = r;
    })
    .catch(() => {})
    .finally(() => {
      estado.cargandoPuntaje = false;
    });
  const resumen = api(`/api/dashboard/summary?months=6&calendarYear=${estado.anio}&calendarMonth=${estado.mes}`)
    .then((r) => {
      if (typeof r.monthlyPnl === 'number') estado.mensual = r.monthlyPnl;
      if (r.monthlyByAccount && typeof r.monthlyByAccount === 'object') {
        estado.mensualPorCuenta = r.monthlyByAccount;
        estado.mensualCargado = true;
      }
      if (Array.isArray(r.equityCurve)) estado.curva = r.equityCurve;
      if (Array.isArray(r.calendarDays)) estado.dias = r.calendarDays;
    })
    .catch(() => {})
    .finally(() => {
      estado.cargandoResumen = false;
    });
  await Promise.all([cuentas, puntaje, resumen]);
  pintarTodo();
}

async function cargarEventos() {
  const hoy = new Date();
  const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 0, 0, 0);
  const hasta = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 23, 59, 59);
  try {
    const r = await api(`/api/economic-calendar?from=${encodeURIComponent(desde.toISOString())}&to=${encodeURIComponent(hasta.toISOString())}&impact=High`);
    const eventos = Array.isArray(r?.events) ? r.events : [];
    eventos.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
    estado.eventos = eventos;
  } catch {
    estado.errorEventos = true;
  }
  pintarEventos();
}

async function cambiarMes(delta) {
  const fecha = new Date(estado.anio, estado.mes + delta, 1);
  estado.anio = fecha.getFullYear();
  estado.mes = fecha.getMonth();
  estado.cargandoCalendario = true;
  pintarCalendario();
  try {
    const r = await api(`/api/dashboard/calendar?year=${estado.anio}&month=${estado.mes}`);
    if (Array.isArray(r.calendarDays)) estado.dias = r.calendarDays;
  } catch {
    avisar(t.avisos.error, true);
  }
  estado.cargandoCalendario = false;
  pintarCalendario();
}

// ---------- Cálculos del cliente ----------

const numero = (valor) => {
  const n = Number(valor ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Balance actual de una cuenta; si no viene, se reconstruye con inicial + neto. */
function balanceActual(cuenta) {
  const actual = numero(cuenta.currentBalance);
  return actual > 0 ? actual : numero(cuenta.balance) + numero(cuenta.netProfit);
}

/** Capital sobre el que se mide el rendimiento: balance actual menos lo ganado. */
function capitalBase(cuenta) {
  const actual = numero(cuenta.currentBalance);
  if (actual > 0) {
    const base = actual - numero(cuenta.netProfit);
    if (base > 0) return Math.round(base * 100) / 100;
  }
  return numero(cuenta.balance);
}

/** Winrate global: promedio de los winrates ponderado por operaciones de cada cuenta. */
function winrateAgregado(cuentas) {
  const conOps = cuentas.filter((c) => (c.tradeOps ?? 0) > 0);
  const total = conOps.reduce((suma, c) => suma + c.tradeOps, 0);
  if (total === 0) return 0;
  return Math.round((conOps.reduce((suma, c) => suma + (c.winrate ?? 0) * c.tradeOps, 0) / total) * 100) / 100;
}

function totales() {
  const balance = estado.cuentas.reduce((suma, c) => suma + balanceActual(c), 0);
  const pnl = estado.cuentas.reduce((suma, c) => suma + (c.netProfit ?? 0), 0);
  const ops = estado.cuentas.reduce((suma, c) => suma + (c._count?.operations ?? 0), 0);
  const base = balance - pnl;
  return { balance, pnl, ops, variacion: balance === 0 || base === 0 ? 0 : (pnl / base) * 100, winrate: winrateAgregado(estado.cuentas) };
}

function opsDelMes() {
  let total = 0;
  for (const fila of Object.values(estado.mensualPorCuenta)) {
    const ops = Number(fila?.ops ?? 0);
    if (Number.isFinite(ops) && ops > 0) total += ops;
  }
  return total;
}

/** Sectores de la dona: cuentas con balance, de mayor a menor; del 9.º en adelante van a "Otras". */
function sectoresDistribucion() {
  const filas = estado.cuentas
    .filter((c) => balanceActual(c) > 0)
    .map((c) => ({ name: c.name, value: balanceActual(c) }))
    .sort((a, b) => b.value - a.value);
  const total = filas.reduce((suma, f) => suma + f.value, 0);
  let visibles = filas;
  if (filas.length > MAX_SECTORES) {
    const resto = filas.slice(MAX_SECTORES - 1);
    visibles = [...filas.slice(0, MAX_SECTORES - 1), { name: t.distribucion.otras, value: resto.reduce((s, f) => s + f.value, 0), otras: true }];
  }
  return visibles.map((f, i) => ({
    ...f,
    color: f.otras ? 'var(--serie-otras)' : `var(--serie-${i + 1})`,
    percent: total > 0 ? f.value / total : 0,
  }));
}

// ---------- Pintado ----------

const ICONOS = {
  balance: '<path d="M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path d="M3 7V6a2 2 0 0 1 2-2h11"/><circle cx="16.5" cy="13.5" r="1"/>',
  pnl: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  winrate: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  mes: '<path d="M12 3v18"/><path d="M16.5 7.5c-.8-1.2-2.4-2-4.500-2C9.800 5.500 8 6.700 8 8.500c0 4 8.500 2 8.500 6.500 0 1.900-2 3-4.500 3-2.300 0-4-.900-4.700-2.300"/>',
  puntaje: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14l-1.500 7 5-3 5 3-1.500-7"/>',
};

function pintarKpis() {
  const zona = $('#kpis');
  if (estado.cargandoCuentas) {
    zona.innerHTML = Array.from({ length: 5 }, (_, i) => `<div class="kpi${i === 0 ? ' principal' : ''}"><div class="esqueleto" style="height:84px"></div></div>`).join('');
    return;
  }
  const tot = totales();
  const sinOpsMes = estado.mensualCargado && opsDelMes() === 0;
  const p = estado.puntaje;
  const valorPuntaje = estado.cargandoPuntaje ? '<span class="esqueleto" style="display:block;width:64px;height:24px"></span>' : p ? fmt(Number(p.tnScore), 2) : '—';
  const subPuntaje = p && p.totalTrades > 0 ? `${t.kpi.consistencia} · ${t.niveles[p.level] ?? p.level}` : t.kpi.consistencia;

  const tarjeta = ({ clave, etiqueta, valor, clase = '', sub = '', principal = false }) => `
    <div class="kpi${principal ? ' principal' : ''}">
      <button class="icono kpi-info" type="button" data-accion="info" data-clave="${clave}" aria-label="${esc(`${t.kpi.comoSeCalcula} ${etiqueta}`)}">?</button>
      <div class="kpi-icono"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONOS[clave]}</svg></div>
      <div class="kpi-etiqueta">${esc(etiqueta)}</div>
      <div class="kpi-valor mono ${clase}">${valor}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`;

  zona.innerHTML = [
    tarjeta({
      clave: 'balance',
      etiqueta: t.kpi.balance,
      valor: esc(fmtMoneda(tot.balance)),
      sub: tot.variacion !== 0 ? `<span class="${clasePnl(tot.variacion)}">${tot.variacion > 0 ? '▲' : '▼'} ${esc(fmtPorcentaje(Math.abs(tot.variacion), 2))}</span>` : '',
      principal: true,
    }),
    tarjeta({ clave: 'pnl', etiqueta: t.kpi.pnl, valor: esc(fmtConSigno(tot.pnl)), clase: clasePnl(tot.pnl) }),
    tarjeta({ clave: 'winrate', etiqueta: t.kpi.winrate, valor: esc(fmtPorcentaje(tot.winrate, 1)), sub: esc(t.kpi.deOps.replace('{n}', String(tot.ops))) }),
    tarjeta({
      clave: 'mes',
      etiqueta: t.kpi.mes,
      valor: sinOpsMes ? '—' : esc(fmtConSigno(estado.mensual)),
      clase: sinOpsMes ? 'neutro' : clasePnl(estado.mensual),
      sub: sinOpsMes ? esc(t.kpi.sinOpsMes) : '',
    }),
    tarjeta({ clave: 'puntaje', etiqueta: t.kpi.puntaje, valor: valorPuntaje, sub: esc(subPuntaje) }),
  ].join('');
}

function pintarPrimerUso() {
  const zona = $('#primer-uso');
  zona.hidden = estado.cargandoCuentas || estado.cuentas.length > 0;
  if (zona.hidden) return;
  zona.innerHTML = `<div class="tarjeta primer-uso">
    <h2>${esc(t.primerUso.titulo)}</h2>
    <p>${esc(t.primerUso.texto)}</p>
    <div class="fila">
      <button class="boton primario" type="button" data-accion="nueva-cuenta">${esc(t.agregarCuenta)}</button>
      <button class="boton" type="button" data-accion="demo">${esc(t.primerUso.demo)}</button>
    </div>
  </div>`;
}

function tipoCuenta(cuenta) {
  const tipo = String(cuenta.accountType ?? '').toLowerCase();
  return t.tipos[tipo] ?? null;
}

function pintarCuentas() {
  const zona = $('#seccion-cuentas');
  zona.hidden = estado.cargandoCuentas || estado.cuentas.length === 0;
  if (zona.hidden) return;
  const tarjetas = estado.cuentas.map((c) => {
    const ops = c.totalOps ?? c._count?.operations ?? 0;
    const pf = c.profitFactor ?? 0;
    const rendimiento = c.rendimientoPercent ?? 0;
    const tipo = tipoCuenta(c);
    const conDatos = ops > 0;
    return `<article class="cuenta">
      <div class="cuenta-cabecera">
        <span class="estado-punto${conDatos ? '' : ' espera'}" title="${esc(conDatos ? t.cuentas.conDatos : t.cuentas.sinDatos)}"></span>
        <div class="nombre">
          <h3 title="${esc(c.name)}">${esc(c.name)}</h3>
          <small>${esc(c.broker || c.platform)}</small>
        </div>
        <details class="menu">
          <summary class="icono" aria-label="${esc(`${t.cuentas.acciones}: ${c.name}`)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg></summary>
          <div class="menu-lista">
            <button type="button" data-accion="operacion" data-id="${esc(c.id)}">${esc(t.cuentas.operacion)}</button>
            <button type="button" data-accion="importar" data-id="${esc(c.id)}">${esc(t.cuentas.importar)}</button>
            <button type="button" data-accion="movimiento" data-id="${esc(c.id)}">${esc(t.cuentas.movimiento)}</button>
            <button type="button" data-accion="editar" data-id="${esc(c.id)}">${esc(t.cuentas.editar)}</button>
            <button type="button" class="peligro" data-accion="eliminar" data-id="${esc(c.id)}">${esc(t.cuentas.eliminar)}</button>
          </div>
        </details>
      </div>
      <div class="etiquetas">
        <span class="etiqueta">${esc(t.cuentas.activa)}</span>
        ${tipo ? `<span class="etiqueta">${esc(tipo)}</span>` : ''}
        ${c.broker ? `<span class="etiqueta">${esc(c.platform)}</span>` : ''}
      </div>
      <dl class="metricas">
        <div><dt>${esc(t.cuentas.balance)}</dt><dd class="mono">${esc(fmtMoneda(balanceActual(c)))}</dd></div>
        <div><dt>${esc(t.cuentas.pnlTotal)}</dt><dd class="mono ${clasePnl(c.netProfit ?? 0)}">${esc(fmtConSigno(c.netProfit ?? 0))}</dd></div>
        <div><dt>${esc(t.kpi.winrate)}</dt><dd class="mono">${conDatos ? esc(fmtPorcentaje(c.winrate ?? 0, 1)) : '—'}</dd></div>
        <div><dt>${esc(t.cuentas.profitFactor)}</dt><dd class="mono">${pf === 999.99 ? '∞' : pf > 0 ? esc(fmt(pf, 2)) : '—'}</dd></div>
      </dl>
      <div class="cuenta-pie">
        <span>${ops} ${esc(t.cuentas.operaciones)}</span>
        ${rendimiento !== 0 ? `<span class="${clasePnl(rendimiento)}">${rendimiento > 0 ? '▲ +' : '▼ −'}${esc(fmt(Math.abs(rendimiento), 2))}%</span>` : ''}
      </div>
    </article>`;
  });
  zona.innerHTML = `<h2 class="sobretitulo">${esc(t.cuentas.titulo)}</h2><div class="rejilla-cuentas">${tarjetas.join('')}</div>`;
}

function pintarEventos() {
  const zona = $('#eventos');
  let cuerpo;
  if (estado.errorEventos) {
    cuerpo = `<p class="apagado">${esc(t.eventos.error)}</p>`;
  } else if (estado.eventos === null) {
    cuerpo = Array.from({ length: 3 }, () => '<div class="esqueleto" style="height:40px;margin:6px 0"></div>').join('');
  } else if (estado.eventos.length === 0) {
    cuerpo = `<p class="apagado">${esc(t.eventos.vacio)}</p>`;
  } else {
    const filas = estado.eventos.slice(0, MAX_EVENTOS).map((e) => {
      const hora = new Date(e.scheduledAt);
      const textoHora = Number.isNaN(hora.getTime()) ? '--:--' : hora.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `<div class="evento">
        <div class="evento-hora mono">${esc(textoHora)}</div>
        <div class="evento-moneda">${esc(e.country)}</div>
        <div class="evento-cuerpo">
          <div class="evento-nombre" title="${esc(e.eventName)}">${esc(e.eventName)}</div>
          <div class="evento-datos mono">
            <span>${esc(t.eventos.prev)}: <b>${esc(e.previous ?? '—')}</b></span>
            <span>${esc(t.eventos.pron)}: <b>${esc(e.forecast ?? '—')}</b></span>
            ${e.actual ? `<span>${esc(t.eventos.real)}: <b>${esc(e.actual)}</b></span>` : ''}
          </div>
        </div>
        <div class="impacto" aria-hidden="true"><i></i><i></i><i></i></div>
      </div>`;
    });
    const resto = estado.eventos.length - MAX_EVENTOS;
    cuerpo = filas.join('') + (resto > 0 ? `<p class="apagado" style="padding-top:8px;font-size:.8rem">${esc(t.eventos.mas.replace('{n}', String(resto)))}</p>` : '');
  }
  zona.innerHTML = `<div class="tarjeta-titulo"><h2>${esc(t.eventos.titulo)}</h2></div>${cuerpo}`;
}

function pintarDistribucion() {
  const zona = $('#distribucion');
  const cabecera = `<div class="tarjeta-titulo"><div><h2>${esc(t.distribucion.titulo)}</h2><small class="apagado">${esc(t.distribucion.sub)}</small></div></div>`;
  if (estado.cargandoCuentas) {
    zona.innerHTML = `${cabecera}<div class="esqueleto" style="height:240px"></div>`;
    return;
  }
  const sectores = sectoresDistribucion();
  if (sectores.length === 0) {
    zona.innerHTML = `${cabecera}<p class="vacio">${esc(t.sinDatos)}</p>`;
    return;
  }
  const total = sectores.reduce((suma, s) => suma + s.value, 0);
  zona.innerHTML = `${cabecera}<div class="dona-zona">
    <div class="dona"><div id="dona-svg"></div><div class="dona-centro"><span>${esc(t.kpi.balance)}</span><strong class="mono">${esc(fmtMoneda(total))}</strong></div></div>
    <ul class="leyenda">${sectores
      .map((s) => `<li><i style="background:${s.color}"></i><span class="nombre" title="${esc(s.name)}">${esc(s.name)}</span><span class="valor mono"><b>${esc(fmtMoneda(s.value))}</b><small>${esc(fmtPorcentaje(s.percent * 100, 1))}</small></span></li>`)
      .join('')}</ul>
  </div>`;
  dibujarDona($('#dona-svg'), sectores, { formatoValor: (n) => fmtMoneda(n), etiqueta: t.distribucion.titulo });
}

function pintarTop() {
  const zona = $('#top');
  const cabecera = `<div class="tarjeta-titulo"><h2 class="sobretitulo">${esc(t.top.titulo)}</h2></div>`;
  if (estado.cargandoCuentas || estado.cargandoResumen) {
    zona.innerHTML = `${cabecera}<div class="esqueleto" style="height:200px"></div>`;
    return;
  }
  if (estado.cuentas.length === 0) {
    zona.innerHTML = `${cabecera}<p class="vacio">${esc(t.sinDatos)}</p>`;
    return;
  }
  const filas = estado.cuentas
    .map((c) => ({ ...c, pnlMes: estado.mensualPorCuenta[c.id]?.pnl ?? 0, opsMes: estado.mensualPorCuenta[c.id]?.ops ?? 0 }))
    .sort((a, b) => b.pnlMes - a.pnlMes);
  const opsTotales = filas.reduce((suma, f) => suma + f.opsMes, 0);
  const importe = (n) => `${n >= 0 ? '+$' : '-$'}${fmt(Math.abs(n))}`;
  const podio = filas.slice(0, 3).map((f, i) => {
    const base = capitalBase(f);
    const porcentaje = base > 0 ? Math.round((f.pnlMes / base) * 1e4) / 100 : 0;
    return `<div class="puesto">
      <span class="puesto-numero p${i + 1}">${i + 1}</span>
      <div class="nombre"><b>${esc(f.name)}</b><small>${f.opsMes} ${esc(t.cuentas.operaciones)}</small></div>
      <div class="cifra mono"><b class="${clasePnl(f.pnlMes)}">${esc(importe(f.pnlMes))}</b><small class="${clasePnl(porcentaje)}">${porcentaje >= 0 ? '+' : ''}${esc(fmt(porcentaje, 2))}%</small></div>
    </div>`;
  });
  zona.innerHTML = `${cabecera}${podio.join('')}
    <div class="total-mes">
      <div><b>${esc(t.top.total)}</b><small>${opsTotales} ${esc(t.cuentas.operaciones)}</small></div>
      <b class="mono ${clasePnl(estado.mensual)}">${esc(importe(estado.mensual))}</b>
    </div>`;
}

/** Etiqueta de fecha del eje: "Nov 3"; agrega el año si la serie cruza de año. */
function formateadorFechas(fechas) {
  const anios = new Set(fechas.map((f) => partesFecha(f)?.anio).filter(Boolean));
  return (fecha, completo = false) => {
    const p = partesFecha(fecha);
    if (!p) return String(fecha);
    const base = `${t.mesesCortos[p.mes0]} ${p.dia}`;
    return anios.size > 1 || completo ? `${base} '${String(p.anio).slice(-2)}` : base;
  };
}

function pintarEvolucion() {
  const zona = $('#evolucion');
  const cabecera = `<div class="tarjeta-titulo"><h2 class="sobretitulo">${esc(t.evolucion.titulo)}</h2></div>`;
  if (estado.cargandoResumen) {
    zona.innerHTML = `${cabecera}<div class="esqueleto" style="height:300px"></div>`;
    return;
  }
  if (estado.curva.length < 2) {
    zona.innerHTML = `${cabecera}<p class="vacio">${esc(t.evolucion.insuficiente)}</p>`;
    return;
  }
  const formatoX = formateadorFechas(estado.curva.map((p) => p.date));
  zona.innerHTML = `${cabecera}<div class="grafico" id="grafico-evolucion"></div>
    <details class="tabla"><summary>${esc(t.evolucion.tabla)}</summary><div class="desplazable"><table>
      <thead><tr><th>${esc(t.evolucion.fecha)}</th><th class="num">${esc(t.evolucion.equity)}</th></tr></thead>
      <tbody>${estado.curva.map((p) => `<tr><td>${esc(formatoX(p.date, true))}</td><td class="num mono">${esc(fmtMoneda(p.equity))}</td></tr>`).join('')}</tbody>
    </table></div></details>`;
  dibujarLinea($('#grafico-evolucion'), estado.curva, { formatoX, formatoValor: (n) => fmtMoneda(n), etiqueta: t.evolucion.titulo });
}

function pintarCalendario() {
  const zona = $('#calendario');
  const { anio, mes } = estado;
  const cargando = estado.cargandoCalendario || estado.cargandoResumen;
  const prefijo = `${anio}-${String(mes + 1).padStart(2, '0')}-`;
  const porFecha = new Map(estado.dias.filter((d) => d.date.startsWith(prefijo)).map((d) => [d.date, d]));

  // Semana de lunes a domingo: se rellenan los huecos antes del día 1 y al final.
  const diasDelMes = new Date(anio, mes + 1, 0).getDate();
  const huecos = (new Date(anio, mes, 1).getDay() + 6) % 7;
  const celdas = [...Array(huecos).fill(null), ...Array.from({ length: diasDelMes }, (_, i) => `${prefijo}${String(i + 1).padStart(2, '0')}`)];
  while (celdas.length % 7 !== 0) celdas.push(null);

  const hoy = hoyLocal();
  const rejilla = celdas.map((fecha) => {
    if (!fecha) return '<div class="dia blanco"></div>';
    if (cargando) return '<div class="dia esqueleto"></div>';
    const d = porFecha.get(fecha);
    const operado = Boolean(d) && d.pnl != null;
    const pnl = d?.pnl ?? 0;
    const clase = operado ? (pnl > 0 ? ' gano' : pnl < 0 ? ' perdio' : '') : '';
    const chips = [
      ...(d?.deposits ?? []).map((m) => `<span class="chip deposito mono" title="${esc(t.calendario.deposito)}">${esc(fmtCompacto(m))}</span>`),
      ...(d?.withdrawals ?? []).map((m) => `<span class="chip retiro mono" title="${esc(t.calendario.retiro)}">${esc(fmtCompacto(-m))}</span>`),
    ];
    return `<div class="dia${clase}${fecha === hoy ? ' hoy' : ''}">
      <span class="dia-numero">${Number(fecha.slice(8, 10))}</span>
      ${operado ? `<span class="dia-pnl mono ${clasePnl(pnl)}">${esc(fmtConSigno(pnl))}</span>${d.ops > 0 ? `<span class="dia-ops">${d.ops} ops</span>` : ''}` : ''}
      ${chips.length ? `<div class="dia-movs">${chips.join('')}</div>` : ''}
    </div>`;
  });

  // Totales del mes: sólo cuentan los días con operaciones (pnl no nulo).
  let ops = 0;
  let diasOperados = 0;
  let profit = 0;
  let mejor = null;
  for (const d of porFecha.values()) {
    if (d.pnl == null) continue;
    ops += d.ops ?? 0;
    diasOperados += 1;
    profit += d.pnl;
    if (mejor === null || d.pnl > mejor) mejor = d.pnl;
  }
  const pie = cargando
    ? ''
    : `<div class="cal-pie">
        <div><span>${esc(t.calendario.dias)}</span><b class="mono">${diasOperados}</b></div>
        <div><span>${esc(t.calendario.ops)}</span><b class="mono">${ops}</b></div>
        <div><span>${esc(t.calendario.mejor)}</span><b class="mono ${mejor === null ? 'neutro' : clasePnl(mejor)}">${mejor === null ? '—' : esc(fmtConSigno(mejor))}</b></div>
        <div><span>${esc(t.calendario.profit)}</span><b class="mono ${clasePnl(profit)}">${esc(fmtConSigno(profit))}</b></div>
      </div>`;

  zona.innerHTML = `<div class="cal-cabecera">
      <h2>${esc(t.calendario.titulo)}</h2>
      <div class="cal-nav">
        <button class="icono" type="button" data-accion="mes-anterior" aria-label="${esc(t.calendario.anterior)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span>${esc(t.meses[mes])} ${anio}</span>
        <button class="icono" type="button" data-accion="mes-siguiente" aria-label="${esc(t.calendario.siguiente)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>
    </div>
    <div class="cal-semana">${t.diasSemana.map((d) => `<div>${d}</div>`).join('')}</div>
    <div class="cal-rejilla">${rejilla.join('')}</div>${pie}`;
}

function aplicarIdioma() {
  t = TEXTOS[estado.idioma];
  document.documentElement.lang = estado.idioma;
  const texto = (ruta) => ruta.split('.').reduce((nodo, clave) => nodo?.[clave], t) ?? '';
  document.querySelectorAll('[data-t]').forEach((el) => {
    el.textContent = texto(el.dataset.t);
  });
  document.querySelectorAll('[data-t-aria]').forEach((el) => {
    el.setAttribute('aria-label', texto(el.dataset.tAria));
    el.title = texto(el.dataset.tAria);
  });
  $('#boton-idioma').textContent = t.idiomaAlterno;
}

function pintarTodo() {
  pintarPrimerUso();
  pintarKpis();
  pintarCuentas();
  pintarEventos();
  pintarDistribucion();
  pintarTop();
  pintarEvolucion();
  pintarCalendario();
}

// ---------- Avisos y diálogos ----------

function avisar(mensaje, esError = false) {
  const aviso = document.createElement('div');
  aviso.className = `aviso${esError ? ' error' : ''}`;
  aviso.textContent = mensaje;
  $('#avisos').appendChild(aviso);
  setTimeout(() => aviso.remove(), esError ? 6000 : 3500);
}

const dialogo = $('#dialogo');

/** Abre el diálogo con un formulario; `alEnviar` recibe los valores y puede lanzar. */
function abrirFormulario({ titulo, cuerpo, boton, destructivo = false, alEnviar }) {
  dialogo.innerHTML = `<form class="dialogo-cuerpo" novalidate>
    <h2>${esc(titulo)}</h2>
    ${cuerpo}
    <p class="error-formulario" role="alert" hidden></p>
    <div class="dialogo-pie">
      <button class="boton" type="button" data-accion="cerrar-dialogo">${esc(alEnviar ? t.formulario.cancelar : t.formulario.cerrar)}</button>
      ${alEnviar ? `<button class="boton ${destructivo ? 'destructivo' : 'primario'}" type="submit">${esc(boton)}</button>` : ''}
    </div>
  </form>`;
  const formulario = dialogo.querySelector('form');
  const error = dialogo.querySelector('.error-formulario');
  formulario.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (!alEnviar) return dialogo.close();
    if (!formulario.reportValidity()) return;
    const enviar = formulario.querySelector('[type=submit]');
    enviar.disabled = true;
    error.hidden = true;
    try {
      await alEnviar(Object.fromEntries(new FormData(formulario)), formulario);
      dialogo.close();
    } catch (e) {
      error.textContent = e.message || t.avisos.error;
      error.hidden = false;
      enviar.disabled = false;
    }
  });
  dialogo.showModal();
}

const campo = (etiqueta, control, ayuda = '') => `<label class="campo"><span>${esc(etiqueta)}</span>${control}${ayuda ? `<small>${esc(ayuda)}</small>` : ''}</label>`;
const opciones = (pares, seleccionado) => pares.map(([valor, texto]) => `<option value="${esc(valor)}"${valor === seleccionado ? ' selected' : ''}>${esc(texto)}</option>`).join('');

const PLATAFORMAS = ['MANUAL', 'MT5', 'MT4', 'CTRADER', 'NINJATRADER', 'TOPSTEPX', 'TRADELOCKER', 'TRADOVATE', 'PAPER'];

function abrirCuenta(cuenta = null) {
  const f = t.formulario;
  abrirFormulario({
    titulo: cuenta ? f.editarCuenta : f.nuevaCuenta,
    boton: f.guardar,
    cuerpo: [
      campo(f.nombre, `<input name="name" required maxlength="80" value="${esc(cuenta?.name ?? '')}" autocomplete="off">`),
      `<div class="dos">${campo(f.plataforma, `<select name="platform">${opciones(PLATAFORMAS.map((p) => [p, p]), cuenta?.platform ?? 'MANUAL')}</select>`)}
       ${campo(f.tipo, `<select name="accountType">${opciones([['', f.sinTipo], ...Object.entries(t.tipos)], cuenta?.accountType ?? '')}</select>`)}</div>`,
      campo(f.broker, `<input name="broker" maxlength="80" value="${esc(cuenta?.broker ?? '')}" autocomplete="off">`),
      campo(f.balanceInicial, `<input name="balance" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(cuenta?.balance ?? '')}">`),
    ].join(''),
    alEnviar: async (valores) => {
      const cuerpo = { ...valores, balance: Number(valores.balance) };
      if (cuenta) await api(`/api/accounts/${encodeURIComponent(cuenta.id)}`, { method: 'PATCH', body: cuerpo });
      else await api('/api/accounts', { method: 'POST', body: cuerpo });
      avisar(cuenta ? t.avisos.cuentaGuardada : t.avisos.cuentaCreada);
      await cargarDatos();
    },
  });
}

function abrirOperacion(cuenta) {
  const f = t.formulario;
  abrirFormulario({
    titulo: `${f.nuevaOperacion} — ${cuenta.name}`,
    boton: f.guardar,
    cuerpo: [
      `<div class="dos">${campo(f.fecha, `<input name="date" type="date" required max="${hoyLocal()}" value="${hoyLocal()}">`)}
       ${campo(f.lado, `<select name="side">${opciones([['', f.sinLado], ['buy', f.compra], ['sell', f.venta]], '')}</select>`)}</div>`,
      campo(f.simbolo, '<input name="symbol" maxlength="20" autocomplete="off">'),
      campo(f.pnl, '<input name="pnl" type="number" inputmode="decimal" step="0.01" required>', f.pnlAyuda),
    ].join(''),
    alEnviar: async (valores) => {
      await api(`/api/accounts/${encodeURIComponent(cuenta.id)}/operations`, { method: 'POST', body: { ...valores, pnl: Number(valores.pnl) } });
      avisar(t.avisos.operacionGuardada);
      await cargarDatos();
    },
  });
}

function abrirImportar(cuenta) {
  const f = t.formulario;
  abrirFormulario({
    titulo: `${f.importarTitulo} — ${cuenta.name}`,
    boton: f.importar,
    cuerpo: [
      `<p class="apagado" style="font-size:.85rem">${esc(f.importarAyuda)}</p>`,
      campo(f.archivo, '<input name="archivo" type="file" accept=".csv,text/csv,text/plain">'),
      campo(f.pegar, '<textarea name="csv" placeholder="fecha;simbolo;lado;pnl&#10;2026-11-03;EURUSD;buy;120,50"></textarea>'),
    ].join(''),
    alEnviar: async (valores, formulario) => {
      const archivo = formulario.elements.archivo.files[0];
      const csv = archivo ? await archivo.text() : String(valores.csv ?? '');
      const r = await api(`/api/accounts/${encodeURIComponent(cuenta.id)}/operations/import`, { method: 'POST', body: { csv } });
      if (r.imported === 0) throw new Error(r.errors?.[0] ?? t.avisos.error);
      avisar(t.avisos.importadas.replace('{n}', String(r.imported)));
      if (r.rejected > 0) avisar(`${t.avisos.rechazadas.replace('{n}', String(r.rejected))}: ${r.errors[0]}`, true);
      await cargarDatos();
    },
  });
}

function abrirMovimiento(cuenta) {
  const f = t.formulario;
  abrirFormulario({
    titulo: `${f.movimientoTitulo} — ${cuenta.name}`,
    boton: f.guardar,
    cuerpo: [
      `<div class="dos">${campo(f.tipoMov, `<select name="type">${opciones([['deposit', f.deposito], ['withdrawal', f.retiro]], 'deposit')}</select>`)}
       ${campo(f.fecha, `<input name="date" type="date" required max="${hoyLocal()}" value="${hoyLocal()}">`)}</div>`,
      campo(f.monto, '<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required>'),
    ].join(''),
    alEnviar: async (valores) => {
      await api(`/api/accounts/${encodeURIComponent(cuenta.id)}/movements`, { method: 'POST', body: { ...valores, amount: Number(valores.amount) } });
      avisar(t.avisos.movimientoGuardado);
      await cargarDatos();
    },
  });
}

function abrirInfo(clave) {
  const tot = totales();
  const valores = {
    balance: fmtMoneda(tot.balance),
    pnl: fmtConSigno(tot.pnl),
    winrate: fmtPorcentaje(tot.winrate, 1),
    mes: fmtConSigno(estado.mensual),
    puntaje: estado.puntaje ? fmt(Number(estado.puntaje.tnScore), 2) : '—',
  };
  const p = estado.puntaje;
  const detalle =
    clave === 'puntaje' && p
      ? `<div class="info-bloque"><span>WR · PF · EXP · RF</span><code class="mono">${esc(`${fmtPorcentaje(p.components.winRate, 1)} · ${p.components.profitFactor === 999.99 ? '∞' : fmt(p.components.profitFactor)} · ${fmtConSigno(p.components.expectancy)} · ${p.components.recoveryFactor === 999.99 ? '∞' : fmt(p.components.recoveryFactor)}`)}</code></div>
         ${p.confidenceNote ? `<p class="apagado" style="font-size:.85rem">${esc(p.confidenceNote)}</p>` : ''}`
      : '';
  abrirFormulario({
    titulo: t.kpi[clave],
    cuerpo: `<div class="info-bloque"><span>${esc(t.kpi.valorActual)}</span><strong class="mono" style="font-size:1.3rem">${esc(valores[clave])}</strong></div>
      <p>${esc(t.info[clave].d)}</p>
      <div class="info-bloque"><span>${esc(t.kpi.formula)}</span><code>${esc(t.info[clave].f)}</code></div>${detalle}`,
  });
}

// ---------- Acciones ----------

const cuentaPorId = (id) => estado.cuentas.find((c) => c.id === id);

const acciones = {
  lateral: () => {
    const app = $('#app');
    if (window.matchMedia('(max-width: 860px)').matches) app.classList.toggle('con-lateral');
    else app.classList.toggle('sin-lateral');
    pintarEvolucion();
  },
  idioma: () => {
    estado.idioma = estado.idioma === 'es' ? 'en' : 'es';
    guardarPreferencia('bitacora-idioma', estado.idioma);
    aplicarIdioma();
    pintarTodo();
  },
  tema: () => {
    estado.tema = estado.tema === 'dark' ? 'light' : 'dark';
    guardarPreferencia('bitacora-tema', estado.tema);
    document.documentElement.dataset.theme = estado.tema;
  },
  pantalla: () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  },
  'nueva-cuenta': () => abrirCuenta(),
  editar: (id) => abrirCuenta(cuentaPorId(id)),
  operacion: (id) => abrirOperacion(cuentaPorId(id)),
  importar: (id) => abrirImportar(cuentaPorId(id)),
  movimiento: (id) => abrirMovimiento(cuentaPorId(id)),
  eliminar: (id) => {
    const cuenta = cuentaPorId(id);
    abrirFormulario({
      titulo: t.confirmar.eliminarTitulo,
      boton: t.confirmar.eliminar,
      destructivo: true,
      cuerpo: `<p>${esc(t.confirmar.eliminarTexto.replace('{nombre}', cuenta.name))}</p>`,
      alEnviar: async () => {
        await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
        avisar(t.avisos.cuentaEliminada);
        await cargarDatos();
      },
    });
  },
  demo: async () => {
    try {
      await api('/api/demo', { method: 'POST', body: {} });
      avisar(t.avisos.demoCargada);
      await cargarDatos();
    } catch (e) {
      avisar(e.message || t.avisos.error, true);
    }
  },
  restablecer: () =>
    abrirFormulario({
      titulo: t.confirmar.restablecerTitulo,
      boton: t.confirmar.restablecer,
      destructivo: true,
      cuerpo: `<p>${esc(t.confirmar.restablecerTexto)}</p>`,
      alEnviar: async () => {
        await api('/api/reset', { method: 'POST', body: { confirm: 'BORRAR' } });
        avisar(t.avisos.restablecido);
        await cargarDatos();
      },
    }),
  info: (_, boton) => abrirInfo(boton.dataset.clave),
  'mes-anterior': () => cambiarMes(-1),
  'mes-siguiente': () => cambiarMes(1),
  'cerrar-dialogo': () => dialogo.close(),
};

document.addEventListener('click', (evento) => {
  const boton = evento.target.closest('[data-accion]');
  // Cualquier clic fuera de un menú abierto (o sobre una de sus opciones) lo cierra.
  document.querySelectorAll('details.menu[open]').forEach((menu) => {
    if (boton || !menu.contains(evento.target)) menu.removeAttribute('open');
  });
  if (boton) acciones[boton.dataset.accion]?.(boton.dataset.id, boton);
});

// El gráfico de línea se dibuja con el ancho real del contenedor: se rehace al cambiar.
let anchoPrevio = 0;
new ResizeObserver(([entrada]) => {
  const ancho = Math.round(entrada.contentRect.width);
  if (ancho !== anchoPrevio) {
    anchoPrevio = ancho;
    if ($('#grafico-evolucion')) pintarEvolucion();
  }
}).observe($('#evolucion'));

document.documentElement.dataset.theme = estado.tema;
aplicarIdioma();
pintarTodo();
cargarDatos();
cargarEventos();
