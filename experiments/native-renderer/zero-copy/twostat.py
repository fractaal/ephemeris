# the two-app run: the worker's frames (and the gaps its heavy jobs make), the editor window's frames from its trace
import json, sys
tag = sys.argv[1]; D = sys.argv[2] if len(sys.argv) > 2 else 'out/'
R = json.load(open(D + tag + '.json'))
fr = R['frames']; made = R['made']
ok = sum(1 for f in fr if 'corner' in f and f['corner'][0] == f['frame'] % 256 and f['bar'] == [255, 255, 255]); chk = sum(1 for f in fr if 'corner' in f)
print(f'{tag}: frames made {len(made)}, shown {len(fr)}, pixel checks right {ok} of {chk}')
g = [(made[i][1] - made[i - 1][1], made[i][0]) for i in range(1, len(made))]
heavy = sorted([x for x in g if x[0] > 100], reverse=True)
print('worker frame gaps over 100 ms (its GPU busy with the heavy job):', len(heavy), 'longest', [round(x[0]) for x in heavy[:4]], 'ms')
lat = sorted(f['got'] - f['made'] for f in fr); print('worker done -> editor drawn: p50', lat[len(lat) // 2], 'p95', lat[int(len(lat) * .95)], 'max', lat[-1], 'ms')
tr = json.load(open(D + tag + '.trace.json')); ev = tr['traceEvents'] if isinstance(tr, dict) else tr
st = {e['args']['data']['message']: e['ts'] for e in ev if e.get('name') == 'TimeStamp' and e.get('args', {}).get('data', {}).get('message', '').startswith('zc:')}
A, B = st.get('zc:start'), st.get('zc:stop')
draws = sorted(e['ts'] for e in ev if e.get('name') == 'Display::DrawAndSwap' and A <= e['ts'] <= B)
gaps = sorted((draws[i] - draws[i - 1]) / 1e3 for i in range(1, len(draws)))
span = (B - A) / 1e6
print(f'editor window: {len(draws) / span:.1f} frames/s over {span:.1f} s, gaps >50 ms {sum(1 for x in gaps if x > 50)}, >100 ms {sum(1 for x in gaps if x > 100)}, longest {gaps[-1]:.0f} ms, p99 {gaps[int(len(gaps) * .99)]:.0f} ms')
