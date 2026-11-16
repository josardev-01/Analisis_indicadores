// Formato de números. Reproduce las reglas observadas en el dashboard original:
// separadores estilo europeo (1.234,56), signo explícito en el PnL y una banda
// muerta de ±0,5 antes de pintar un valor como ganancia o pérdida.

/** Número con separadores 1.234,56; "—" si no es finito. */
export function fmt(n, decimales = 2) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('de-DE', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
}

export function fmtMoneda(n, decimales = 2) {
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}$${fmt(Math.abs(n), decimales)}`;
}

/** Moneda con signo: +$10,00 / -$10,00; el cero va sin signo. */
export function fmtConSigno(n, decimales = 2) {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return `$${fmt(0, decimales)}`;
  return `${n > 0 ? '+' : '-'}$${fmt(Math.abs(n), decimales)}`;
}

export function fmtPorcentaje(n, decimales = 1) {
  return Number.isFinite(n) ? `${fmt(n, decimales)}%` : '—';
}

/** Monto compacto para etiquetas de depósito/retiro: +$2k, -$300. */
export function fmtCompacto(n) {
  const abs = Math.abs(Number(n) || 0);
  return `${n < 0 ? '-' : '+'}$${abs >= 1000 ? `${(abs / 1000).toFixed(0)}k` : fmt(abs, 0)}`;
}

/** Clase de color del PnL. Entre −0,5 y +0,5 se considera neutro. */
export function clasePnl(n) {
  if (n > 0.5) return 'ganancia';
  if (n < -0.5) return 'perdida';
  return 'neutro';
}

/** Escapa texto antes de interpolarlo en HTML. */
export function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Descompone 'AAAA-MM-DD' sin pasar por Date (evita corrimientos de zona horaria). */
export function partesFecha(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(texto));
  if (!m) return null;
  const [anio, mes0, dia] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (mes0 < 0 || mes0 > 11 || dia < 1 || dia > 31) return null;
  return { anio, mes0, dia };
}

/** Fecha local de hoy como 'AAAA-MM-DD'. */
export function hoyLocal(ahora = new Date()) {
  return `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
}
