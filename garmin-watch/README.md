# garmin-watch — RR Probe (Fase 0)

App Connect IQ mínima para responder la pregunta de la Fase 0 del
módulo reloj (ver `docs/connect-iq-module.md`):

**¿El Instinct 3 expone intervalos RR (heartBeatIntervals) sin grabar
una actividad?**

## Qué hace

- Registra `Sensor.registerSensorDataListener` con
  `:heartBeatIntervals => {:enabled => true}` (periodo 4 s).
- En pantalla: BPM actual, si llega RR o no, intervalos recibidos
  totales y por minuto, y los últimos 6 intervalos en ms
  (un valor ≥ ~1800 ms es una pausa visible).

## Compilar

Necesita el Connect IQ SDK (9.x) y una developer key (`devkey.der`,
en `~/.Garmin/ConnectIQ/` o la que se genere — nunca en el repo):

```bash
$CIQ_SDK/bin/monkeyc -d instinct3amoled45mm \
  -f monkey.jungle -o bin/rr-probe.prg -y devkey.der -e
```

`-e` genera el `.iq` instalable. Para probar en otro modelo, cambia
`-d` y añade el `<iq:product>` al manifest si falta.

## Instalar en el reloj (sideload)

1. Reloj por USB al ordenador → se monta como disco `GARMIN`.
2. Copiar el `.prg` (o el `.iq`) a `GARMIN/Apps`.
3. Desconectar, abrir la app "RR Probe" en el reloj.

## Leer el resultado

- `RR: SI` + contador/min creciendo → el camino FIT/nocturno es
  viable → Fase 1.
- `RR: NO llega RR` o pantalla fija → el Instinct 3 solo da RR en
  actividad grabada → el diseño pasa a "grabar actividad noche".
