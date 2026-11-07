#!/usr/bin/env python3
"""Registro manual/externamente observado de invocações agênticas (sem SDK ou rede).

Não ingere prompts, código, comandos, usuários nem tokens de autenticação.
Evite rodar em arquivos JSONL não confiáveis ou acessíveis publicamente.
"""
import argparse
import json
import math
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def nonnegative_int(v):
    try:
        n = int(v)
    except ValueError as e:
        raise argparse.ArgumentTypeError('inteiro >= 0 esperado') from e
    if n < 0:
        raise argparse.ArgumentTypeError('inteiro >= 0 esperado')
    return n


def nonnegative_float(v):
    try:
        n = float(v)
    except ValueError as e:
        raise argparse.ArgumentTypeError('numero >= 0 esperado') from e
    if not math.isfinite(n) or n < 0:
        raise argparse.ArgumentTypeError('numero finito >= 0 esperado')
    return n


def rows_from_file(path):
    if not path.exists():
        return []
    rows = []
    ids = set()
    for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            raise ValueError(f'JSONL invalido na linha {number}') from e
        run_id = row.get('run_id')
        if not isinstance(run_id, str) or not run_id:
            raise ValueError(f'run_id ausente na linha {number}')
        if run_id in ids:
            raise ValueError(f'run_id duplicado no arquivo: {run_id}')
        ids.add(run_id)
        rows.append(row)
    return rows


def record(args):
    if (args.cached_input_tokens is not None and args.input_tokens is None):
        raise ValueError('cached_input_tokens requer input_tokens observado')
    if args.cached_input_tokens is not None and args.cached_input_tokens > args.input_tokens:
        raise ValueError('cached_input_tokens nao pode exceder input_tokens')
    if args.cost_usd is not None and not args.cost_source:
        raise ValueError('cost_usd requer cost_source (invoice ou official_rate)')
    if args.cost_usd is None and args.cost_source:
        raise ValueError('cost_source requer cost_usd')
    if any(len(v) > 120 or not v or any(c in v for c in '\r\n') for v in (args.task_id,args.run_id,args.agent,args.model,args.source)):
        raise ValueError('identificadores devem ser curtos, nao vazios e sem newline')
    if args.run_id in {r['run_id'] for r in rows_from_file(args.file)}:
        raise ValueError(f'run_id ja registrado: {args.run_id}')
    data = {'timestamp_utc': datetime.now(timezone.utc).isoformat(),
            'task_id': args.task_id, 'run_id': args.run_id,
            'agent_role': args.agent, 'model': args.model,
            'source': args.source, 'status': args.status,
            'input_tokens': args.input_tokens, 'output_tokens': args.output_tokens,
            'cached_input_tokens': args.cached_input_tokens,
            'duration_ms': args.duration_ms, 'retries': args.retries,
            'cost_usd': args.cost_usd, 'cost_source': args.cost_source}
    args.file.parent.mkdir(parents=True, exist_ok=True)
    with args.file.open('a', encoding='utf-8') as f:
        f.write(json.dumps(data, ensure_ascii=False, separators=(',',':')) + '\n')
    print(f'OK: run {args.run_id} registrado (campos ausentes = nao medidos)')


def report(args):
    rows = rows_from_file(args.file)
    if not rows:
        print('Sem invocacoes registradas.')
        return
    tasks = defaultdict(list)
    agents = defaultdict(list)
    for r in rows:
        tasks[r['task_id']].append(r)
        agents[r['agent_role']].append(r)
    complete_token_rows = [r for r in rows if r.get('input_tokens') is not None and r.get('output_tokens') is not None]
    complete_cost_rows = [r for r in rows if r.get('cost_usd') is not None]
    duration_rows = [r['duration_ms'] for r in rows if r.get('duration_ms') is not None]
    print(f'Tarefas: {len(tasks)} | Invocacoes: {len(rows)} | Com tokens: {len(complete_token_rows)} | Com custo: {len(complete_cost_rows)}')
    print(f'Input total observado: {sum(r["input_tokens"] for r in rows if r.get("input_tokens") is not None)} (parcial se houver ausentes)')
    print(f'Output total observado: {sum(r["output_tokens"] for r in rows if r.get("output_tokens") is not None)} (parcial se houver ausentes)')
    print(f'Cached input: {sum(r["cached_input_tokens"] for r in rows if r.get("cached_input_tokens") is not None)} (subset; NAO adicionar a input)')
    print(f'Custo USD observado: {sum(r["cost_usd"] for r in complete_cost_rows):.4f} (parcial; NAO tratar como total se ha ausentes)')
    if duration_rows:
        print(f'Duracao mediana por invocacao: {statistics.median(duration_rows):.0f} ms')
    print('Agentes (invocacoes / tokens input+output medidos / custo USD conhecido / faltantes):')
    for agent, ar in sorted(agents.items()):
        nr = [r for r in ar if r.get('input_tokens') is not None and r.get('output_tokens') is not None]
        known_cost = [r for r in ar if r.get('cost_usd') is not None]
        t = sum(r['input_tokens']+r['output_tokens'] for r in nr)
        c = sum(r['cost_usd'] for r in known_cost)
        print(f'  {agent}: {len(ar)} / {t} / ${c:.4f} / tokens {len(ar)-len(nr)}, custo {len(ar)-len(known_cost)}')
    print('Nao imputar valores ausentes e nao comparar assinatura com cobranca API.')


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    subs = p.add_subparsers(dest='action', required=True)
    rec = subs.add_parser('record', help='Registrar invocacao com valores observados')
    rec.add_argument('--file', type=Path, required=True)
    rec.add_argument('--task-id', required=True)
    rec.add_argument('--run-id', required=True)
    rec.add_argument('--agent', required=True)
    rec.add_argument('--model', required=True)
    rec.add_argument('--source', required=True, help='Proveniencia dos campos (ex: codex_export, provider_invoice, manual_observed)')
    rec.add_argument('--status', choices=['success','failed','blocked','cancelled'], required=True)
    rec.add_argument('--input-tokens', type=nonnegative_int)
    rec.add_argument('--output-tokens', type=nonnegative_int)
    rec.add_argument('--cached-input-tokens', type=nonnegative_int)
    rec.add_argument('--duration-ms', type=nonnegative_int)
    rec.add_argument('--retries', type=nonnegative_int, default=0)
    rec.add_argument('--cost-usd', type=nonnegative_float)
    rec.add_argument('--cost-source', choices=['invoice','official_rate'])
    rep = subs.add_parser('report', help='Resumo por agente e tarefa, sem estimar dados ausentes')
    rep.add_argument('--file', type=Path, required=True)
    a = p.parse_args(argv)
    if a.action == 'record': record(a)
    else: report(a)

if __name__ == '__main__':
    main()
