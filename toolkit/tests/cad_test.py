"""Regression for mirrored block coordinates, distinct instances and source preservation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import ezdxf

spec = importlib.util.spec_from_file_location('cad_reader', Path(__file__).resolve().parents[1] / 'cad/read.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class SourceInspection(unittest.TestCase):
    def test_mirror_and_instance_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'mirror.dxf'
            doc = ezdxf.new()
            doc.units = 4
            block = doc.blocks.new('door')
            arc = block.add_arc((0, 0), 100, 0, 90)
            doc.modelspace().add_blockref('door', (1000, 2000), dxfattribs={'xscale': -1})
            doc.modelspace().add_blockref('door', (3000, 2000))
            doc.modelspace().add_text('净高 2900', dxfattribs={'height': 120, 'insert': (0, 0)})
            doc.saveas(source)
            before = source.read_bytes()
            result = reader.inspect(source)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(len(result['issues']), 0)
            arcs = [e for e in result['entities'] if e['type'] == 'ARC']
            self.assertEqual(len(arcs), 2)
            self.assertNotEqual(arcs[0]['id'], arcs[1]['id'])
            self.assertEqual(arcs[0]['handle'], arc.dxf.handle)
            first = arcs[0]['points']
            self.assertAlmostEqual(min(p[0] for p in first), 900)
            self.assertAlmostEqual(max(p[0] for p in first), 1000)
            self.assertAlmostEqual(min(p[1] for p in first), -2100)
            self.assertAlmostEqual(max(p[1] for p in first), -2000)
            self.assertEqual(result['entities'][-1]['text'], '净高 2900')


if __name__ == '__main__':
    unittest.main()
