import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

// HeartMonitor RR probe — Fase 0 spike.
// Abre la app en el reloj: en pantalla muestra si el sensor óptico
// entrega intervalos RR (heartBeatIntervals) fuera de una actividad,
// el BPM actual y cuántos intervalos llegan por minuto.
class RrProbeApp extends Application.AppBase {

    function initialize() {
        AppBase.initialize();
    }

    function onStart(state as Dictionary?) as Void {
    }

    function onStop(state as Dictionary?) as Void {
    }

    function getInitialView() as [Views] or [Views, InputDelegates] {
        return [new RrProbeView(), new RrProbeDelegate()];
    }
}
