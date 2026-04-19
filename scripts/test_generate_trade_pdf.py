import unittest
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


if __name__ == "__main__":
    unittest.main()
