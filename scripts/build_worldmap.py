#!/usr/bin/env python3
"""Build a compact SVG world map (equirectangular) from GeoJSON for the dashboard map panel."""
import json, math

W, H = 1000, 470
# equirectangular projection with slight clipping of empty poles (lat 75..-60)
LAT_TOP, LAT_BOTTOM = 78, -62
LON_W = 360
LAT_SPAN = LAT_TOP - LAT_BOTTOM

def project(lon, lat):
    x = (lon + 180) / LON_W * W
    y = (LAT_TOP - lat) / LAT_SPAN * H
    return round(x, 1), round(y, 1)

data = json.load(open('/tmp/world.geo.json'))
paths = []
for f in data['features']:
    name = f['properties'].get('name', '')
    geom = f['geometry']
    polys = []
    if geom['type'] == 'Polygon':
        polys = [geom['coordinates']]
    elif geom['type'] == 'MultiPolygon':
        polys = geom['coordinates']
    for poly in polys:
        ring = poly[0]
        if len(ring) < 4:
            continue
        # skip tiny islands: bounding box smaller than ~2 degrees
        lons = [p[0] for p in ring]; lats = [p[1] for p in ring]
        if (max(lons) - min(lons)) < 1.8 and (max(lats) - min(lats)) < 1.8:
            continue
        pts = [project(p[0], p[1]) for p in ring]
        d = 'M' + ' L'.join(f'{x} {y}' for x, y in pts) + ' Z'
        paths.append(d)

big = ' '.join(paths)
print('path length:', len(big))
# write as TS module
out = f'''// AUTO-GENERATED world map path data (equirectangular projection, viewBox 0 0 {W} {H})
// Source: Natural Earth-derived public GeoJSON (world.geo.json, public domain)
export const WORLD_MAP_VIEWBOX = "0 0 {W} {H}";
export const WORLD_MAP_PATH = "{big}";
'''
open('src/lib/world-map-data.ts', 'w').write(out)
print('written src/lib/world-map-data.ts', len(out), 'bytes')
