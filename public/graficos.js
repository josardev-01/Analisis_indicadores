// Gráficos en SVG sin librerías: dona de distribución y línea de evolución.
// Los colores salen de variables CSS para que sigan al tema claro u oscuro.

import { esc, fmtPorcentaje } from './formato.js';

/** Posiciona el tooltip dentro del contenedor, sin que se salga por los bordes. */
function ubicarTooltip(tooltip, contenedor, x, y) {
  tooltip.hidden = false;
  const maxX = contenedor.clientWidth - tooltip.offsetWidth - 4;
  const izquierda = x + 14 > maxX ? x - tooltip.offsetWidth - 14 : x + 14;
  tooltip.style.left = `${Math.max(4, Math.min(izquierda, maxX))}px`;
  tooltip.style.top = `${Math.max(4, y - tooltip.offsetHeight - 10)}px`;
}

function crearTooltip(contenedor) {
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip-grafico';
  tooltip.hidden = true;
  contenedor.appendChild(tooltip);
  return tooltip;
}

const polar = (cx, cy, radio, angulo) => [cx + radio * Math.sin(angulo), cy - radio * Math.cos(angulo)];

/** Sector de anillo entre dos ángulos (radianes, 0 = arriba, sentido horario). */
function sectorAnillo(cx, cy, interno, externo, desde, hasta) {
  const grande = hasta - desde > Math.PI ? 1 : 0;
  const [x1, y1] = polar(cx, cy, externo, desde);
  const [x2, y2] = polar(cx, cy, externo, hasta);
  const [x3, y3] = polar(cx, cy, interno, hasta);
  const [x4, y4] = polar(cx, cy, interno, desde);
  return `M${x1} ${y1}A${externo} ${externo} 0 ${grande} 1 ${x2} ${y2}L${x3} ${y3}A${interno} ${interno} 0 ${grande} 0 ${x4} ${y4}Z`;
}

/**
 * Dona de partes de un total.
 * @param {HTMLElement} contenedor
 * @param {{name:string,value:number,color:string,percent:number}[]} datos
 * @param {{formatoValor:(n:number)=>string, etiqueta:string}} opciones
 */
export function dibujarDona(contenedor, datos, { formatoValor, etiqueta }) {
  const lado = 240;
  const centro = lado / 2;
  const total = datos.reduce((suma, d) => suma + d.value, 0);
  let angulo = 0;
  const sectores = datos
    .map((d, i) => {
      const barrido = total > 0 ? (d.value / total) * Math.PI * 2 : 0;
      const desde = angulo;
      // Un único sector que ocupa todo el círculo no se puede trazar con un solo arco.
      const hasta = angulo + Math.min(barrido, Math.PI * 2 - 0.0001);
      angulo += barrido;
      return `<path class="sector" data-i="${i}" d="${sectorAnillo(centro, centro, 62, 100, desde, hasta)}" fill="${esc(d.color)}"/>`;
    })
    .join('');
  const resumen = datos.map((d) => `${d.name}: ${formatoValor(d.value)}`).join('; ');
  contenedor.innerHTML = `<svg viewBox="0 0 ${lado} ${lado}" role="img" aria-label="${esc(`${etiqueta}. ${resumen}`)}">${sectores}</svg>`;

  const tooltip = crearTooltip(contenedor);
  contenedor.querySelectorAll('.sector').forEach((sector) => {
    const d = datos[Number(sector.dataset.i)];
    sector.addEventListener('pointermove', (evento) => {
      const caja = contenedor.getBoundingClientRect();
      tooltip.innerHTML = `<span class="tt-titulo"><i style="background:${esc(d.color)}"></i>${esc(d.name)}</span><span class="tt-valor">${esc(formatoValor(d.value))} · ${esc(fmtPorcentaje(d.percent * 100, 1))}</span>`;
      ubicarTooltip(tooltip, contenedor, evento.clientX - caja.left, evento.clientY - caja.top);
    });
    sector.addEventListener('pointerleave', () => {
      tooltip.hidden = true;
    });
  });
}

/** Límites y paso "redondos" para un eje: 1, 2 o 5 por una potencia de 10. */
export function escalaRedonda(minimo, maximo, divisiones = 5) {
  if (minimo === maximo) {
    const margen = Math.abs(minimo) * 0.05 || 1;
    minimo -= margen;
    maximo += margen;
  }
  const bruto = (maximo - minimo) / divisiones;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const paso = [1, 2, 5, 10].map((m) => m * potencia).find((p) => p >= bruto);
  const desde = Math.floor(minimo / paso) * paso;
  const hasta = Math.ceil(maximo / paso) * paso;
  const marcas = [];
  for (let v = desde; v <= hasta + paso / 2; v += paso) marcas.push(Math.round(v * 1e6) / 1e6);
  return { desde, hasta, paso, marcas };
}

