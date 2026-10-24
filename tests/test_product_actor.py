import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('actor',Path(__file__).parents[1]/'actors/product-specs/main.py')
actor=importlib.util.module_from_spec(spec);spec.loader.exec_module(actor)
class ProductActorTests(unittest.TestCase):
    def test_extracts_only_published_units(self):
        result=actor.extract('https://www.rei.com/product/demo','<script type="application/ld+json">{"@type":"Product","name":"Bottle","weight":{"value":450,"unitCode":"GRM"},"depth":{"value":2,"unitCode":"INH"},"width":{"value":5,"unitCode":"CMT"},"height":{"value":20,"unitCode":"CMT"}}</script>')
        self.assertEqual(result['weightKg'],.45);self.assertEqual(result['dimensionsCm'],[5.08,5.0,20.0])
    def test_missing_dimensions_not_invented(self):
        result=actor.extract('https://www.nike.com/demo','<title>Shoes</title>')
        self.assertIsNone(result['weightKg']);self.assertIsNone(result['dimensionsCm']);self.assertEqual(result['title'],'Shoes')
    def test_private_and_unapproved_urls_rejected(self):
        for url in ['http://amazon.com/a','https://localhost/a','https://127.0.0.1/a','https://amazon.com.evil.test/a','https://user:pass@amazon.com/a','https://amazon.com:9000/a']:
            with self.assertRaises(ValueError):actor.validate(url)
    def test_unknown_unit_is_unknown(self):
        self.assertIsNone(actor.measurement({'value':12,'unitText':'unknown'},'weight'))
    def test_bad_source_values_are_unknown(self):
        for value in [{'value':0.01,'unitCode':'GRM'},{'value':'inf','unitCode':'KGM'},{'value':float('inf'),'unitCode':'KGM'},{'value':'nan','unitCode':'KGM'},{'value':True,'unitCode':'KGM'},'0.0001g']:
            self.assertIsNone(actor.measurement(value,'weight'),value)
    def test_overflow_after_unit_scaling_is_unknown(self):
        self.assertIsNone(actor.measurement({'value':1e307,'unitCode':'MTR'},'length'))
    def test_infinity_literal_yields_valid_json(self):
        import json
        result=actor.extract('https://www.rei.com/p','<script type="application/ld+json">{"@type":"Product","name":"Tent","weight":{"value":Infinity,"unitCode":"KGM"}}</script>')
        self.assertIsNone(result['weightKg']);json.dumps(result,allow_nan=False)
    def test_odd_type_values_do_not_crash(self):
        for t in ['null','3','{"x":1}']:
            result=actor.extract('https://www.rei.com/p','<title>Page</title><script type="application/ld+json">{"@type":'+t+',"name":"X"}</script>')
            self.assertEqual(result['title'],'Page')
        result=actor.extract('https://www.rei.com/p','<script type="application/ld+json">{"@type":["Thing","Product"],"name":"Pack"}</script>')
        self.assertEqual(result['title'],'Pack')
if __name__=='__main__':unittest.main()
