# Bitácora — réplica funcional de un dashboard de cuentas de trading

Réplica de la **funcionalidad** de la página `/dashboard` de TradingNote, hecha a partir de
ingeniería inversa con [REA](https://github.com/morluto/rea) 6.9.0. El código, el nombre y el
diseño son propios: no se copió código, marca ni logo del original.

## Cómo correrlo

Probado con Node.js 24.19.0 (en versiones anteriores, sin verificar). No tiene dependencias: no
hay `npm install`.

Desde la carpeta del proyecto:

```bash
node server.mjs
```

Abrir <http://127.0.0.1:4173>. Las pruebas se corren con:

```bash
node --test
```

Los datos se guardan en `datos/db.json`. Variables opcionales: `PORT` (puerto) y
`BITACORA_DATOS` (ruta del archivo de datos).

## Qué replica

| Sección del original | En la réplica |
|---|---|
| Encabezado + "Agregar Cuenta" | Igual; el alta de cuenta es un diálogo en la misma página |
| Tarjeta de primer uso (sin cuentas) | Igual, más un botón para cargar datos de ejemplo |
| 5 indicadores: Balance, PnL, Winrate, Ganancia del mes, puntaje | Igual, cada uno con "¿Cómo se calcula?" |
| Tarjetas de cuentas (balance, PnL, winrate, profit factor, rendimiento) | Igual, con menú de acciones |
| Alto impacto hoy (calendario económico) | Igual: hasta 6 eventos, hora local, previo y pronóstico |
| Distribución de balance (dona + leyenda) | Igual; a partir de la 9.ª cuenta se agrupan en "Otras" |
| Top performers del mes (podio de 3 + total) | Igual |
| Evolución del balance consolidado (6 meses) | Línea con cursor y tooltip, más vista de tabla |
| Calendario mensual con PnL diario, depósitos y retiros | Igual, con navegación de meses y totales |
| Barra: menú lateral, idioma ES/EN, tema, pantalla completa | Igual |

## Qué NO replica (fuera de alcance)

- **Conexión a brókers** (MT5, cTrader, TopstepX, etc.): acá las operaciones se cargan a mano o
  por CSV. La plataforma de la cuenta es sólo una etiqueta.
- **PnL en vivo** de posiciones abiertas (el original usa un stream `/api/pnl/stream`).
- El resto de la aplicación: Journal, Live Trading, Copy Trading, Backtesting, etc.
- Login, planes, banner de trial, tours, asistente y afiliados.

## Hallazgos de la ingeniería inversa

Capturado con REA el 2026-11-16 sobre una cuenta nueva (sin cuentas de trading conectadas).

**Llamadas que alimentan el dashboard** (todas `GET`, mismo origen):

| Endpoint | Respuesta observada |
|---|---|
| `/api/accounts?status=ACTIVE&leafOnly=true` | `{success, accounts: []}` |
| `/api/dashboard/summary?months=6&calendarYear=2026&calendarMonth=10` | `{success, monthlyPnl, monthlyByAccount, equityCurve, calendarDays, calendarYear, calendarMonth}` |
| `/api/dashboard/calendar?year=&month=` | `{calendarDays}` (visto en el código; se llama al cambiar de mes) |
| `/api/metrics/tn-score?accountId=all` | `{success, tnScore, level, components: {winRate, profitFactor, expectancy, recoveryFactor}, totalTrades, confidenceNote}` |
| `/api/economic-calendar?from=&to=&impact=High` | `{success, events: [{id, country, eventName, impact, scheduledAt, previous, forecast, actual, …}]}` |

`calendarMonth` va en base 0 (10 = noviembre). La réplica expone estos mismos endpoints con las
mismas formas.

**Reglas del lado del cliente** (leídas del bundle de la página, 56 KB):

- Balance total = Σ `currentBalance` de cada cuenta (o `balance + netProfit` si falta).
- Variación del balance = PnL / (balance − PnL) × 100.
- Winrate global = promedio de winrates ponderado por `tradeOps` de cada cuenta.
- "Ganancia del mes" muestra "—" cuando el mes no tiene operaciones.
- Top del mes: orden por PnL mensual; el porcentaje es PnL mensual / capital base de la cuenta.
- Profit factor `999.99` es el centinela de "sin pérdidas" y se pinta como ∞.
- Calendario: semana de lunes a domingo; un día cuenta como operado sólo si tiene `pnl` no nulo.
- Formato numérico `1.234,56`; el PnL se colorea recién fuera de la banda ±0,5.

## Límites de lo que se pudo observar

- **Puntaje de consistencia: fórmula propia.** El "TN Score" original se calcula en el servidor y
  no es observable. Sólo se vieron sus cuatro componentes, el nivel y que hay un ajuste por
  muestra menor a 30 operaciones. La fórmula de `lib/metricas.mjs` usa esos mismos insumos pero
  **no está verificada contra el original**: con los mismos datos puede dar otro número.
- **Formas de los elementos sin verificar con datos reales.** La cuenta inspeccionada estaba
  vacía, así que `accounts`, `equityCurve`, `calendarDays` y `monthlyByAccount` llegaron sin
  elementos. Sus campos se dedujeron del código del cliente, no de una respuesta real.
- **Calendario económico de otra fuente.** Se usa el feed semanal público de ForexFactory. No
  trae el dato real publicado (`actual` queda vacío) ni el análisis por IA del original, y sólo
  cubre la semana en curso.
- El análisis estático del bundle fue parcial: 1 de 25 scripts superó el límite de 30 s de REA.

## Estructura

```
server.mjs                     servidor HTTP + API (sólo escucha en 127.0.0.1)
lib/metricas.mjs               cálculo de métricas (funciones puras)
lib/almacen.mjs                persistencia en JSON
lib/calendario-economico.mjs   adaptador del feed de eventos
lib/demo.mjs                   datos de ejemplo deterministas
public/                        frontend sin build (HTML, CSS, módulos JS)
test/metricas.test.mjs         16 pruebas
```

## Formato del CSV de operaciones

Encabezado obligatorio. Columnas obligatorias `fecha` y `pnl`; opcionales `simbolo` y `lado`.
Separador coma, punto y coma o tabulador. Fechas `AAAA-MM-DD` o `DD/MM/AAAA`.

```
fecha;simbolo;lado;pnl
2026-11-03;EURUSD;buy;120,50
2026-11-04;NQ;sell;-80
```
