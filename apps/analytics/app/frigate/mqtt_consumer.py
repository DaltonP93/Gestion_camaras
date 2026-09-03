# apps/analytics/app/frigate/mqtt_consumer.py
# OPCIONAL: consumo en tiempo real de `frigate/events` vía MQTT.
#
# `paho-mqtt` (EPL/EDL) NO se agrega a requirements.txt para no arriesgar el gate
# de licencias del servicio; se importa de forma PEREZOSA dentro de la función.
# Si no está instalado, este modo loguea un error y NO arranca (el servicio sigue
# vivo). Para usar MQTT hay que instalar paho-mqtt aparte:
#
#     pip install paho-mqtt
#
# El transporte por defecto sigue siendo HTTP polling (client.py), que no requiere
# dependencias nuevas.
from __future__ import annotations

import json
import logging
import threading
from typing import Any, Callable

log = logging.getLogger("analytics.frigate.mqtt")


def run_mqtt_consumer(
    settings: Any,
    on_event: Callable[[dict], Any],
    stop_event: threading.Event,
) -> None:
    """Suscribe a `frigate/events` y llama `on_event(dict)` por cada mensaje.

    Import perezoso de paho: si falta, loguea y retorna sin arrancar. Los mensajes
    de `frigate/events` traen el wrapper `{"type","before","after"}`; se reenvían
    tal cual a `on_event` (plan_events maneja new/update/end).
    """
    try:
        import paho.mqtt.client as mqtt  # import perezoso — NO es dependencia fija
    except Exception:  # noqa: BLE001
        log.error(
            "frigate_mqtt_unavailable: paho-mqtt no está instalado. "
            "Instalar 'paho-mqtt' o usar FRIGATE_INGEST_MODE=http. Modo MQTT no arranca."
        )
        return

    host = getattr(settings, "frigate_mqtt_host", "") or ""
    port = int(getattr(settings, "frigate_mqtt_port", 1883))
    topic = getattr(settings, "frigate_mqtt_topic", "frigate/events") or "frigate/events"
    if not host:
        log.error("frigate_mqtt_no_host: FRIGATE_MQTT_HOST vacío — modo MQTT no arranca.")
        return

    def _on_connect(client: Any, _userdata: Any, _flags: Any, rc: Any, *args: Any) -> None:
        if rc == 0:
            client.subscribe(topic)
            log.info("frigate_mqtt_connected topic=%s", topic)
        else:
            log.error("frigate_mqtt_connect_failed rc=%s", rc)

    def _on_message(_client: Any, _userdata: Any, msg: Any) -> None:
        try:
            payload = msg.payload.decode("utf-8") if isinstance(msg.payload, (bytes, bytearray)) else msg.payload
            event = json.loads(payload)
        except Exception as exc:  # noqa: BLE001
            log.warning("frigate_mqtt_bad_payload err=%s", exc)
            return
        if isinstance(event, dict):
            try:
                on_event(event)
            except Exception:  # noqa: BLE001
                log.exception("frigate_mqtt_process_error")

    try:
        client = mqtt.Client()
    except Exception:  # noqa: BLE001 — paho>=2 cambió la firma del constructor
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)  # type: ignore[attr-defined]
    client.on_connect = _on_connect
    client.on_message = _on_message

    try:
        client.connect(host, port, keepalive=60)
    except Exception as exc:  # noqa: BLE001
        log.error("frigate_mqtt_connect_error host=%s err=%s", host, exc)
        return

    client.loop_start()
    try:
        stop_event.wait()
    finally:
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:  # noqa: BLE001
            pass
        log.info("frigate_mqtt_stopped")
