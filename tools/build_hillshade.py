"""Schummerung + Höhenfarben aus DGM1 als Ersatz-Textur, falls das Luftbild (DOP) nicht geladen werden kann."""
import glob, json, os, sys
import numpy as np
from PIL import Image
CFG = json.load(open(sys.argv[1]))
X0, Y0, X1, Y1 = CFG['utm_bbox']; W_, H_ = X1-X0, Y1-Y0
dem = np.full((H_, W_), np.nan, np.float32)
for f in glob.glob(os.path.join(CFG['dgm_dir'], 'DGM1_32_*_1_he.tif')):
    p = os.path.basename(f).split('_'); e, n = int(p[2])*1000, int(p[3])*1000
    a = np.array(Image.open(f), np.float32)
    ix0 = max(X0, e); ix1 = min(X1, e+1000); iy0 = max(Y0, n); iy1 = min(Y1, n+1000)
    if ix0 >= ix1 or iy0 >= iy1: continue
    dem[Y1-iy1:Y1-iy0, ix0-X0:ix1-X0] = a[(n+1000)-iy1:(n+1000)-iy0, ix0-e:ix1-e]
miss = np.isnan(dem)
from scipy import ndimage
dem = dem[tuple(ndimage.distance_transform_edt(miss, return_distances=False, return_indices=True))]
dem = dem[::2, ::2]; miss = miss[::2, ::2]
gy, gx = np.gradient(dem, 2.0)
az, alt = np.radians(315), np.radians(45)
slope = np.arctan(np.hypot(gx, gy)); aspect = np.arctan2(-gx, gy)
hs = np.clip(np.sin(alt)*np.cos(slope) + np.cos(alt)*np.sin(slope)*np.cos(az-aspect), 0, 1)
t = (dem-dem.min())/(dem.max()-dem.min())
lo = np.array([196, 214, 170]); hi = np.array([232, 220, 190])
rgb = lo*(1-t[..., None]) + hi*t[..., None]
rgb = rgb*(0.55+0.45*hs[..., None])
rgb[miss] = rgb[miss]*0.75 + 40   # Bereich ohne DGM-Daten (außerhalb Frankfurt) aufgehellt
Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).save(CFG['out']+'/hillshade.jpg', quality=85)
