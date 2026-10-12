"""Build a small extension-only release; no browser profiles or demo data."""
from pathlib import Path
import hashlib
import json
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
source = root / 'extension'
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8-sig'))
release = root / 'release'
release.mkdir(exist_ok=True)
archive = release / f"sudoku-journal-{manifest['version']}.zip"
allowed_suffixes = {'.json', '.js', '.html', '.css', '.png'}
files = sorted(path for path in source.rglob('*') if path.is_file())
for file in files:
    if file.is_symlink() or file.suffix not in allowed_suffixes:
        raise RuntimeError(f'Unexpected package file: {file.relative_to(source)}')
with ZipFile(archive, 'w', compression=ZIP_DEFLATED, compresslevel=9) as zipped:
    for file in files:
        zipped.write(file, file.relative_to(source).as_posix())
with ZipFile(archive) as zipped:
    assert zipped.testzip() is None
    assert 'manifest.json' in zipped.namelist()
    assert len(zipped.namelist()) == len(files)
    for file in files:
        assert zipped.read(file.relative_to(source).as_posix()) == file.read_bytes()
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(release / 'SHA256SUMS.txt').write_text(f'{digest}  {archive.name}\n', encoding='ascii')
report = {'version':manifest['version'], 'files':len(files), 'unpackedBytes':sum(file.stat().st_size for file in files),
          'zipBytes':archive.stat().st_size, 'sha256':digest, 'path':str(archive)}
(release / 'build.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
