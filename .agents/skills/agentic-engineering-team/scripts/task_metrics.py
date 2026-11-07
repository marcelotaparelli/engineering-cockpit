#!/usr/bin/env python3
"""Registro local e relatório de métricas de tasks. Entrada é manual; não consulta Codex."""
import argparse
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path

TIERS = ("quick", "standard", "critical")

def positive_number(n):
    value = float(n)
    if value < 0:
        raise argparse.ArgumentTypeError("valor deve ser >= 0")
    return value

def integer(n):
    value = int(n)
    if value < 0:
        raise argparse.ArgumentTypeError("valor deve ser >= 0")
    return value

def record(args):
    data = {"task_id": args.id, "tier": args.tier, "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "duration_sec": args.duration_sec, "input_tokens": args.input_tokens,
            "output_tokens": args.output_tokens, "ci_pass_first_try": args.ci_pass,
            "rework": args.rework}
    if args.cached_tokens is not None:
        if args.input_tokens is None:
            raise ValueError("cached_tokens requer input_tokens observado")
        if args.cached_tokens > args.input_tokens:
            raise ValueError("cached_tokens nao pode exceder input_tokens")
        data["cached_tokens"] = args.cached_tokens
    args.file.parent.mkdir(parents=True, exist_ok=True)
    with args.file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Registro local salvo: {args.id}")

def report(args):
    if not args.file.is_file():
        print("Sem registros ainda.")
        return
    rows = []
    for index, line in enumerate(args.file.read_text(encoding="utf-8").splitlines(), start=1):
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"JSONL inválido na linha {index}: {exc}")
    if not rows:
        print("Sem registros ainda.")
        return
    durations = [float(r["duration_sec"]) for r in rows if r.get("duration_sec") is not None]
    measured = [r for r in rows if isinstance(r.get("input_tokens"), int) and isinstance(r.get("output_tokens"), int)]
    totals = [r["input_tokens"] + r["output_tokens"] for r in measured]
    cis = [r["ci_pass_first_try"] for r in rows if r.get("ci_pass_first_try") in ("yes", "no")]
    print(f"Tasks: {len(rows)} | Com tokens medidos: {len(measured)}")
    print(f"Mediana duração: {statistics.median(durations):.1f}s" if durations else "Duração: não medida")
    print(f"Mediana tokens observados: {statistics.median(totals):.0f}" if totals else "Tokens: não medidos")
    print(f"CI first-pass: {sum(v=='yes' for v in cis)}/{len(cis)}" if cis else "CI first-pass: não medido")
    print(f"Média de ciclos de retrabalho: {statistics.mean(r['rework'] for r in rows):.2f}")
    print("Nota: cached_tokens não são adicionados ao total; podem integrar input_tokens.")

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="cmd", required=True)
    add = subs.add_parser("record", help="Registrar números OBSERVADOS")
    add.add_argument("--file", type=Path, required=True)
    add.add_argument("--id", required=True)
    add.add_argument("--tier", choices=TIERS, required=True)
    add.add_argument("--duration-sec", type=positive_number, required=True)
    add.add_argument("--input-tokens", type=integer)
    add.add_argument("--output-tokens", type=integer)
    add.add_argument("--cached-tokens", type=integer)
    add.add_argument("--ci-pass", choices=("yes", "no", "unknown"), default="unknown")
    add.add_argument("--rework", type=integer, default=0)
    summ = subs.add_parser("report", help="Resumo agregado")
    summ.add_argument("--file", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.cmd == "record":
        record(args)
    elif args.cmd == "report":
        report(args)

if __name__ == "__main__":
    main()
