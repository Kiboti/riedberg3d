"""DGM1 (HVBG, dl-de/zero-2-0) -> Terrain-Mesh (Binär) + Höhenraster (lon/lat) für Fahrzeughöhen."""
import glob, json, math, os, sys
import numpy as np
from PIL import Image
from pyproj import Transformer
CFG = json.load(open(sys.argv[1]))
LON0, LAT0 = CFG['origin']; H0 = CFG['h0']
X0, Y0, X1, Y1 = CFG['utm_bbox']
R = 6378137.0
MLON = 2*math.pi*R/360*math.cos(math.radians(LAT0)); MLAT = 2*math.pi*R/360
W_, H_ = X1-X0, Y1-Y0
dem = np.full((H_, W_), np.nan, np.float32)   # Zeile 0 = Norden, 1 m
for f in glob.glob(os.path.join(CFG['dgm_dir'], 'DGM1_32_*_1_he.tif')):
    p = os.path.basename(f).split('_'); e, n = int(p[2])*1000, int(p[3])*1000
    a = np.array(Image.open(f), np.float32)
    # Kachel deckt e..e+1000, n..n+1000; Zeile 0 = n+999.5
    for_x0, for_y1 = e, n+1000
    ix0 = max(X0, e); ix1 = min(X1, e+1000); iy0 = max(Y0, n); iy1 = min(Y1, n+1000)
    if ix0 >= ix1 or iy0 >= iy1: continue
    dem[Y1-iy1:Y1-iy0, ix0-X0:ix1-X0] = a[(n+1000)-iy1:(n+1000)-iy0, ix0-e:ix1-e]
a = dem
a[a < -100] = np.nan
missing = np.isnan(a).mean()
print('fehlend', round(float(missing)*100, 2), '%', file=sys.stderr)
# Lücken (außerhalb Frankfurt, z.B. Oberursel) mit Nachbarwerten auffüllen
if missing:
    from scipy import ndimage
    idx = ndimage.distance_transform_edt(np.isnan(a), return_distances=False, return_indices=True)
    a = a[tuple(idx)]
print('Höhe min/max', float(a.min()), float(a.max()), file=sys.stderr)
STEP = CFG.get('terrain_step', 8)
ys = np.arange(0, H_+1, STEP); xs = np.arange(0, W_+1, STEP)
ys = np.clip(ys, 0, H_-1); xs = np.clip(xs, 0, W_-1)
Z = a[np.ix_(ys, xs)]
ny, nx = Z.shape
gx = X0 + xs + 0.5; gy = Y1 - ys - 0.5
GX, GY = np.meshgrid(gx, gy)
tr = Transformer.from_crs(25832, 4326, always_xy=True)
lon, lat = tr.transform(GX.ravel(), GY.ravel())
lon = np.asarray(lon); lat = np.asarray(lat)
P = np.stack([(lon-LON0)*MLON, (lat-LAT0)*MLAT, Z.ravel()-H0-0.3], 1)
U = np.stack([(GX.ravel()-X0)/W_, (GY.ravel()-Y0)/H_], 1)  # v=0 unten (Süden)
idx = []
for j in range(ny-1):
    r0 = j*nx; r1 = (j+1)*nx
    i = np.arange(nx-1)
    idx.append(np.stack([r0+i, r1+i, r0+i+1, r0+i+1, r1+i, r1+i+1], 1).ravel())
I = np.concatenate(idx).astype(np.uint32)
# Sockel (Skirt) bis z=0 an den Rändern
border = list(range(nx)) + [j*nx+nx-1 for j in range(1, ny)] + [(ny-1)*nx+i for i in range(nx-2, -1, -1)] + [j*nx for j in range(ny-2, 0, -1)]
border.append(border[0])
base = len(P); extraP = []; extraU = []; extraI = []
for k in range(len(border)-1):
    a_, b_ = border[k], border[k+1]
    pa, pb = P[a_].copy(), P[b_].copy(); pa2, pb2 = pa.copy(), pb.copy(); pa2[2] = 0; pb2[2] = 0
    n0 = base + len(extraP)
    extraP += [pa, pb, pa2, pb2]; extraU += [U[a_], U[b_], U[a_], U[b_]]
    extraI += [n0, n0+2, n0+1, n0+1, n0+2, n0+3]
P = np.concatenate([P, np.array(extraP)]); U = np.concatenate([U, np.array(extraU)])
I = np.concatenate([I, np.array(extraI, np.uint32)])
# Normalen
Nn = np.zeros_like(P)
t = I.reshape(-1, 3)
fn = np.cross(P[t[:, 1]]-P[t[:, 0]], P[t[:, 2]]-P[t[:, 0]])
for k in range(3): np.add.at(Nn, t[:, k], fn)
Nn /= np.linalg.norm(Nn, axis=1, keepdims=True) + 1e-9
if Nn[:base, 2].mean() < 0: Nn = -Nn; I = t[:, [0, 2, 1]].ravel()
out = CFG['out']
with open(out+'/terrain.bin', 'wb') as fh:
    fh.write(P.astype(np.float32).tobytes()); fh.write(Nn.astype(np.float32).tobytes())
    fh.write(U.astype(np.float32).tobytes()); fh.write(I.astype(np.uint32).tobytes())
# Höhenraster in lon/lat (für Fahrzeuge/Haltestellen), ~5 m
W, S, E, N = CFG['bbox']
GW, GH = 720, 720
glon = np.linspace(W, E, GW); glat = np.linspace(N, S, GH)
LL, TT = np.meshgrid(glon, glat)
tr2 = Transformer.from_crs(4326, 25832, always_xy=True)
ux, uy = tr2.transform(LL.ravel(), TT.ravel())
ci = np.clip((np.asarray(ux)-X0).astype(int), 0, W_-1); ri = np.clip((Y1-np.asarray(uy)).astype(int), 0, H_-1)
hg = a[ri, ci].reshape(GH, GW)
np.round((hg-H0)*10).astype(np.uint16).tofile(out+'/height.bin')
json.dump({'vertexCount': int(len(P)), 'indexCount': int(len(I)), 'utm_bbox': CFG['utm_bbox'],
           'grid': {'w': GW, 'h': GH, 'bbox': CFG['bbox'], 'scale': 0.1, 'offset': 0},
           'origin': CFG['origin'], 'h0': H0, 'hmin': float(a.min()), 'hmax': float(a.max())},
          open(out+'/terrain.json', 'w'))
print('Terrain verts', len(P), 'tris', len(I)//3, file=sys.stderr)
