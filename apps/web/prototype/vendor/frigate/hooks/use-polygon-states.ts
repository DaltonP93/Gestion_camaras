/*
 * Portado desde Frigate v0.18.0 (commit 77a66e75c61862b048a07c1295877f4b31343504)
 * Archivo original: web/src/hooks/use-polygon-states.ts
 * Cambios de portado: NINGUNO (copia literal debajo de este encabezado;
 * verificable con scripts/verify-port.sh).
 *
 * The MIT License
 *
 * Copyright (c) 2026 Frigate, Inc. (Frigate™)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* ---- fin del encabezado de portado ---- */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Polygon } from "@/types/canvas";
import { subscribeWsTopic, getWsTopicValue } from "@/api/ws";

/**
 * Hook to get enabled state for a polygon from websocket state.
 * Subscribes to all relevant per-polygon topics so it only re-renders
 * when one of those specific topics changes — not on every WS update.
 */
export function usePolygonStates(polygons: Polygon[]) {
  // Build a stable sorted list of topics we need to watch
  const topics = useMemo(() => {
    const set = new Set<string>();
    polygons.forEach((polygon) => {
      const topic =
        polygon.type === "zone"
          ? `${polygon.camera}/zone/${polygon.name}/state`
          : polygon.type === "motion_mask"
            ? `${polygon.camera}/motion_mask/${polygon.name}/state`
            : `${polygon.camera}/object_mask/${polygon.name}/state`;
      set.add(topic);
    });
    return Array.from(set).sort();
  }, [polygons]);

  // Stable key for the topic list so subscribe/getSnapshot stay in sync
  const topicsKey = topics.join("\0");

  // Subscribe to all topics at once — re-subscribe only when the set changes
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = topicsKey
        .split("\0")
        .filter(Boolean)
        .map((topic) => subscribeWsTopic(topic, listener));
      return () => unsubscribes.forEach((unsub) => unsub());
    },
    [topicsKey],
  );

  // Build a snapshot string from the current values of all topics.
  // useSyncExternalStore uses Object.is, so we return a primitive that
  // changes only when an observed topic's value changes.
  const getSnapshot = useCallback(() => {
    return topicsKey
      .split("\0")
      .filter(Boolean)
      .map((topic) => `${topic}=${getWsTopicValue(topic) ?? ""}`)
      .join("\0");
  }, [topicsKey]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  // Parse the snapshot into a lookup map
  return useMemo(() => {
    // Build value map from snapshot
    const valueMap = new Map<string, unknown>();
    snapshot.split("\0").forEach((entry) => {
      const eqIdx = entry.indexOf("=");
      if (eqIdx > 0) {
        const topic = entry.slice(0, eqIdx);
        const val = entry.slice(eqIdx + 1) || undefined;
        valueMap.set(topic, val);
      }
    });

    const stateMap = new Map<string, boolean>();
    polygons.forEach((polygon) => {
      const topic =
        polygon.type === "zone"
          ? `${polygon.camera}/zone/${polygon.name}/state`
          : polygon.type === "motion_mask"
            ? `${polygon.camera}/motion_mask/${polygon.name}/state`
            : `${polygon.camera}/object_mask/${polygon.name}/state`;

      const wsValue = valueMap.get(topic);
      const enabled =
        wsValue === "ON"
          ? true
          : wsValue === "OFF"
            ? false
            : (polygon.enabled ?? true);
      stateMap.set(
        `${polygon.camera}/${polygon.type}/${polygon.name}`,
        enabled,
      );
    });

    return (polygon: Polygon) => {
      return (
        stateMap.get(`${polygon.camera}/${polygon.type}/${polygon.name}`) ??
        true
      );
    };
  }, [polygons, snapshot]);
}
