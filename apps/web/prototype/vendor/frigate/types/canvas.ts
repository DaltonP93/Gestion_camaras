/*
 * Portado desde Frigate v0.18.0 (commit 77a66e75c61862b048a07c1295877f4b31343504)
 * Archivo original: web/src/types/canvas.ts
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
export type PolygonType = "zone" | "motion_mask" | "object_mask";

export type Polygon = {
  typeIndex: number;
  camera: string;
  name: string;
  type: PolygonType;
  objects: string[];
  points: number[][];
  pointsOrder?: number[];
  distances: number[];
  isFinished: boolean;
  color: number[];
  friendly_name?: string;
  enabled?: boolean;
  enabled_in_config?: boolean;
  polygonSource?: "base" | "profile" | "override";
};

export type ZoneFormValuesType = {
  name: string;
  friendly_name: string;
  enabled: boolean;
  inertia: number;
  loitering_time: number;
  isFinished: boolean;
  objects: string[];
  speedEstimation: boolean;
  lineA: number;
  lineB: number;
  lineC: number;
  lineD: number;
  speed_threshold: number;
};

export type MotionMaskFormValuesType = {
  name: string;
  friendly_name: string;
  enabled: boolean;
  isFinished: boolean;
};

export type ObjectMaskFormValuesType = {
  name: string;
  friendly_name: string;
  enabled: boolean;
  objects: string;
  isFinished: boolean;
};
