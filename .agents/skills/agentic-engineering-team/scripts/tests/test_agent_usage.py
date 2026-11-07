import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agent_usage import main

class AgentUsageTests(unittest.TestCase):
    def test_roundtrip_per_agent_cost_and_no_double_count_cached(self):
        with tempfile.TemporaryDirectory() as td:
            path = str(Path(td)/'agents.jsonl')
            args = ['record','--file',path,'--task-id','T1','--run-id','R1','--agent','backend_engineer','--model','model-a',
                    '--source','invoice','--status','success','--input-tokens','100','--output-tokens','20',
                    '--cached-input-tokens','50','--cost-usd','0.02','--cost-source','invoice','--duration-ms','1000']
            with redirect_stdout(io.StringIO()):
                main(args)
            with self.assertRaises(ValueError):
                main(args)
            with redirect_stdout(io.StringIO()):
                main(['record','--file',path,'--task-id','T1','--run-id','R2','--agent','test_engineer','--model','model-b',
                      '--source','codex_export','--status','failed','--input-tokens','20','--output-tokens','5'])
            out=io.StringIO()
            with redirect_stdout(out): main(['report','--file',path])
            self.assertIn('Cached input: 50 (subset', out.getvalue())
            self.assertIn('Custo USD observado: 0.0200 (parcial', out.getvalue())
            self.assertIn('Tarefas: 1 | Invocacoes: 2', out.getvalue())
            self.assertIn('Input total observado: 120', out.getvalue())
            rows=[json.loads(x) for x in Path(path).read_text().splitlines()]
            self.assertEqual(2,len(rows))
            self.assertIsNone(rows[1]['cost_usd'])
    def test_invalid_cache_or_unattributed_cost(self):
        with tempfile.TemporaryDirectory() as td:
            base=['record','--file',str(Path(td)/'x.jsonl'),'--task-id','t','--run-id','r','--agent','x','--model','m','--status','success','--source','manual_observed']
            with self.assertRaises(ValueError):
                main(base+['--input-tokens','10','--cached-input-tokens','11'])
            with self.assertRaises(ValueError):
                main(base+['--cost-usd','1.0'])
