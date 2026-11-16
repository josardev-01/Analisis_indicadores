// Pruebas de las métricas del dashboard. Correr con: node --test

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adaptarEvento, filtrarEventos } from '../lib/calendario-economico.mjs';
import { datosDemo } from '../lib/demo.mjs';
import {
  curvaEquity,
  diasCalendario,
  enriquecerCuenta,
  parsearCsv,
  parsearNumero,
  puntajeConsistencia,
  restarMeses,
  resumenDashboard,
} from '../lib/metricas.mjs';

const cuenta = { id: 'a', name: 'A', status: 'ACTIVE', balance: 1000, createdAt: '2026-09-01T10:00:00' };
const op = (date, pnl, accountId = 'a') => ({ accountId, date, pnl });

test('enriquecerCuenta: cuenta sin operaciones', () => {
  const c = enriquecerCuenta(cuenta);
  assert.equal(c.netProfit, 0);
  assert.equal(c.currentBalance, 1000);
  assert.equal(c.winrate, 0);
  assert.equal(c.profitFactor, 0);
  assert.equal(c.tradeOps, 0);
  assert.deepEqual(c._count, { operations: 0 });
});

test('enriquecerCuenta: neto, winrate, profit factor y rendimiento', () => {
  const ops = [op('2026-10-01', 100), op('2026-10-02', -50), op('2026-10-03', 200), op('2026-10-04', -50)];
  const movs = [{ accountId: 'a', date: '2026-10-05', type: 'deposit', amount: 500 }];
  const c = enriquecerCuenta(cuenta, ops, movs);
  assert.equal(c.netProfit, 200);
  assert.equal(c.currentBalance, 1700); // 1000 + 500 + 200
  assert.equal(c.winrate, 50);
  assert.equal(c.profitFactor, 3); // 300 / 100
  assert.equal(c.rendimientoBase, 1500);
  assert.equal(c.rendimientoPercent, 13.33); // 200 / 1500
});

test('enriquecerCuenta: sin pérdidas el profit factor es el centinela 999.99', () => {
  assert.equal(enriquecerCuenta(cuenta, [op('2026-10-01', 10)]).profitFactor, 999.99);
});

test('diasCalendario: agrupa por día y deja pnl null si sólo hubo movimientos', () => {
  const ops = [op('2026-11-03', 40), op('2026-11-03', -10), op('2026-10-31', 999)];
  const movs = [{ accountId: 'a', date: '2026-11-05', type: 'withdrawal', amount: 300 }];
  assert.deepEqual(diasCalendario(ops, movs, 2026, 10), [
    { date: '2026-11-03', pnl: 30, ops: 2, deposits: [], withdrawals: [] },
    { date: '2026-11-05', pnl: null, ops: 0, deposits: [], withdrawals: [300] },
  ]);
});

test('restarMeses: no se pasa del último día del mes destino', () => {
  assert.equal(restarMeses('2026-11-16', 6), '2026-05-16');
  assert.equal(restarMeses('2026-08-31', 6), '2026-02-28');
  assert.equal(restarMeses('2026-01-15', 2), '2025-11-15');
});

test('curvaEquity: arranca con el balance inicial y acumula', () => {
  const curva = curvaEquity([cuenta], [op('2026-10-01', 100), op('2026-10-01', 50), op('2026-10-10', -30)], [], 6, '2026-11-16');
  assert.deepEqual(curva, [
    { date: '2026-09-01', equity: 1000 },
    { date: '2026-10-01', equity: 1150 },
    { date: '2026-10-10', equity: 1120 },
  ]);
});

test('curvaEquity: lo anterior a la ventana se resume en un punto de partida', () => {
  const vieja = { ...cuenta, createdAt: '2025-01-01T00:00:00' };
  const curva = curvaEquity([vieja], [op('2025-02-01', 200), op('2026-11-02', 50)], [], 6, '2026-11-16');
  assert.deepEqual(curva, [
    { date: '2026-05-16', equity: 1200 },
    { date: '2026-11-02', equity: 1250 },
  ]);
});

test('resumenDashboard: ignora cuentas inactivas y separa el mes en curso', () => {
  const datos = {
    cuentas: [cuenta, { ...cuenta, id: 'b', status: 'INACTIVE' }],
    operaciones: [op('2026-11-02', 80), op('2026-10-20', 40), op('2026-11-03', 500, 'b')],
    movimientos: [],
  };
  const r = resumenDashboard(datos, { hoy: '2026-11-16' });
  assert.equal(r.monthlyPnl, 80);
  assert.deepEqual(r.monthlyByAccount, { a: { pnl: 80, ops: 1 } });
  assert.equal(r.calendarYear, 2026);
  assert.equal(r.calendarMonth, 10);
  assert.equal(r.calendarDays.length, 1);
  assert.equal(r.equityCurve.at(-1).equity, 1120);
});

