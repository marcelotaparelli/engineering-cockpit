import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from task_metrics import main
from validate_skill import validate

class MetricsTests(unittest.TestCase):
    def test_record_report(self):
        with tempfile.TemporaryDirectory() as td:
            path = str(Path(td) / "tasks.jsonl")
            with redirect_stdout(io.StringIO()):
                main(["record", "--file", path, "--id", "foo", "--tier", "quick", "--duration-sec", "12", "--input-tokens", "100", "--output-tokens", "25", "--cached-tokens", "30", "--ci-pass", "yes"])
            stream = io.StringIO()
            with redirect_stdout(stream):
                main(["report", "--file", path])
            self.assertIn("Mediana tokens observados: 125", stream.getvalue())
            self.assertIn("CI first-pass: 1/1", stream.getvalue())
    def test_validate_repo(self):
        repo = Path(__file__).resolve().parents[5]
        self.assertEqual([], validate(repo))

if __name__ == "__main__":
    unittest.main()
