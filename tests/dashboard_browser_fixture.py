"""Create browser fixtures: python tests/dashboard_browser_fixture.py <runtime-dir>.

The directory needs node_modules with the pinned dashboard packages from the
sandbox Dockerfile, plus talos-charts.js built with esbuild from entry.mjs.
Then run: node tests/dashboard_browser.cjs <runtime-dir> (requires Playwright).
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
from sandbox.vendor import talos_dash as td

root = Path(sys.argv[1])
td.VENDOR = root
td.BUNDLE = root / 'talos-charts.js'
td.ECHARTS_BUNDLE = root / 'echarts.min.js'
td.ECHARTS_BUNDLE.write_text((root / 'node_modules/echarts/dist/echarts.min.js').read_text(encoding='utf-8') + '\n;\n' + (root / 'node_modules/echarts/i18n/langDE.js').read_text(encoding='utf-8'), encoding='utf-8')
for package, source in [('echarts-gl', 'echarts-gl/dist/echarts-gl.min.js'), ('echarts-stat', 'echarts-stat/dist/ecStat.min.js')]:
    (root / (package + '.min.js')).write_bytes((root / 'node_modules' / source).read_bytes())

charts = []
def add(name, option, **kw):
    charts.append(td.chart(name, name, td.echarts(option, **kw), height=380))

add('sunburst', {'series': [{'type': 'sunburst', 'radius': [0, '85%'], 'data': [{'name': 'Services', 'children': [{'name': 'Support', 'value': 42}, {'name': 'Beratung', 'value': 28}]}, {'name': 'Lizenzen', 'value': 30}]}]})
add('tree', {'series': [{'type': 'tree', 'data': [{'name': 'Talos', 'children': [{'name': 'Analyse'}, {'name': 'Dashboard'}]}], 'expandAndCollapse': True}]})
add('chord', {'series': [{'type': 'chord', 'label': {'show': True}, 'data': [{'name': n} for n in 'ABCD'], 'links': [{'source': 'A', 'target': 'B', 'value': 40}, {'source': 'B', 'target': 'C', 'value': 20}]}]})
add('parallel', {'parallelAxis': [{'dim': i, 'name': n} for i,n in enumerate(['Kosten', 'Qualität', 'Zeit'])], 'series': [{'type': 'parallel', 'data': [[1,4,2],[2,3,5],[5,1,3]]}]})
add('matrix', {'matrix': {'x': {'data': ['A','B']}, 'y': {'data': ['U','V']}}, 'visualMap': {'min': 0, 'max': 40, 'dimension': 2}, 'series': [{'type': 'heatmap','coordinateSystem':'matrix','data':[['A','U',10],['A','V',20],['B','U',30],['B','V',40]], 'label':{'show':True}}]})
add('custom', {'xAxis': {}, 'yAxis': {}, 'series': [{'type':'custom','data':[[1,2],[3,4]],'renderItem':td.js("function(p,api) {const xy=api.coord([api.value(0),api.value(1)]); return {type:'circle',shape:{cx:xy[0],cy:xy[1],r:12},style:{fill:'#2a78d6'}};}")}]})
geo = {'type':'FeatureCollection', 'features':[{'type':'Feature','properties':{'name':'Demo'}, 'geometry':{'type':'Polygon','coordinates':[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}}]}
add('map', {'series':[{'type':'map','map':'smoke','data':[{'name':'Demo','value':42}],'label':{'show':True}}]}, data=geo, setup=td.js("function(c,e,data){e.registerMap('smoke',data)}"))
add('zoom', {'legend':{},'xAxis':{'type':'category','data':['A','B','C','D']},'yAxis':{},'dataZoom':[{'type':'slider'}], 'series':[{'type':'line','name':'Ist','data':[1,2,3,4]},{'type':'line','name':'Plan','data':[2,3,4,5]}]})
add('regression', {'dataset':[{'source':[[1,2],[2,4],[3,5]]},{'transform':{'type':'ecStat:regression'}}], 'xAxis':{},'yAxis':{}, 'series':[{'type':'scatter','datasetIndex':0},{'type':'line','datasetIndex':1}]}, extensions=['echarts-stat'],setup=td.js('function(c,e){e.registerTransform(ecStat.transform.regression)}'))
add('gl', {'xAxis3D':{},'yAxis3D':{},'zAxis3D':{},'grid3D':{},'series':[{'type':'scatter3D','data':[[1,2,3],[2,3,1],[3,1,2]],'symbolSize':15}]},extensions=['echarts-gl'])
charts.append(td.chart('legacy', 'Legacy bar', td.bar(['A','B','C'],[3,5,2]),height=380))
td.dashboard(str(root/'smoke.html'),title='ECharts – Funktionsprüfung',subtitle='Synthetische Testdaten',charts=charts)
add('broken',{},setup=td.js("function(){throw new Error('intentional test')}"))
td.dashboard(str(root/'error.html'),title='Isolation',charts=[charts[-1],charts[0]])

# Mirror the preview response policy so CDN/eval-dependent regressions surface.
csp = ("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; "
       "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; "
       "connect-src 'none'; form-action 'none'; base-uri 'none'")
for name in ('smoke.html', 'error.html'):
    page = root / name
    html = page.read_text(encoding='utf-8')
    page.write_text(html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" '
                                 f'content="{csp}">'), encoding='utf-8')
