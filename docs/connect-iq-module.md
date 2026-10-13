# Módulo Connect IQ — roadmap (futuro)

Documento de planificación para la futura app de reloj. **Nada de esto
existe todavía** — es la hoja de ruta para cuando se decida empezar.
Vive en `garmin-watch/` dentro de este repo: mismo proyecto, toolchain
aparte (el móvil no cambia salvo el ingester de datos).

## Por qué

La H10 da RR real por BLE, pero llevar banda todo el día es incómodo.
El reloj ya mide RR continuamente con su sensor óptico — Garmin solo
publica agregados (mín/máx/reposo, VFC resumen) ni por Health Connect
ni por ninguna API. Una app Connect IQ es **la única vía** al RR real
del reloj, latido a latido.

## Hechos verificados (limitan el diseño)

- `Sensor.HeartRateData.heartBeatIntervals` da intervalos beat-to-beat
  en ms dentro de una app de reloj — el dato que necesitamos existe.
- Una app Connect IQ **puede conectarse a sensores BLE, no puede actuar
  como sensor BLE** — el reloj no puede "transmitirse" al móvil como
  una banda. No existe puente RR→móvil ya hecho.
- Las vías reales para sacar el dato:
  1. **FIT en el reloj** → se sincroniza a Garmin Connect como actividad
     → nuestro cliente privado ya lee Connect → descargamos el FIT.
     Camino natural, todo encadena con lo que ya tenemos.
  2. `Communications` API (mensajes reloj↔móvil por BLE): protocolo
     privado de Garmin, rebuscado — descartado salvo que (1) no dé.
  3. El modo "broadcast HR" nativo de algunos modelos retransmite BPM
     por BLE — generalmente sin RR y solo en actividad; insuficiente.
- Publicar en Connect IQ Store: cuenta de desarrollador Garmin gratis,
  firma propia, revisión de Garmin. Sin cuotas.
- Una app se compila por modelo — marcamos Instinct 3 + los que queramos.

## Fases

### Fase 0 — Spike (1-2 días)
- Instalar SDK Monkey C + simulador. App "hola" que lea
  `heartBeatIntervals` y los pinte. Responder: ¿el Instinct 3 da RR
  reales y continuos sin actividad grabada? (punto de no-retorno: si
  solo los da en actividad, el diseño cambia a "modo noche grabado").

### Fase 1 — Grabador nocturno
- App de reloj mínima: inicia/para una grabación (o corre como
  glance/background), escribe RR a un FIT en el reloj.
- Que la grabación sea usable dormido: sin pantalla encendida,
  batería acotada — medir consumo real una noche.

### Fase 2 — Salida del dato
- Confirmar que el FIT llega a Garmin Connect con los intervalos.
- Extender `src/features/garmin/` para descargar y parsear ese FIT
  → convertir a `readings`/`sessions` de nuestra base (fuente "reloj-
  CIQ"). Reutiliza todo el pipeline de detección ya existente.

### Fase 3 — UX y publicación
- Ajustes en la app del reloj (activar/desactivar, marcar noche).
- Firma, revisión Garmin, publicación en Connect IQ Store
  (marcando Instinct 3 + modelos comunes).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Instinct 3 no expone RR fuera de actividad | Fase 0 lo decide antes de invertir |
| FIT de Connect no retiene RR crudo | Fase 2 con fichero real; plan B: Communications API |
| Batería del reloj en grabación toda la noche | Medir en Fase 1; grabar solo ventana nocturna |
| Otro toolchain sin tests/OTA | CIQ tiene simulador; mantener la app mínima |

## No-objetivos

- No reemplaza la H10 (sigue siendo la fuente patrón y la de ECG).
- Nada diagnóstico: mismas frases observacionales que el resto.
