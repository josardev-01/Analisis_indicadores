// Calendario económico. La app original lo sirve desde su propia API (con
// sourceProvider "forexfactory"); acá se lee el feed semanal público de
// ForexFactory y se adapta a la misma forma de respuesta.
//
// Diferencias conocidas con el original: el feed público no trae el dato real
// publicado (`actual` queda siempre en null) ni el análisis por IA, y sólo
// cubre la semana en curso.

const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const VIGENCIA_MS = 60 * 60 * 1000;

let cache = { en: 0, eventos: null };

const limpio = (valor) => {
  const t = String(valor ?? '').trim();
  return t === '' ? null : t;
};

/** Convierte una fila del feed a la forma de evento que consume el dashboard. */
export function adaptarEvento(fila, indice) {
  const fecha = new Date(fila.date);
  if (Number.isNaN(fecha.getTime())) return null;
  return {
    id: indice + 1,
    sourceProvider: 'forexfactory',
    country: String(fila.country ?? '').toUpperCase().slice(0, 4),
    eventName: String(fila.title ?? '').slice(0, 120),
    impact: String(fila.impact ?? ''),
    scheduledAt: fecha.toISOString(),
    previous: limpio(fila.previous),
    forecast: limpio(fila.forecast),
    actual: null,
  };
}

export function filtrarEventos(eventos, { from, to, impact } = {}) {
  const desde = from ? new Date(from).getTime() : -Infinity;
  const hasta = to ? new Date(to).getTime() : Infinity;
  return eventos.filter((e) => {
    const t = new Date(e.scheduledAt).getTime();
    return t >= desde && t <= hasta && (!impact || e.impact.toLowerCase() === impact.toLowerCase());
  });
}

/** Devuelve los eventos de la semana. Cachea una hora; si el feed falla, lanza. */
export async function eventosSemana(ahora = Date.now()) {
  if (cache.eventos && ahora - cache.en < VIGENCIA_MS) return cache.eventos;
  const respuesta = await fetch(FEED, { signal: AbortSignal.timeout(10_000) });
  if (!respuesta.ok) throw new Error(`El feed respondió ${respuesta.status}`);
  const filas = await respuesta.json();
  if (!Array.isArray(filas)) throw new Error('El feed no devolvió una lista');
  const eventos = filas.map(adaptarEvento).filter(Boolean);
  cache = { en: ahora, eventos };
  return eventos;
}
