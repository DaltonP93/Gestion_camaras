#!/usr/bin/env python3
# scripts/audit_classify.py
#
# Clasificador PURO (sin red) del JSON de `npm audit --omit=dev --json`. Lee el
# JSON por STDIN y el allowlist por la env `ALLOWLIST` (nombres separados por
# espacio). Es la parte TESTEABLE de la política de auditoría: check-npm-audit.sh
# corre npm y le pasa la salida por stdin.
#
# FAIL-CLOSED por diseño — códigos de salida:
#   0  parseado OK, sin HIGH/CRITICAL de PROD fuera del allowlist.
#   1  hay HIGH/CRITICAL de PROD fuera del allowlist (bloqueante).
#   3  stdin vacío o JSON inválido (no se pudo clasificar ⇒ no dar por seguro).
#   4  npm devolvió un objeto de ERROR (red/registry/permisos): no es "sin vulns".
#   5  schema inesperado (falta la clave "vulnerabilities"): no clasificar a ciegas.
#
# Imprime líneas KNOWN/BLOCK/ERROR para que el wrapper las muestre.

import json
import os
import sys


def main() -> int:
    raw = sys.stdin.read()
    if not raw or not raw.strip():
        print("ERROR empty-stdin (npm audit no devolvió salida)")
        return 3
    try:
        data = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        print("ERROR invalid-json %s" % (str(e)[:120]))
        return 3
    if not isinstance(data, dict):
        print("ERROR unexpected-top-level (no es objeto JSON)")
        return 5
    # npm emite {"error": {...}} ante fallo de red/registry; NO es "sin vulns".
    if "error" in data:
        err = data.get("error")
        summary = err.get("summary") if isinstance(err, dict) else str(err)
        print("ERROR audit-error %s" % (str(summary)[:160]))
        return 4
    # npm v7+ (lockfile v2/v3): clave "vulnerabilities". Si falta, schema inesperado
    # (p. ej. formato v6 "advisories" u otra herramienta) ⇒ no clasificar a ciegas.
    if "vulnerabilities" not in data:
        print("ERROR unexpected-schema (sin clave 'vulnerabilities')")
        return 5
    vulns = data.get("vulnerabilities")
    if not isinstance(vulns, dict):
        print("ERROR unexpected-schema ('vulnerabilities' no es objeto)")
        return 5

    allow = set(os.environ.get("ALLOWLIST", "").split())
    known, blocking = [], []
    for name, v in vulns.items():
        sev = v.get("severity") if isinstance(v, dict) else None
        if sev in ("high", "critical"):
            (known if name in allow else blocking).append((name, sev))

    for name, sev in sorted(set(known)):
        print("KNOWN %s %s" % (sev, name))
    for name, sev in sorted(set(blocking)):
        print("BLOCK %s %s" % (sev, name))

    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
