"""Package an explicit allowlist only; exclude test profiles, screenshots and private state."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

root = Path(__file__).resolve().parent.parent
extension_files = [
    'manifest.json', 'core.js', 'db.js', 'background.js', 'main-hook.js',
    'content.js', 'bridge.html', 'bridge.js', 'ui.css', 'options.html',
    'options.js', 'picker.html', 'picker.js',
]
files = [root / 'extension' / name for name in extension_files]
files += [root / 'README.md', root / 'docs' / 'VERIFICATION.md', root / 'examples' / 'rules.json']
version = json.loads((root / 'extension' / 'manifest.json').read_text(encoding='utf-8'))['version']
release = root / 'release'
release.mkdir(exist_ok=True)
archive = release / f'upload-folder-rules-{version}.zip'
with ZipFile(archive, 'w', ZIP_DEFLATED) as output:
    for file in files:
        output.write(file, file.relative_to(root).as_posix())
with ZipFile(archive) as check:
    assert check.testzip() is None
    assert set(check.namelist()) == {file.relative_to(root).as_posix() for file in files}
    for file in files:
        assert check.read(file.relative_to(root).as_posix()) == file.read_bytes()
manifest = {'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'files': [str(file.relative_to(root)).replace('\\','/') for file in files]}
(release / 'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(manifest,ensure_ascii=False,indent=2))
