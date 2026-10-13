# Instalación de RR Probe en el Instinct 3 — pasos detallados

Fase 0 del módulo Connect IQ (ver `docs/connect-iq-module.md`).
Objetivo: saber si el reloj expone intervalos RR fuera de una
actividad grabada.

## 1. Qué necesitas

- El fichero **`rr-probe-instinct3amoled45mm.prg`** (compilado para el
  Instinct 3 AMOLED 45 mm — está en `garmin-watch/bin/` del repo o en
  los adjuntos de la sesión de Devin del 13/10/2026).
- Cable USB del reloj (el de carga) + un PC, **o** un cable USB-C /
  adaptador OTG para copiarlo desde el propio móvil.

## 2. Instalar

### Desde PC
1. Conecta el reloj por USB al PC. Espera unos segundos: aparece como
   una unidad de disco llamada `GARMIN` (o `INSTINCT`).
2. Abre la carpeta **`GARMIN/Apps`** dentro de esa unidad.
3. Copia `rr-probe-instinct3amoled45mm.prg` ahí (arrastrar y soltar).
4. Expulsa la unidad y desconecta el reloj.

### Desde el móvil (si no hay PC)
1. Conecta el reloj al móvil con un cable USB-C ↔ el conector del
   reloj (o adaptador OTG).
2. En la app **Archivos** del móvil aparecerá la unidad del reloj.
3. Copia el `.prg` a `GARMIN/Apps` igual que en PC.
4. Desconecta.

## 3. Probar

1. En el reloj: botón de menú → busca **"RR Probe"** en la lista de
   aplicaciones actividades → ábrela.
2. La pantalla muestra:
   - **BPM actual** (tu frecuencia en vivo)
   - **RR: SI / NO llega RR** ← la respuesta que buscamos
   - **tot N /min N** — cuántos intervalos RR van llegando
   - **Los últimos 6 intervalos en ms** — si sale un valor ~1800+,
     es una pausa capturada
   - línea de estado abajo
3. Déjala abierta 2–3 minutos (el RR puede tardar un poco en arrancar;
   quédate quieto, luz baja ayuda al sensor óptico).
4. Sal con el botón BACK.

## 4. Qué me cuentas

- `RR: SI` o `RR: NO` — y una foto de la pantalla si puedes.
- Si da SI: Fase 1 (grabador nocturno con FIT) es viable.
- Si da NO: el diseño cambia a grabar una "actividad noche".

## 5. Recompilar (para Devin, si hace falta)

```bash
SDK=~/.Garmin/ConnectIQ/Sdks/connectiq-sdk-lin-9.2.0-2026-06-09-92a1605b2
cd garmin-watch
$SDK/bin/monkeyc -d instinct3amoled45mm \
  -f monkey.jungle -o bin/rr-probe.prg -y /home/ubuntu/devkey.der
```

SDK ya instalado en la VM + devices descargados + devkey.der generada
(fuera del repo). Login del SDK Manager ya hecho con la cuenta Garmin.
