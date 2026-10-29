"""Plot observed medians and full three-run ranges; no fitted plateau claims."""
import csv
import json
import sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
local_packages = root / 'test-results/p01/plot-packages'
if local_packages.exists():
    sys.path.insert(0, str(local_packages))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

destination = root / 'docs/performance'
data = json.loads((destination / 'p01-memory-results-20261028.json').read_text(encoding='utf-8'))
assert len([r for r in data.get('acceptance', []) if r['kind'] == 'Isolated natural acceptance']) == 4, 'Complete all four three-run acceptances before publishing charts'
colors = {'p01-v111': '#526b82', 'p01-v112': '#c77423', 'p01-final': '#18766c', 'p01-main-before': '#a6607c',
          'p01-pre-io': '#8668a2', 'p01-io': '#ae616e', 'p01-fixed': '#3b8b94'}
names = {'p01-v111': 'v1.1.1', 'p01-v112': 'v1.1.2', 'p01-final': 'main 315de6b + fix', 'p01-main-before': 'main 315de6b (clean)',
         'p01-pre-io': '210d878 (before ownership)', 'p01-io': '5515036 (ownership)', 'p01-fixed': 'a9b3c41 + fix'}
final_build = next(r['build'] for r in data['acceptance'] if r['label'] == 'p01-final')
main_commit = (final_build.get('resolvedCommit') or final_build['commit'])[:7]
names['p01-final'] = f'main {main_commit} + fix'
names['p01-main-before'] = f'main {main_commit} (clean)'
runtime = data['acceptance'][0]['runtime']
rows = []


def draw(axis, report, scene, stage, coordinate, include_cold=False):
    groups = {}
    for sample in report['samples']:
        if sample['scene'] != scene:
            continue
        for point in sample['points']:
            if point['stage'] != stage and not (include_cold and point['stage'] == 'cold'):
                continue
            x = point.get(coordinate, 0)
            if coordinate == 'plannedMs':
                x /= 1000
            size = sum(p['private'] for p in point['native']['processes'] if p['role'] != 'Rust') / 1048576
            groups.setdefault(x, []).append(size)
    xs = sorted(groups)
    if not xs:
        return
    assert all(len(groups[x]) == 3 for x in xs), f"Expected three runs: {report['label']} {scene} {stage}"
    medians = [sorted(groups[x])[1] for x in xs]
    axis.plot(xs, medians, label=names[report['label']], color=colors[report['label']], linewidth=2)
    axis.fill_between(xs, [min(groups[x]) for x in xs], [max(groups[x]) for x in xs], color=colors[report['label']], alpha=.12)


def decorate(axes, title, filename, panels):
    for axis, (heading, xlabel) in zip(axes, panels):
        axis.set(title=heading, xlabel=xlabel, ylabel='WebView2 tree Private Bytes (MiB)')
        axis.grid(alpha=.2)
        axis.set_ylim(bottom=0)
        axis.spines[['top', 'right']].set_visible(False)
        axis.legend(frameon=False, fontsize=8)
    fig = axes[0].figure
    fig.suptitle(title, fontsize=11)
    fig.savefig(destination / f'{filename}.svg')
    fig.savefig(root / f'test-results/p01/{filename}.png', dpi=140)
    plt.close(fig)


panels = [('Same Markdown: open / close', 'Completed cycles'),
          ('Mixed code + images: open / switch / close', 'Completed cycles'),
          ('Natural recovery after mixed cycle 240', 'Planned wait after close (seconds)')]
fig, axes = plt.subplots(1, 3, figsize=(15, 4.8), layout='constrained')
for report in data['reports']:
    if report['mode'] != 'isolated' or report['label'] not in ['p01-v111', 'p01-v112', 'p01-fixed'] or report['transport'] != 'playwright' or report['rounds'] != 3:
        continue
    draw(axes[0], report, 'same240', 'cycle-closed', 'cycle', True)
    draw(axes[1], report, 'mixed240', 'cycle-closed', 'cycle', True)
    draw(axes[2], report, 'mixed240', 'closed-natural', 'plannedMs')
decorate(axes, 'Playwright transport: includes inspector response retention; n=3, median and full range; no forced GC',
         'p01-memory-growth-playwright-20261028', panels)

fig, axes = plt.subplots(1, 3, figsize=(15, 4.8), layout='constrained')
for report in data.get('acceptance', []):
    if report['kind'] != 'Isolated natural acceptance':
        continue
    draw(axes[0], report, 'same240', 'cycle-closed', 'cycle', True)
    draw(axes[1], report, 'mixed240', 'cycle-closed', 'cycle', True)
    draw(axes[2], report, 'mixed240', 'closed-natural', 'plannedMs')
    for sample in report['samples']:
        for point in sample['points']:
            for proc in point['native']['processes']:
                rows.append([report['label'], sample['scene'], sample['run'], point['stage'], point.get('cycle', ''),
                             point.get('plannedMs', ''), point['time'], proc['pid'], proc['role'], proc['subtype'],
                             proc['private'], proc['working'], point['heapUsed'], point['heapTotal'], sample['source']['sha256']])
decorate(axes, f'Minimal CDP (Network disabled): n=3 new processes/profiles; median and full range; Runtime {runtime}; no forced GC',
         'p01-memory-growth-raw-20261028', panels)
with (destination / 'p01-memory-growth-raw-20261028.csv').open('w', newline='', encoding='utf-8') as stream:
    writer = csv.writer(stream)
    writer.writerow(['version', 'scene', 'run', 'stage', 'cycle', 'planned_ms', 'unix_ms', 'pid', 'role', 'subtype',
                     'private_bytes', 'working_set_bytes', 'js_heap_used_bytes', 'js_heap_capacity_bytes', 'source_json_sha256'])
    writer.writerows(rows)

fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), layout='constrained')
for report in data.get('cohorts', []):
    if report['n'] != 3 or report['transport'] != 'raw-cdp-no-network':
        continue
    draw(axes[0], report, 'mixed240', 'cycle-closed', 'cycle', True)
    draw(axes[1], report, 'mixed240', 'closed-natural', 'plannedMs')
decorate(axes, 'Interleaved historical controls (round 2 reversed): n=3; median and full range; minimal CDP; no forced GC',
         'p01-memory-growth-interleaved-20261028', [('Mixed workload', 'Completed cycles'), ('Natural recovery after cycle 240', 'Planned wait after close (seconds)')])
print(destination / 'p01-memory-growth-raw-20261028.svg')
