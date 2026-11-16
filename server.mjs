// Servidor de Bitácora: sirve el frontend estático y una API JSON con el mismo
// contrato de lectura que se observó en el dashboard original (ver README).
// Sin dependencias externas: sólo módulos de Node.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Almacen } from './lib/almacen.mjs';
import { eventosSemana, filtrarEventos } from './lib/calendario-economico.mjs';
import { datosDemo } from './lib/demo.mjs';
import {
  diasCalendario,
  enriquecerCuentas,
  hoyLocal,
  parsearCsv,
  puntajeConsistencia,
  redondear2,
  resumenDashboard,
} from './lib/metricas.mjs';

const RAIZ = fileURLToPath(new URL('.', import.meta.url));
const PUBLICO = resolve(RAIZ, 'public');
const PUERTO = Number(process.env.PORT ?? 4173);
const LIMITE_CUERPO = 2 * 1024 * 1024;

const PLATAFORMAS = ['MANUAL', 'MT5', 'MT4', 'CTRADER', 'NINJATRADER', 'TOPSTEPX', 'TRADELOCKER', 'TRADOVATE', 'PAPER'];
const TIPOS_CUENTA = ['', 'broker', 'propfirm', 'challenge', 'demo'];
const ESTADOS = ['ACTIVE', 'INACTIVE'];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

const TIPOS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class ErrorHttp extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

const almacen = new Almacen(process.env.BITACORA_DATOS ?? join(RAIZ, 'datos', 'db.json'));

function responderJson(res, estado, cuerpo) {
  const texto = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
  });
  res.end(texto);
}

async function leerJson(req) {
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > LIMITE_CUERPO) throw new ErrorHttp(413, 'El cuerpo supera el límite de 2 MB.');
    partes.push(parte);
  }
  if (total === 0) return {};
  try {
    const cuerpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
    if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) throw new Error('no es objeto');
    return cuerpo;
  } catch {
    throw new ErrorHttp(400, 'El cuerpo no es un JSON válido.');
  }
}

// ---------- Validación de entradas ----------

function texto(valor, campo, { max = 80, obligatorio = false } = {}) {
  const t = String(valor ?? '').trim();
  if (obligatorio && !t) throw new ErrorHttp(400, `Falta el campo "${campo}".`);
  if (t.length > max) throw new ErrorHttp(400, `"${campo}" supera los ${max} caracteres.`);
  return t;
}

function numero(valor, campo, { min = -Infinity } = {}) {
  const n = typeof valor === 'number' ? valor : Number(String(valor ?? '').trim() || NaN);
  if (!Number.isFinite(n)) throw new ErrorHttp(400, `"${campo}" debe ser un número.`);
  if (n < min) throw new ErrorHttp(400, `"${campo}" no puede ser menor que ${min}.`);
  return redondear2(n);
}

function opcion(valor, campo, permitidos, porDefecto) {
  const v = valor === undefined || valor === null ? porDefecto : String(valor);
  if (!permitidos.includes(v)) throw new ErrorHttp(400, `"${campo}" debe ser uno de: ${permitidos.filter(Boolean).join(', ')}.`);
  return v;
}

function fecha(valor, campo) {
  const f = String(valor ?? '').trim();
  const d = new Date(`${f}T12:00:00`);
  if (!FECHA.test(f) || Number.isNaN(d.getTime()) || hoyLocal(d) !== f) {
    throw new ErrorHttp(400, `"${campo}" debe ser una fecha AAAA-MM-DD válida.`);
  }
  return f;
}

function cuentaPorId(id) {
  const cuenta = almacen.datos.cuentas.find((c) => c.id === id);
  if (!cuenta) throw new ErrorHttp(404, 'La cuenta no existe.');
  return cuenta;
}

function entero(parametros, nombre) {
  const crudo = parametros.get(nombre);
  if (crudo === null || crudo === '') return undefined;
  const n = Number(crudo);
  if (!Number.isInteger(n)) throw new ErrorHttp(400, `"${nombre}" debe ser un entero.`);
  return n;
}

// ---------- Rutas de la API ----------

