// Datos de ejemplo deterministas para ver el dashboard poblado sin cargar nada
// a mano. Las fechas se generan hacia atrás desde "hoy" para que el mes en
// curso y la ventana de 6 meses siempre tengan actividad.

import { hoyLocal, redondear2, restarMeses } from './metricas.mjs';

/** Generador pseudoaleatorio con semilla (mulberry32): mismo resultado siempre. */
function aleatorio(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERFILES = [
  { id: 'demo-fondeo', name: 'Fondeo 50K', platform: 'TOPSTEPX', broker: 'Topstep', accountType: 'propfirm', balance: 50000, acierto: 0.56, riesgo: 260, ratio: 1.5, simbolos: ['NQ', 'ES', 'MNQ'] },
  { id: 'demo-real', name: 'Cuenta Real', platform: 'MT5', broker: 'IC Markets', accountType: 'broker', balance: 8000, acierto: 0.48, riesgo: 70, ratio: 1.9, simbolos: ['EURUSD', 'XAUUSD', 'GBPJPY'] },
  { id: 'demo-swing', name: 'Swing Índices', platform: 'CTRADER', broker: 'Pepperstone', accountType: 'broker', balance: 15000, acierto: 0.41, riesgo: 140, ratio: 1.7, simbolos: ['US500', 'GER40'] },
];

export function datosDemo(hoy = hoyLocal()) {
  const azar = aleatorio(20261116);
  const inicio = restarMeses(hoy, 5);
  const cuentas = [];
  const operaciones = [];
  const movimientos = [];

  // Días hábiles entre el inicio y hoy.
  const dias = [];
  const cursor = new Date(`${inicio}T12:00:00`);
  const fin = new Date(`${hoy}T12:00:00`);
  while (cursor <= fin) {
    const diaSemana = cursor.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) dias.push(hoyLocal(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const perfil of PERFILES) {
    const { acierto, riesgo, ratio, simbolos, ...cuenta } = perfil;
    cuentas.push({ ...cuenta, status: 'ACTIVE', createdAt: `${inicio}T09:00:00` });
    let n = 0;
    for (const dia of dias) {
      if (azar() > 0.45) continue; // no se opera todos los días
      const cantidad = 1 + Math.floor(azar() * 3);
      for (let i = 0; i < cantidad; i += 1) {
        const gana = azar() < acierto;
        const magnitud = riesgo * (0.5 + azar());
        operaciones.push({
          id: `${perfil.id}-op-${(n += 1)}`,
          accountId: perfil.id,
          date: dia,
          symbol: simbolos[Math.floor(azar() * simbolos.length)],
          side: azar() < 0.5 ? 'buy' : 'sell',
          pnl: redondear2(gana ? magnitud * ratio : -magnitud),
        });
      }
    }
  }

  // Un depósito y un retiro dentro del mes en curso, para ver las etiquetas del calendario.
  const esteMes = dias.filter((d) => d.startsWith(hoy.slice(0, 7)));
  if (esteMes.length > 0) {
    movimientos.push({ id: 'demo-mov-1', accountId: 'demo-real', date: esteMes[0], type: 'deposit', amount: 2000 });
    movimientos.push({ id: 'demo-mov-2', accountId: 'demo-fondeo', date: esteMes[esteMes.length - 1], type: 'withdrawal', amount: 1500 });
  }
  return { cuentas, operaciones, movimientos };
}
