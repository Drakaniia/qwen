import json
import sys
import unittest
from pathlib import Path

from path_setup import *

import media_candidates
import media_resolver


class MediaCandidateRuleTests(unittest.TestCase):
    def test_candidate_rules_match_resolver_reuse_contract(self):
        rules = json.loads((ROOT_DIR / "tests" / "fixtures" / "media_candidate_rules.json").read_text(encoding="utf-8"))

        for rule in rules:
            with self.subTest(rule=rule["name"]):
                self.assertEqual(
                    media_candidates.classify_media_url(rule["url"], rule["contentType"]),
                    rule["format"],
                )
                self.assertEqual(
                    media_candidates.is_reusable_media_url(rule["url"], rule["contentType"]),
                    rule["reusable"],
                )
                self.assertEqual(
                    media_resolver.classify_media_url(rule["url"], rule["contentType"]),
                    rule["format"],
                )
                self.assertEqual(
                    media_resolver.is_reusable_media_url(rule["url"], rule["contentType"]),
                    rule["reusable"],
                )


if __name__ == "__main__":
    unittest.main()