const rutas = [
  // Lectura: mismo contrato que el dashboard original.
  ['GET', /^\/api\/accounts$/, ({ parametros }) => {
    const estado = parametros.get('status');
    const { cuentas, operaciones, movimientos } = almacen.datos;
    const filtradas = estado ? cuentas.filter((c) => c.status === estado) : cuentas;
    return { success: true, accounts: enriquecerCuentas(filtradas, operaciones, movimientos) };
  }],
  ['GET', /^\/api\/dashboard\/summary$/, ({ parametros }) => {
    const months = entero(parametros, 'months') ?? 6;
    if (months < 1 || months > 60) throw new ErrorHttp(400, '"months" debe estar entre 1 y 60.');
    return resumenDashboard(almacen.datos, {
      months,
      calendarYear: entero(parametros, 'calendarYear'),
      calendarMonth: entero(parametros, 'calendarMonth'),
    });
  }],
  ['GET', /^\/api\/dashboard\/calendar$/, ({ parametros }) => {
    const anio = entero(parametros, 'year');
    const mes0 = entero(parametros, 'month');
    if (anio === undefined || mes0 === undefined || mes0 < 0 || mes0 > 11) {
      throw new ErrorHttp(400, 'Se necesita "year" y "month" (0 a 11).');
    }
    const activas = new Set(almacen.datos.cuentas.filter((c) => c.status === 'ACTIVE').map((c) => c.id));
    const ops = almacen.datos.operaciones.filter((o) => activas.has(o.accountId));
    const movs = almacen.datos.movimientos.filter((m) => activas.has(m.accountId));
    return { success: true, calendarDays: diasCalendario(ops, movs, anio, mes0), calendarYear: anio, calendarMonth: mes0 };
  }],
  ['GET', /^\/api\/metrics\/tn-score$/, ({ parametros }) => {
    const cuentaId = parametros.get('accountId') ?? 'all';
    const activas = new Set(almacen.datos.cuentas.filter((c) => c.status === 'ACTIVE').map((c) => c.id));
    const ops = almacen.datos.operaciones.filter((o) =>
      cuentaId === 'all' ? activas.has(o.accountId) : o.accountId === cuentaId,
    );
    return puntajeConsistencia(ops);
  }],
  ['GET', /^\/api\/economic-calendar$/, async ({ parametros }) => {
    let eventos;
    try {
      eventos = await eventosSemana();
    } catch (error) {
      throw new ErrorHttp(502, `No se pudo leer el calendario económico: ${error.message}`);
    }
    return {
      success: true,
      events: filtrarEventos(eventos, {
        from: parametros.get('from'),
        to: parametros.get('to'),
        impact: parametros.get('impact'),
      }),
    };
  }],

  // Escritura: propia de la réplica (el original se alimenta de brókers).
  ['POST', /^\/api\/accounts$/, async ({ cuerpo }) => {
    const cuenta = {
      id: randomUUID(),
      name: texto(cuerpo.name, 'name', { obligatorio: true }),
      platform: opcion(cuerpo.platform, 'platform', PLATAFORMAS, 'MANUAL'),
      broker: texto(cuerpo.broker, 'broker'),
      accountType: opcion(cuerpo.accountType, 'accountType', TIPOS_CUENTA, ''),
      status: 'ACTIVE',
      balance: numero(cuerpo.balance, 'balance', { min: 0 }),
      createdAt: new Date().toISOString(),
    };
    almacen.datos.cuentas.push(cuenta);
    await almacen.guardar();
    return { success: true, account: cuenta };
  }],
  ['PATCH', /^\/api\/accounts\/([^/]+)$/, async ({ cuerpo, ids }) => {
    const cuenta = cuentaPorId(ids[0]);
    if ('name' in cuerpo) cuenta.name = texto(cuerpo.name, 'name', { obligatorio: true });
    if ('platform' in cuerpo) cuenta.platform = opcion(cuerpo.platform, 'platform', PLATAFORMAS);
    if ('broker' in cuerpo) cuenta.broker = texto(cuerpo.broker, 'broker');
    if ('accountType' in cuerpo) cuenta.accountType = opcion(cuerpo.accountType, 'accountType', TIPOS_CUENTA);
    if ('balance' in cuerpo) cuenta.balance = numero(cuerpo.balance, 'balance', { min: 0 });
    if ('status' in cuerpo) cuenta.status = opcion(cuerpo.status, 'status', ESTADOS);
    await almacen.guardar();
    return { success: true, account: cuenta };
  }],
  // Igual que el original: "eliminar" desactiva la cuenta y conserva sus datos.
  ['DELETE', /^\/api\/accounts\/([^/]+)$/, async ({ ids }) => {
    cuentaPorId(ids[0]).status = 'INACTIVE';
    await almacen.guardar();
    return { success: true };
  }],
  ['POST', /^\/api\/accounts\/([^/]+)\/operations$/, async ({ cuerpo, ids }) => {
    const cuenta = cuentaPorId(ids[0]);
    const operacion = {
      id: randomUUID(),
      accountId: cuenta.id,
      date: fecha(cuerpo.date, 'date'),
      symbol: texto(cuerpo.symbol, 'symbol', { max: 20 }).toUpperCase(),
      side: opcion(cuerpo.side, 'side', ['', 'buy', 'sell'], ''),
      pnl: numero(cuerpo.pnl, 'pnl'),
    };
    almacen.datos.operaciones.push(operacion);
    await almacen.guardar();
    return { success: true, operation: operacion };
  }],
  ['POST', /^\/api\/accounts\/([^/]+)\/operations\/import$/, async ({ cuerpo, ids }) => {
    const cuenta = cuentaPorId(ids[0]);
    const { filas, errores } = parsearCsv(cuerpo.csv);
    for (const fila of filas) almacen.datos.operaciones.push({ id: randomUUID(), accountId: cuenta.id, ...fila });
    if (filas.length > 0) await almacen.guardar();
    return { success: filas.length > 0, imported: filas.length, rejected: errores.length, errors: errores.slice(0, 20) };
  }],
  ['POST', /^\/api\/accounts\/([^/]+)\/movements$/, async ({ cuerpo, ids }) => {
    const cuenta = cuentaPorId(ids[0]);
    const movimiento = {
      id: randomUUID(),
      accountId: cuenta.id,
      date: fecha(cuerpo.date, 'date'),
      type: opcion(cuerpo.type, 'type', ['deposit', 'withdrawal']),
      amount: numero(cuerpo.amount, 'amount', { min: 0.01 }),
    };
    almacen.datos.movimientos.push(movimiento);
    await almacen.guardar();
    return { success: true, movement: movimiento };
  }],
  // Datos de ejemplo: sólo sobre una base vacía, para no pisar datos reales.
  ['POST', /^\/api\/demo$/, async () => {
    if (almacen.datos.cuentas.length > 0) throw new ErrorHttp(409, 'Ya hay cuentas cargadas; restablecé los datos antes.');
    await almacen.reemplazar(datosDemo());
    return { success: true, accounts: almacen.datos.cuentas.length, operations: almacen.datos.operaciones.length };
  }],
  ['POST', /^\/api\/reset$/, async ({ cuerpo }) => {
    if (cuerpo.confirm !== 'BORRAR') throw new ErrorHttp(400, 'Falta la confirmación.');
    await almacen.reemplazar({});
    return { success: true };
  }],
];

