"""Extract the original HSK hierarchy and ch_animation keyframes.

Usage: python scripts/prepare_characters.py /path/to/Gulman_1_Full
Only numeric rig data and paths relative to the game are emitted. The old
developer-machine paths embedded in HSK files are deliberately not published.
"""
import argparse
import json
from pathlib import Path, PureWindowsPath


def number(value):
    return float(value.replace(',', '.'))


def extract(source):
    characters = {}
    model_root = source / 'Models' / 'Players-nano'
    for file in sorted(model_root.glob('*.HSK')):
        name = file.stem
        folder = model_root / name
        if not folder.is_dir():
            continue
        existing = {p.name.lower(): p for p in folder.iterdir()}
        bones = []
        for index, line in enumerate(file.read_text('cp1251').splitlines()):
            if not line.strip():
                continue
            row = line.split('|')
            model_name = PureWindowsPath(row[19]).name.lower()
            model = existing.get(model_name)
            if model_name != 'mdl' and model is None:
                raise ValueError(f'{file}: missing model {model_name}')
            bone = {
                'id': index + 1,
                'name': row[0],
                'position': list(map(number, row[1:4])),
                'direction': list(map(number, row[4:7])),
                'up': list(map(number, row[7:10])),
                'meshPosition': list(map(number, row[10:13])),
                'meshDirection': list(map(number, row[13:16])),
                'meshUp': list(map(number, row[16:19])),
                'model': model.relative_to(source).as_posix().lower() if model else None,
                'parent': int(row[23]),
                'meshScale': list(map(number, row[24:27])),
            }
            bones.append(bone)
        assert len(bones) == 18, (name, len(bones))
        ids = {b['id'] for b in bones}
        assert all(b['parent'] == 0 or b['parent'] in ids for b in bones)
        characters[name.lower()] = {'name': name, 'bones': bones}
    animations = {}
    for file in sorted((source / 'Anims-GameProgX' / 'man').glob('*.ch_animation')):
        if not file.stem.isascii():  # editor backup, not a shipped named action
            continue
        frames = {}
        for line in file.read_text('cp1251').splitlines():
            if not line.strip():
                continue
            row = line.split('|')
            bone_id, frame_id = map(int, row[:2])
            frame = frames.setdefault(frame_id, {'durationTicks': int(row[8]), 'bones': {}})
            direction, up = list(map(number, row[2:5])), list(map(number, row[5:8]))
            # A zero vector is an unchanged-bone marker, not a rotation.
            if sum(v * v for v in direction) > 0.1 and sum(v * v for v in up) > 0.1:
                frame['bones'][str(bone_id)] = {'direction': direction, 'up': up}
        animations[file.stem.lower()] = [frames[k] for k in sorted(frames) if frames[k]['bones']]
    return {
        'formatVersion': 1,
        'source': 'Gulman_1_Full: Models/Players-nano/*.HSK; Anims-GameProgX/man/*.ch_animation',
        'notes': 'Original rig/keyframe data; browser timing and interpolation are reconstructed.',
        'characters': characters,
        'animations': animations,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'assets' / 'characters.json')
    args = parser.parse_args()
    result = extract(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"Extracted {len(result['characters'])} original rigs and {len(result['animations'])} animations to {args.output}")
