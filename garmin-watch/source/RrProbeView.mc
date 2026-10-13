import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Sensor;
import Toybox.System;
import Toybox.Time;
import Toybox.Timer;
import Toybox.WatchUi;

// Vista principal: registra el listener de datos de sensor a alta
// frecuencia pidiendo heartBeatIntervals y vuelca a pantalla lo que
// llega — basta para responder la pregunta de la Fase 0:
// ¿el Instinct 3 expone RR sin actividad grabada?
class RrProbeView extends WatchUi.View {

    private var _timer as Timer.Timer?;
    private var _bpm as Number or Null = null;
    private var _rrCountTotal as Number = 0;
    private var _rrCountMinute as Number = 0;
    private var _rrRecent as Array<Number> = [];
    private var _lastTick as Number = 0;
    private var _minuteStart as Number = 0;
    private var _status as String = "esperando...";
    private var _supported as String = "?";

    function initialize() {
        View.initialize();
        _minuteStart = Time.now().value();
        _timer = new Timer.Timer();
        (_timer as Timer.Timer).start(method(:onTick), 1000, true);

        // Alta frecuencia: pedimos heartBeatIntervals. :period máx 4 s.
        var options = {
            :period => 4,
            :heartBeatIntervals => { :enabled => true }
        };
        try {
            Sensor.registerSensorDataListener(method(:onSensorData), options);
            _status = "listener OK";
        } catch (e) {
            _status = "ERROR: " + e.getErrorMessage();
            _supported = "NO";
        }
    }

    function onTick() as Void {
        var now = Time.now().value();
        _lastTick = now;
        if (now - _minuteStart >= 60) {
            _minuteStart = now;
            _rrCountMinute = 0;
        }
        WatchUi.requestUpdate();
    }

    function onSensorData(data as Sensor.SensorData) as Void {
        var info = Sensor.getInfo();
        if (info != null && info.heartRate != null) {
            _bpm = info.heartRate;
        }
        var hr = data.heartRateData;
        if (hr == null) {
            _status = "heartRateData null";
            return;
        }
        var intervals = hr.heartBeatIntervals;
        if (intervals != null && intervals.size() > 0) {
            _supported = "SI";
            _rrCountTotal += intervals.size();
            _rrCountMinute += intervals.size();
            var keep = 6;
            for (var i = 0; i < intervals.size(); i++) {
                _rrRecent.add(intervals[i]);
            }
            while (_rrRecent.size() > keep) {
                _rrRecent = _rrRecent.slice(1, null);
            }
            _status = "RR llegando";
        } else {
            _supported = "NO llega RR";
            _status = "BPM si, RR vacio";
        }
        WatchUi.requestUpdate();
    }

    function onUpdate(dc as Dc) as Void {
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);

        var w = dc.getWidth();
        var cx = w / 2;
        var y = 8;
        var lh = 22;

        dc.drawText(cx, y, Graphics.FONT_TINY, "RR Probe", Graphics.TEXT_JUSTIFY_CENTER);
        y += lh;

        dc.drawText(cx, y, Graphics.FONT_LARGE,
            _bpm != null ? _bpm + " bpm" : "-- bpm",
            Graphics.TEXT_JUSTIFY_CENTER);
        y += lh + 10;

        dc.drawText(cx, y, Graphics.FONT_SMALL, "RR: " + _supported,
            Graphics.TEXT_JUSTIFY_CENTER);
        y += lh;

        dc.drawText(cx, y, Graphics.FONT_SMALL,
            "tot " + _rrCountTotal + " /min " + _rrCountMinute,
            Graphics.TEXT_JUSTIFY_CENTER);
        y += lh;

        // últimos intervalos en ms — si aparece un 2000+, ahí hay pausa
        var rr = "";
        for (var i = 0; i < _rrRecent.size(); i++) {
            rr += _rrRecent[i] + " ";
        }
        dc.drawText(cx, y, Graphics.FONT_XTINY, rr,
            Graphics.TEXT_JUSTIFY_CENTER);
        y += lh;

        dc.drawText(cx, y, Graphics.FONT_XTINY, _status,
            Graphics.TEXT_JUSTIFY_CENTER);
    }

    function onHide() as Void {
        Sensor.unregisterSensorDataListener();
    }
}

// Botón único: SELECT alterna nada por ahora; BACK sale.
class RrProbeDelegate extends WatchUi.BehaviorDelegate {
    function initialize() {
        BehaviorDelegate.initialize();
    }
    function onSelect() as Boolean {
        return true;
    }
}
