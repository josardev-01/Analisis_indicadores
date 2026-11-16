// Cálculo de métricas del dashboard. Funciones puras: reciben los datos crudos
// (cuentas, operaciones, movimientos) y devuelven las mismas formas JSON que se
// observaron en la app original con REA (ver README, sección "Contrato de API").

export const redondear2 = (n) => Math.round(n * 100) / 100;

const acotar = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));

/** Fecha local de hoy como 'AAAA-MM-DD'. */
export function hoyLocal(ahora = new Date()) {
  const a = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, '0');
  const d = String(ahora.getDate()).padStart(2, '0');
  return `${a}-${m}-${d}`;
}

/** Prefijo 'AAAA-MM-' de un año y un mes en base 0 (igual que la API original). */
export const prefijoMes = (anio, mes0) => `${anio}-${String(mes0 + 1).padStart(2, '0')}-`;

/** Resta meses a una fecha 'AAAA-MM-DD' sin pasarse del último día del mes destino. */
export function restarMeses(fecha, meses) {
  const [a, m, d] = fecha.split('-').map(Number);
  const destino = new Date(a, m - 1 - meses, 1);
  const ultimoDia = new Date(destino.getFullYear(), destino.getMonth() + 1, 0).getDate();
  destino.setDate(Math.min(d, ultimoDia));
  return hoyLocal(destino);
}

function agruparPorCuenta(filas) {
  const mapa = new Map();
  for (const fila of filas) {
    if (!mapa.has(fila.accountId)) mapa.set(fila.accountId, []);
    mapa.get(fila.accountId).push(fila);
  }
  return mapa;
}

/**
 * Agrega a una cuenta los campos derivados que consume el dashboard.
 * - netProfit: suma del PnL de sus operaciones.
 * - currentBalance: balance inicial + depósitos − retiros + netProfit.
 * - winrate: % de operaciones con PnL > 0.
 * - profitFactor: ganancia bruta / pérdida bruta; 999.99 representa "infinito"
 *   (sin pérdidas), igual que el centinela que la app original pinta como ∞.
 * - rendimientoPercent: netProfit sobre el capital aportado (balance − netProfit).
 */
export function enriquecerCuenta(cuenta, operaciones = [], movimientos = []) {
  let neto = 0;
  let gananciaBruta = 0;
  let perdidaBruta = 0;
  let ganadoras = 0;
  for (const op of operaciones) {
    neto += op.pnl;
    if (op.pnl > 0) {
      ganadoras += 1;
      gananciaBruta += op.pnl;
    } else if (op.pnl < 0) {
      perdidaBruta += -op.pnl;
    }
  }
  let aportes = 0;
  for (const mov of movimientos) aportes += mov.type === 'deposit' ? mov.amount : -mov.amount;

  const total = operaciones.length;
  const capitalBase = cuenta.balance + aportes;
  let profitFactor = 0;
  if (total > 0) {
    if (perdidaBruta === 0) profitFactor = gananciaBruta > 0 ? 999.99 : 0;
    else profitFactor = redondear2(gananciaBruta / perdidaBruta);
  }
  return {
    ...cuenta,
    netProfit: redondear2(neto),
    currentBalance: redondear2(capitalBase + neto),
    winrate: total > 0 ? redondear2((ganadoras / total) * 100) : 0,
    tradeOps: total,
    totalOps: total,
    _count: { operations: total },
    profitFactor,
    rendimientoBase: redondear2(capitalBase),
    rendimientoPercent: capitalBase > 0 ? redondear2((neto / capitalBase) * 100) : 0,
  };
}

export function enriquecerCuentas(cuentas, operaciones, movimientos) {
  const opsPorCuenta = agruparPorCuenta(operaciones);
  const movsPorCuenta = agruparPorCuenta(movimientos);
  return cuentas.map((c) => enriquecerCuenta(c, opsPorCuenta.get(c.id), movsPorCuenta.get(c.id)));
}

/**
 * Días de un mes con actividad. `pnl` es null cuando ese día sólo hubo
 * depósitos o retiros: el calendario no lo cuenta como día operado.
 */