test('puntajeConsistencia: sin operaciones es 0 y Critico, con nota de muestra', () => {
  const p = puntajeConsistencia([]);
  assert.equal(p.tnScore, 0);
  assert.equal(p.level, 'Critico');
  assert.equal(p.totalTrades, 0);
  assert.ok(p.confidenceNote);
});

test('puntajeConsistencia: una estrategia perdedora queda en 0', () => {
  const ops = Array.from({ length: 40 }, (_, i) => op(`2026-10-${String((i % 28) + 1).padStart(2, '0')}`, -10));
  assert.equal(puntajeConsistencia(ops).tnScore, 0);
});

test('puntajeConsistencia: la misma estrategia puntúa menos con muestra chica', () => {
  const patron = [150, -100, 150, -100, 150]; // 60 % de acierto, PF 2,25
  const generar = (n) => Array.from({ length: n }, (_, i) => op(`2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, patron[i % 5]));
  const chica = puntajeConsistencia(generar(10));
  const grande = puntajeConsistencia(generar(60));
  assert.ok(chica.confidenceNote);
  assert.equal(grande.confidenceNote, undefined);
  assert.ok(grande.tnScore > chica.tnScore, `${grande.tnScore} > ${chica.tnScore}`);
  assert.ok(grande.tnScore > 0 && grande.tnScore <= 100);
  assert.equal(grande.components.winRate, 60);
  assert.equal(grande.components.profitFactor, 2.25);
});

test('parsearNumero: formatos europeos, anglosajones y negativos entre paréntesis', () => {
  assert.equal(parsearNumero('1.234,56'), 1234.56);
  assert.equal(parsearNumero('1,234.56'), 1234.56);
  assert.equal(parsearNumero('-45,5'), -45.5);
  assert.equal(parsearNumero('(45.50)'), -45.5);
  assert.equal(parsearNumero('$ 30'), 30);
  assert.ok(Number.isNaN(parsearNumero('abc')));
  assert.ok(Number.isNaN(parsearNumero('')));
});

test('parsearCsv: lee filas válidas y reporta las rechazadas', () => {
  const csv = 'Fecha;Simbolo;Lado;PnL\n2026-11-03;eurusd;buy;120,50\n04/11/2026;NQ;sell;-80\n2026-13-01;X;buy;10\n2026-11-05;X;buy;nada\n';
  const { filas, errores } = parsearCsv(csv);
  assert.deepEqual(filas, [
    { date: '2026-11-03', pnl: 120.5, symbol: 'EURUSD', side: 'buy' },
    { date: '2026-11-04', pnl: -80, symbol: 'NQ', side: 'sell' },
  ]);
  assert.equal(errores.length, 2);
});

test('parsearCsv: exige las columnas fecha y pnl', () => {
  assert.equal(parsearCsv('a,b\n1,2').filas.length, 0);
  assert.equal(parsearCsv('a,b\n1,2').errores.length, 1);
});

test('calendario económico: adapta y filtra por ventana e impacto', () => {
  const eventos = [
    { title: 'CPI m/m', country: 'CAD', date: '2026-11-16T08:30:00-05:00', impact: 'High', forecast: '0.3%', previous: '0.1%' },
    { title: 'Algo menor', country: 'USD', date: '2026-11-16T10:00:00-05:00', impact: 'Low', forecast: '', previous: '' },
    { title: 'Otro día', country: 'USD', date: '2026-11-18T10:00:00-05:00', impact: 'High', forecast: '', previous: '' },
  ].map(adaptarEvento);
  assert.equal(eventos[0].scheduledAt, '2026-11-16T13:30:00.000Z');
  assert.equal(eventos[1].forecast, null);
  const hoy = filtrarEventos(eventos, { from: '2026-11-16T03:00:00.000Z', to: '2026-11-17T02:59:59.000Z', impact: 'High' });
  assert.deepEqual(hoy.map((e) => e.eventName), ['CPI m/m']);
});

test('datosDemo: es determinista y coherente', () => {
  const a = datosDemo('2026-11-16');
  const b = datosDemo('2026-11-16');
  assert.deepEqual(a, b);
  assert.equal(a.cuentas.length, 3);
  assert.ok(a.operaciones.length > 100);
  const ids = new Set(a.cuentas.map((c) => c.id));
  assert.ok(a.operaciones.every((o) => ids.has(o.accountId) && o.date <= '2026-11-16'));
});
