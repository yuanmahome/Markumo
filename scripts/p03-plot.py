"""Static figures from archived observations, with every run shown."""
import argparse
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--packages', help='Optional directory containing matplotlib/numpy')
args = parser.parse_args()
if args.packages:
    sys.path.insert(0, str(Path(args.packages).resolve()))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parents[1]
out = root / 'docs/performance'
qa = root / 'test-results/p03'
qa.mkdir(parents=True, exist_ok=True)
data = json.loads((out / 'p03-release-results-20261029.json').read_text(encoding='utf-8'))
matplotlib.rcParams.update({'svg.hashsalt': 'markumo-p03-20261029', 'font.size': 10})
colors = {'p03-base': '#707b87', 'p03-final': '#087e8b', 'nomo': '#b45a23'}
labels = {'p03-base': 'Markumo before', 'p03-final': 'Markumo patch', 'nomo': 'Nomo reference'}
groups = {(g['label'], g['scene']): g for g in data['groups']}
MIB = 1048576

def points(ax, x, stat, color, label=None, scale=MIB):
    if not stat or not stat['n']:
        return
    median, low, high = [stat[k] / scale for k in ('median', 'min', 'max')]
    ax.errorbar([x], [median], yerr=[[median-low], [high-median]], fmt='o', capsize=4, color=color, label=label)
    ax.scatter([x + (i-(stat['n']-1)/2)*.035 for i in range(stat['n'])], [v/scale for v in stat['raw']], color=color, s=13, alpha=.65)

scenes = ['blank', '1kb', '100kb', '1mb', '4mb', 'tabs20']
fig, axes = plt.subplots(1, 2, figsize=(12.8, 4.8), constrained_layout=True)
for index, label in enumerate(colors):
    for x, scene in enumerate(scenes):
        stage = groups[(label, scene)]['stages'].get('loaded', {})
        points(axes[0], x+(index-1)*.2, stage.get('roles', {}).get('Total', {}).get('private'), colors[label], labels[label] if x == 0 else None)
        points(axes[1], x+(index-1)*.2, stage.get('heapUsed'), colors[label], labels[label] if x == 0 else None)
for ax, title in zip(axes, ['Process-tree Private Bytes', 'JS Heap Used (no forced GC)']):
    ax.set_xticks(range(len(scenes)), ['Blank', '1 KiB', '100 KiB', '1 MiB', '4 MiB', '20 tabs'])
    ax.set_ylabel('MiB'); ax.set_title(title); ax.grid(axis='y', alpha=.2); ax.legend(fontsize=8)
fig.suptitle('Frozen Windows Release comparison: median, min/max and individual runs (n=3)')
fig.savefig(out / 'p03-small-text-20261029.svg', metadata={'Date': None})
fig.savefig(qa / 'p03-small-text-20261029.png', dpi=130)
plt.close(fig)

fig, axes = plt.subplots(1, 2, figsize=(12.8, 4.8), constrained_layout=True)
for ax, scene in zip(axes, ['100kb', '4mb']):
    for label, color in colors.items():
        stages = groups[(label, scene)]['stages']
        x, y = [], []
        for seconds in [0, 1, 5, 15]:
            stat = stages.get(f'closed-{seconds*1000}', {}).get('roles', {}).get('Total', {}).get('private')
            if stat:
                points(ax, seconds, stat, color)
                x.append(seconds); y.append(stat['median']/MIB)
        ax.plot(x, y, color=color, label=labels[label])
        cold = stages.get('cold', {}).get('roles', {}).get('Total', {}).get('private')
        if cold:
            ax.axhline(cold['median']/MIB, linestyle='--', linewidth=.8, color=color, alpha=.65)
    ax.set_title(f'{scene}: closing the last document')
    ax.set_xlabel('Seconds after close (actual timestamps archived)'); ax.set_ylabel('Process-tree Private MiB')
    ax.grid(alpha=.2); ax.legend(fontsize=8)
fig.suptitle('Natural close curves; dashed lines = fresh-process cold medians; no GC or heap snapshots')
fig.savefig(out / 'p03-close-curves-20261029.svg', metadata={'Date': None})
fig.savefig(qa / 'p03-close-curves-20261029.png', dpi=130)
plt.close(fig)
for name in ['p03-small-text-20261029.svg', 'p03-close-curves-20261029.svg']:
    file = out / name
    file.write_text('\n'.join(line.rstrip() for line in file.read_text(encoding='utf-8').splitlines()) + '\n', encoding='utf-8')
print('Wrote p03-small-text-20261029.svg and p03-close-curves-20261029.svg')
