"""Package generated deliverables, excluding prior archives and history."""
from pathlib import Path
import argparse,zipfile
p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--out');a=p.parse_args();root=Path(a.directory).resolve();target=Path(a.out).resolve() if a.out else root.with_suffix('.zip')
if not root.is_dir():p.error('Output directory does not exist; build first.')
target.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
 for f in root.rglob('*'):
  if f.is_file() and f.resolve()!=target and f.suffix!='.zip' and 'history' not in f.relative_to(root).parts:z.write(f,Path(root.name)/f.relative_to(root))
with zipfile.ZipFile(target) as z:assert z.testzip() is None
print(target)
