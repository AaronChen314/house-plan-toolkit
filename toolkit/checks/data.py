"""Validate a normalized space-model JSON or a project config, without changing it."""
from pathlib import Path
import argparse
import json
from jsonschema import Draft202012Validator
from shapely.geometry import Polygon
from shapely.validation import explain_validity


def validate(data):
    root = Path(__file__).resolve().parents[1] / 'schemas'
    kind = 'project' if data.get('schema') == 'space-project/v1' else 'space-model'
    schema = json.loads((root / (kind + '.schema.json')).read_text())
    issues = [{'object': '/'.join(map(str, e.absolute_path)), 'message': e.message}
              for e in Draft202012Validator(schema).iter_errors(data)]
    count = 0
    if issues or kind == 'project':
        return {'passed': not issues, 'polygons': count, 'issues': issues}
    for floor in data['floors']:
        polygons = []
        for key in ('slab', 'outdoor', 'walls', 'columns', 'roofSlab'):
            polygons.extend((f'{key}:{i}', p) for i, p in enumerate(floor.get(key, [])))
        polygons.extend((f'tread:{i}', p.get('polygon', p)) for i, p in enumerate(floor.get('treads', [])))
        for item in floor.get('furniture', []):
            polygons.extend((f'furniture:{item["id"]}:{i}', p) for i, p in enumerate(item['footprint']))
        polygons.extend((f'window:{w["id"]}', w['footprint']) for w in floor.get('windowOpenings', []))
        for i, zone in enumerate(floor.get('ceilingZones', [])):
            polygons.extend((f'ceiling:{i}:{j}', p) for j, p in enumerate(zone['footprint']))
        for name, p in polygons:
            count += 1
            shape = Polygon(p['outer'], p.get('holes', []))
            if not shape.is_valid or shape.area <= 0:
                issues.append({'object': floor['id'] + ':' + name, 'message': explain_validity(shape)})
    return {'passed': not issues, 'polygons': count, 'issues': issues}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file')
    parser.add_argument('--out')
    args = parser.parse_args()
    result = validate(json.loads(Path(args.file).read_text()))
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + '\n')
    print(text)
    raise SystemExit(0 if result['passed'] else 1)
