import unittest
import json
import subprocess
import sys
import uuid
from pathlib import Path

from generate_trade_pdf import (
    escape_paragraph_text,
    generate_report,
    normalize_score,
    score_grade,
    trade_signal,
)


class GenerateTradePdfTests(unittest.TestCase):
    def test_normalize_score_clamps_and_defaults(self):
        self.assertEqual(normalize_score("88.5"), 88.5)
        self.assertEqual(normalize_score("-10"), 0.0)
        self.assertEqual(normalize_score("500"), 100.0)
        self.assertEqual(normalize_score("oops", default=42), 42.0)

    def test_score_mappings_use_normalized_values(self):
        self.assertEqual(score_grade(normalize_score("85")), "A+")
        self.assertEqual(trade_signal(normalize_score("54.9")), "CAUTION")

    def test_escape_paragraph_text_escapes_markup(self):
        self.assertEqual(
            escape_paragraph_text('<b>Buy & Hold</b>'),
            "&lt;b&gt;Buy &amp; Hold&lt;/b&gt;",
        )

    def test_generate_report_accepts_string_scores_and_markup_text(self):
        data = {
            "ticker": "sol",
            "company_name": "<b>Solana & Co</b>",
            "overall_score": "72",
            "categories": {
                "Technical <Breakout>": {"score": "81", "weight": "25%"},
                "Risk": {"score": "oops", "weight": "75%"},
            },
            "technical": {
                "indicators": [
                    {
                        "indicator": "RSI",
                        "value": "62",
                        "interpretation": "<script>alert(1)</script>",
                    }
                ]
            },
        }

        temp_root = Path(__file__).resolve().parent / ".tmp-tests"
        temp_root.mkdir(exist_ok=True)
        output_path = temp_root / f"report-{uuid.uuid4().hex}.pdf"
        try:
            result = generate_report(data, str(output_path))
            self.assertEqual(Path(result), output_path)
            self.assertTrue(output_path.exists())
            self.assertGreater(output_path.stat().st_size, 0)
        finally:
            output_path.unlink(missing_ok=True)

    def test_cli_reads_utf8_json_input(self):
        temp_root = Path(__file__).resolve().parent / ".tmp-tests"
        temp_root.mkdir(exist_ok=True)
        input_path = temp_root / f"input-{uuid.uuid4().hex}.json"
        output_path = temp_root / f"report-{uuid.uuid4().hex}.pdf"
        data = {
            "ticker": "BTC",
            "company_name": "Bitcoin",
            "overall_score": 67,
            "utf8_marker": "right quote \u201d and check \u2705",
        }
        try:
            with input_path.open("w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)

            result = subprocess.run(
                [sys.executable, str(Path(__file__).resolve().parent / "generate_trade_pdf.py"), str(input_path), str(output_path)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output_path.exists())
            self.assertGreater(output_path.stat().st_size, 0)
        finally:
            input_path.unlink(missing_ok=True)
            output_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