export function diasCalendario(operaciones, movimientos, anio, mes0) {
  const prefijo = prefijoMes(anio, mes0);
  const dias = new Map();
  const dia = (fecha) => {
    if (!dias.has(fecha)) dias.set(fecha, { date: fecha, pnl: null, ops: 0, deposits: [], withdrawals: [] });
    return dias.get(fecha);
  };
  for (const op of operaciones) {
    if (!op.date.startsWith(prefijo)) continue;
    const d = dia(op.date);
    d.pnl = (d.pnl ?? 0) + op.pnl;
    d.ops += 1;
  }
  for (const mov of movimientos) {
    if (!mov.date.startsWith(prefijo)) continue;
    const d = dia(mov.date);
    (mov.type === 'deposit' ? d.deposits : d.withdrawals).push(mov.amount);
  }
  return [...dias.values()]
    .map((d) => ({ ...d, pnl: d.pnl === null ? null : redondear2(d.pnl) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Balance consolidado día a día dentro de la ventana [hoy − meses, hoy].
 * Cada cuenta entra a la curva con su balance inicial en su fecha de apertura
 * (la de alta, o la de su primer evento si es anterior).
 */
export function curvaEquity(cuentas, operaciones, movimientos, meses, hoy) {
  const ids = new Set(cuentas.map((c) => c.id));
  const eventos = [];
  const primerEvento = new Map();
  const registrar = (accountId, fecha, delta) => {
    eventos.push({ date: fecha, delta });
    const previa = primerEvento.get(accountId);
    if (!previa || fecha < previa) primerEvento.set(accountId, fecha);
  };
  for (const op of operaciones) if (ids.has(op.accountId)) registrar(op.accountId, op.date, op.pnl);
  for (const mov of movimientos) {
    if (ids.has(mov.accountId)) registrar(mov.accountId, mov.date, mov.type === 'deposit' ? mov.amount : -mov.amount);
  }
  for (const c of cuentas) {
    const alta = String(c.createdAt).slice(0, 10);
    const primero = primerEvento.get(c.id);
    eventos.push({ date: primero && primero < alta ? primero : alta, delta: c.balance });
  }
  eventos.sort((a, b) => a.date.localeCompare(b.date));

  const inicio = restarMeses(hoy, meses);
  const porFecha = new Map();
  let acumulado = 0;
  let previo = null;
  for (const ev of eventos) {
    if (ev.date > hoy) break;
    acumulado += ev.delta;
    if (ev.date < inicio) previo = acumulado;
    else porFecha.set(ev.date, acumulado);
  }
  if (previo !== null && !porFecha.has(inicio)) porFecha.set(inicio, previo);
  return [...porFecha.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, equity]) => ({ date, equity: redondear2(equity) }));
}

/** Respuesta de GET /api/dashboard/summary. Sólo considera cuentas activas. */
export function resumenDashboard(datos, { months = 6, calendarYear, calendarMonth, hoy = hoyLocal() } = {}) {
  const activas = datos.cuentas.filter((c) => c.status === 'ACTIVE');
  const ids = new Set(activas.map((c) => c.id));
  const ops = datos.operaciones.filter((o) => ids.has(o.accountId));
  const movs = datos.movimientos.filter((m) => ids.has(m.accountId));

  const [anioHoy, mesHoy] = hoy.split('-').map(Number);
  const anio = Number.isInteger(calendarYear) ? calendarYear : anioHoy;
  const mes0 = Number.isInteger(calendarMonth) ? calendarMonth : mesHoy - 1;

  const prefijoActual = prefijoMes(anioHoy, mesHoy - 1);
  const monthlyByAccount = {};
  for (const c of activas) monthlyByAccount[c.id] = { pnl: 0, ops: 0 };
  let monthlyPnl = 0;
  for (const op of ops) {
    if (!op.date.startsWith(prefijoActual)) continue;
    monthlyPnl += op.pnl;
    monthlyByAccount[op.accountId].pnl += op.pnl;
    monthlyByAccount[op.accountId].ops += 1;
  }
  for (const v of Object.values(monthlyByAccount)) v.pnl = redondear2(v.pnl);

  return {
    success: true,
    monthlyPnl: redondear2(monthlyPnl),
    monthlyByAccount,
    equityCurve: curvaEquity(activas, ops, movs, months, hoy),
    calendarDays: diasCalendario(ops, movs, anio, mes0),
    calendarYear: anio,
    calendarMonth: mes0,
  };
}

const NIVELES = [
  [85, 'Excelente'],
  [70, 'Bueno'],
  [55, 'Aceptable'],
  [40, 'Regular'],
  [0, 'Critico'],
];

export const MINIMO_MUESTRA = 30;

/**
 * Puntaje de consistencia 0–100. FÓRMULA PROPIA: la original se calcula en el
 * servidor de TradingNote y no es observable; de ella sólo se vieron los cuatro
 * componentes (winRate, profitFactor, expectancy, recoveryFactor), el nivel y
 * que existe un ajuste por muestra pequeña con umbral en 30 operaciones.
 *
 *   puntaje = 100 × (0,25·WR + 0,30·PF + 0,20·EXP + 0,25·RF) × min(1, √(n/30))
 *
 * Cada componente se normaliza a 0–1:
 *   WR  = (winrate − 30) / 35            → 30 % vale 0, 65 % vale 1
 *   PF  = (profitFactor − 1) / 1,5       → 1,0 vale 0, 2,5 vale 1
 *   EXP = (expectativa / pérdida media) / 0,5   → 0,5 R por operación vale 1
 *   RF  = (neto / drawdown máximo) / 5   → recuperar 5 veces el drawdown vale 1
 */
export function puntajeConsistencia(operaciones) {
  const ops = [...operaciones].sort((a, b) => a.date.localeCompare(b.date));
  const n = ops.length;
  const nota =
    'El puntaje tiene un ajuste por muestra pequeña. Se recomienda al menos ' +
    `${MINIMO_MUESTRA} operaciones para una evaluación confiable.`;
  if (n === 0) {
    return {
      success: true,
      tnScore: 0,
      level: 'Critico',
      components: { winRate: 0, profitFactor: 0, expectancy: 0, recoveryFactor: 0 },
      totalTrades: 0,
      confidenceNote: nota,
    };
  }

  let neto = 0;
  let gananciaBruta = 0;
  let perdidaBruta = 0;
  let ganadoras = 0;
  let perdedoras = 0;
  let pico = 0;
  let drawdownMaximo = 0;
  for (const op of ops) {
    neto += op.pnl;
    if (op.pnl > 0) {
      ganadoras += 1;
      gananciaBruta += op.pnl;
    } else if (op.pnl < 0) {
      perdedoras += 1;
      perdidaBruta += -op.pnl;
    }
    if (neto > pico) pico = neto;
    if (pico - neto > drawdownMaximo) drawdownMaximo = pico - neto;
  }

  const winRate = (ganadoras / n) * 100;
  const profitFactor = perdidaBruta === 0 ? (gananciaBruta > 0 ? 999.99 : 0) : gananciaBruta / perdidaBruta;
  const expectancy = neto / n;
  const perdidaMedia = perdedoras > 0 ? perdidaBruta / perdedoras : 0;
  const expectativaR = perdidaMedia > 0 ? expectancy / perdidaMedia : expectancy > 0 ? 1 : 0;
  const recoveryFactor = drawdownMaximo === 0 ? (neto > 0 ? 999.99 : 0) : neto / drawdownMaximo;

  const base =
    0.25 * acotar((winRate - 30) / 35) +
    0.3 * acotar((profitFactor - 1) / 1.5) +
    0.2 * acotar(expectativaR / 0.5) +
    0.25 * acotar(recoveryFactor / 5);
  const tnScore = redondear2(100 * base * Math.min(1, Math.sqrt(n / MINIMO_MUESTRA)));

  return {
    success: true,
    tnScore,
    level: NIVELES.find(([minimo]) => tnScore >= minimo)[1],
    components: {
      winRate: redondear2(winRate),
      profitFactor: redondear2(profitFactor),
      expectancy: redondear2(expectancy),
      recoveryFactor: redondear2(recoveryFactor),
    },
    totalTrades: n,
    ...(n < MINIMO_MUESTRA ? { confidenceNote: nota } : {}),
  };
}

const ALIAS_COLUMNAS = {
  date: ['fecha', 'date', 'dia', 'día', 'close', 'cierre', 'close_time', 'closetime'],
  symbol: ['simbolo', 'símbolo', 'symbol', 'activo', 'instrumento', 'ticker'],
  side: ['lado', 'side', 'tipo', 'type', 'direccion', 'dirección'],
  pnl: ['pnl', 'profit', 'resultado', 'ganancia', 'beneficio', 'net', 'neto'],
};

/** Acepta '1.234,56', '1,234.56', '-45.5' y '(45,50)'. Devuelve NaN si no es número. */
export function parsearNumero(texto) {
  let t = String(texto ?? '').trim().replace(/[$€\s]/g, '');
  if (!t) return NaN;
  let signo = 1;
  if (/^\(.*\)$/.test(t)) {
    signo = -1;
    t = t.slice(1, -1);
  }
  const coma = t.lastIndexOf(',');
  const punto = t.lastIndexOf('.');
  if (coma > -1 && punto > -1) {
    // El separador que aparece último es el decimal.
    t = coma > punto ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (coma > -1) {
    t = t.replace(',', '.');
  }
  return /^[-+]?\d*\.?\d+$/.test(t) ? signo * Number(t) : NaN;
}

function normalizarFecha(texto) {
  const t = String(texto ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  if (!m) {
    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(t);
    if (dmy) m = [null, dmy[3], dmy[2], dmy[1]];
  }
  if (!m) return null;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const fecha = new Date(a, mes - 1, d);
  if (fecha.getFullYear() !== a || fecha.getMonth() !== mes - 1 || fecha.getDate() !== d) return null;
  return `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Lee un CSV de operaciones con encabezado. Columnas obligatorias: fecha y pnl.
 * Opcionales: símbolo y lado. Separador coma, punto y coma o tabulador.
 * Devuelve las filas válidas y, aparte, el detalle de cada fila rechazada.
 */
export function parsearCsv(texto) {
  const lineas = String(texto ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (lineas.length < 2) return { filas: [], errores: ['El archivo necesita un encabezado y al menos una fila.'] };

  const separador = [';', '\t', ','].find((s) => lineas[0].includes(s)) ?? ',';
  const celdas = (linea) => linea.split(separador).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const encabezado = celdas(lineas[0]).map((c) => c.toLowerCase());
  const indice = {};
  for (const [campo, alias] of Object.entries(ALIAS_COLUMNAS)) {
    indice[campo] = encabezado.findIndex((c) => alias.includes(c));
  }
  if (indice.date < 0 || indice.pnl < 0) {
    return { filas: [], errores: ['Faltan columnas obligatorias: se necesita "fecha" y "pnl".'] };
  }

  const filas = [];
  const errores = [];
  lineas.slice(1).forEach((linea, i) => {
    const c = celdas(linea);
    const date = normalizarFecha(c[indice.date]);
    const pnl = parsearNumero(c[indice.pnl]);
    if (!date) return errores.push(`Fila ${i + 2}: fecha inválida "${c[indice.date] ?? ''}".`);
    if (!Number.isFinite(pnl)) return errores.push(`Fila ${i + 2}: pnl inválido "${c[indice.pnl] ?? ''}".`);
    filas.push({
      date,
      pnl: redondear2(pnl),
      symbol: indice.symbol >= 0 ? (c[indice.symbol] ?? '').toUpperCase().slice(0, 20) : '',
      side: indice.side >= 0 ? (c[indice.side] ?? '').toLowerCase().slice(0, 10) : '',
    });
  });
  return { filas, errores };
}
