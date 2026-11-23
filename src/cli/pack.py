"""Package generated deliverables inside the output directory, excluding archives and history."""
from pathlib import Path
import argparse, zipfile

p = argparse.ArgumentParser()
p.add_argument('directory')
p.add_argument('--out')
p.add_argument('--name')
a = p.parse_args()
root = Path(a.directory).resolve()
if not root.is_dir():
    p.error('Output directory does not exist; build first.')
default_target = root / ((a.name or root.name) + '-交付.zip')
target = Path(a.out).resolve() if a.out else default_target
target.parent.mkdir(parents=True, exist_ok=True)
tmp = target.with_name(target.name + '.tmp')

with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in root.rglob('*'):
        if not f.is_file() or f.suffix == '.zip' or 'history' in f.relative_to(root).parts:
            continue
        z.write(f, Path(root.name) / f.relative_to(root))
with zipfile.ZipFile(tmp) as z:
    assert z.testzip() is None
tmp.replace(target)
print(target)