const tiempo = (fecha) => new Date(`${fecha}T12:00:00`).getTime();

/**
 * Línea de una sola serie sobre el tiempo, con cursor vertical y tooltip.
 * @param {HTMLElement} contenedor
 * @param {{date:string,equity:number}[]} puntos ordenados por fecha
 * @param {{formatoX:(f:string)=>string, formatoValor:(n:number)=>string, etiqueta:string}} opciones
 */
export function dibujarLinea(contenedor, puntos, { formatoX, formatoValor, etiqueta }) {
  const ancho = Math.max(300, contenedor.clientWidth);
  const alto = 300;
  const margen = { arriba: 12, derecha: 16, abajo: 28, izquierda: 60 };
  const anchoPlano = ancho - margen.izquierda - margen.derecha;
  const altoPlano = alto - margen.arriba - margen.abajo;

  const valores = puntos.map((p) => p.equity);
  const eje = escalaRedonda(Math.min(...valores), Math.max(...valores));
  const t0 = tiempo(puntos[0].date);
  const t1 = tiempo(puntos.at(-1).date);
  const x = (fecha) => margen.izquierda + (t1 === t0 ? anchoPlano / 2 : ((tiempo(fecha) - t0) / (t1 - t0)) * anchoPlano);
  const y = (valor) => margen.arriba + (1 - (valor - eje.desde) / (eje.hasta - eje.desde)) * altoPlano;

  const decimalesEje = eje.paso < 1000 ? 1 : 0;
  const formatoEje = (v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(decimalesEje)}k` : `$${v}`);
  const grilla = eje.marcas
    .map((v) => `<line class="grilla" x1="${margen.izquierda}" x2="${ancho - margen.derecha}" y1="${y(v)}" y2="${y(v)}"/><text class="eje" x="${margen.izquierda - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${esc(formatoEje(v))}</text>`)
    .join('');

  // Marcas del eje X: hasta 6 puntos reales, siempre el primero y el último.
  const cantidad = Math.min(puntos.length, Math.max(2, Math.floor(anchoPlano / 110)));
  const indices = [...new Set(Array.from({ length: cantidad }, (_, i) => Math.round((i * (puntos.length - 1)) / (cantidad - 1))))];
  const marcasX = indices
    .map((i, orden) => {
      const ancla = orden === 0 ? 'start' : orden === indices.length - 1 ? 'end' : 'middle';
      return `<text class="eje" x="${x(puntos[i].date)}" y="${alto - 8}" text-anchor="${ancla}">${esc(formatoX(puntos[i].date))}</text>`;
    })
    .join('');

  const trazo = puntos.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)} ${y(p.equity).toFixed(1)}`).join('');
  const ultimo = puntos.at(-1);
  contenedor.innerHTML = `<svg width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="${esc(`${etiqueta}: ${formatoValor(puntos[0].equity)} → ${formatoValor(ultimo.equity)}`)}">
    ${grilla}${marcasX}
    <path class="linea-serie" d="${trazo}"/>
    <line class="cursor" y1="${margen.arriba}" y2="${margen.arriba + altoPlano}" hidden/>
    <circle class="punto-cursor" r="4.5" hidden/>
    <rect class="zona" x="${margen.izquierda}" y="${margen.arriba}" width="${anchoPlano}" height="${altoPlano}" fill="transparent"/>
  </svg>`;

  const tooltip = crearTooltip(contenedor);
  const cursor = contenedor.querySelector('.cursor');
  const punto = contenedor.querySelector('.punto-cursor');
  const zona = contenedor.querySelector('.zona');
  const posiciones = puntos.map((p) => x(p.date));

  zona.addEventListener('pointermove', (evento) => {
    const caja = contenedor.getBoundingClientRect();
    const px = evento.clientX - caja.left;
    let cercano = 0;
    for (let i = 1; i < posiciones.length; i += 1) {
      if (Math.abs(posiciones[i] - px) < Math.abs(posiciones[cercano] - px)) cercano = i;
    }
    const p = puntos[cercano];
    const cx = posiciones[cercano];
    const cy = y(p.equity);
    cursor.setAttribute('x1', cx);
    cursor.setAttribute('x2', cx);
    punto.setAttribute('cx', cx);
    punto.setAttribute('cy', cy);
    cursor.removeAttribute('hidden');
    punto.removeAttribute('hidden');
    tooltip.innerHTML = `<span class="tt-titulo">${esc(formatoX(p.date, true))}</span><span class="tt-valor">${esc(formatoValor(p.equity))}</span>`;
    ubicarTooltip(tooltip, contenedor, cx, cy);
  });
  zona.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
    cursor.setAttribute('hidden', '');
    punto.setAttribute('hidden', '');
  });
}