/**
 * La API no tiene login, así que se protege de páginas ajenas abiertas en el
 * mismo navegador: el Host debe ser local (frena DNS rebinding) y toda escritura
 * debe venir como JSON y desde este mismo origen (frena formularios cruzados).
 */
function verificarOrigen(req) {
  const locales = [`127.0.0.1:${PUERTO}`, `localhost:${PUERTO}`];
  if (!locales.includes(req.headers.host ?? '')) throw new ErrorHttp(403, 'Host no permitido.');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new ErrorHttp(415, 'Las escrituras deben enviarse como application/json.');
  }
  const origen = req.headers.origin;
  if (origen && !locales.some((h) => origen === `http://${h}`)) throw new ErrorHttp(403, 'Origen no permitido.');
}

async function atenderApi(req, res, url) {
  verificarOrigen(req);
  for (const [metodo, patron, manejador] of rutas) {
    if (req.method !== metodo) continue;
    const coincidencia = patron.exec(url.pathname);
    if (!coincidencia) continue;
    const cuerpo = metodo === 'GET' ? {} : await leerJson(req);
    const ids = coincidencia.slice(1).map(decodeURIComponent);
    return responderJson(res, 200, await manejador({ parametros: url.searchParams, cuerpo, ids }));
  }
  throw new ErrorHttp(404, 'Ruta no encontrada.');
}

async function atenderEstatico(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new ErrorHttp(405, 'Método no permitido.');
  const relativa = url.pathname === '/' || url.pathname === '/dashboard' ? 'index.html' : decodeURIComponent(url.pathname);
  const destino = resolve(PUBLICO, `.${sep}${normalize(relativa)}`);
  if (destino !== PUBLICO && !destino.startsWith(PUBLICO + sep)) throw new ErrorHttp(403, 'Ruta fuera del sitio.');
  let contenido;
  try {
    contenido = await readFile(destino);
  } catch {
    throw new ErrorHttp(404, 'Archivo no encontrado.');
  }
  res.writeHead(200, {
    'Content-Type': TIPOS_MIME[extname(destino)] ?? 'application/octet-stream',
    'Content-Length': contenido.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : contenido);
}

const servidor = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await atenderApi(req, res, url);
    else await atenderEstatico(req, res, url);
  } catch (error) {
    const estado = error instanceof ErrorHttp ? error.estado : 500;
    if (estado === 500) console.error(error);
    responderJson(res, estado, { success: false, error: estado === 500 ? 'Error interno.' : error.message });
  }
});

await almacen.cargar();
// Sólo loopback: la API no tiene autenticación y no debe quedar expuesta en la red.
servidor.listen(PUERTO, '127.0.0.1', () => {
  console.log(`Bitácora escuchando en http://127.0.0.1:${PUERTO}`);
});
