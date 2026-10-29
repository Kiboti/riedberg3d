# Blender-Skript: generische Fahrzeugmodelle (keine verifizierte Lackierung!) -> glTF (.glb)
# Aufruf: blender -b -P tools/make_vehicles.py
# Achsen (Blender): X = Fahrtrichtung, Y = Breite, Z = oben. Maße: U-Bahn-Wagen 25 m x 2,65 m x 3,6 m (Größenordnung U5),
# Bus 12 m x 2,55 m x 3,1 m (Standardbus). Material "Linie" wird zur Laufzeit in Linienfarbe eingefärbt.
import bpy, math
OUT = '/workspace/riedberg3d/models/'

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, rgb, rough=0.5, metal=0.0, emit=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = 1.0
    return m

def box(name, size, loc, m, bevel=0.0, seg=3):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        md = o.modifiers.new('b', 'BEVEL'); md.width = bevel; md.segments = seg; md.limit_method = 'ANGLE'
        bpy.ops.object.modifier_apply(modifier='b')
    o.data.materials.append(m); return o

def cyl(name, r, depth, loc, m, rot=(math.pi/2, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, rotation=rot, vertices=16)
    o = bpy.context.object; o.name = name; o.data.materials.append(m); return o

def join_export(fname):
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join()
    bpy.ops.object.shade_flat()
    bpy.ops.export_scene.gltf(filepath=OUT+fname, export_format='GLB', export_apply=True, export_yup=True)

# ---------- U-Bahn-Wagen (ein Wagen, 25 m) ----------
reset()
body = mat('Wagenkasten', (0.86, 0.86, 0.84), 0.35)
glass = mat('Glas', (0.03, 0.04, 0.05), 0.08, 0.3)
line = mat('Linie', (0.8, 0.5, 0.75), 0.4)
dark = mat('Fahrwerk', (0.06, 0.06, 0.06), 0.8)
light = mat('Licht', (1.0, 0.95, 0.8), 0.2, emit=(1.0, 0.95, 0.8))
L, Wd, Hh = 25.0, 2.65, 3.6
z0 = 0.9  # Wagenboden über Schiene (Kastenunterkante)
box('Kasten', (L, Wd, Hh-z0-0.25), (0, 0, z0+(Hh-z0-0.25)/2), body, bevel=0.35)
box('Fensterband', (L-1.2, Wd+0.04, 1.05), (0, 0, z0+1.75), glass, bevel=0.05)
for s in (-1, 1):
    box('Frontscheibe', (0.08, Wd-0.4, 1.2), (s*(L/2+0.0), 0, z0+1.8), glass)
    for y in (-0.85, 0.85): box('Scheinwerfer', (0.06, 0.35, 0.18), (s*(L/2+0.02), y, z0+0.55), light)
box('Zierstreifen', (L-0.4, Wd+0.05, 0.3), (0, 0, z0+0.85), line)
for x in (-8.5, -2.8, 2.8, 8.5):  # Türen (dunkle Felder)
    box('Tuer', (1.3, Wd+0.06, 2.0), (x, 0, z0+1.15), glass)
for x in (-8.0, 8.0): box('Drehgestell', (2.6, 2.2, 0.75), (x, 0, 0.45), dark)
box('Dachgeraet', (6.0, 1.6, 0.25), (0, 0, Hh-0.12), dark)
box('Stromabnehmer', (1.6, 1.4, 0.08), (-6, 0, Hh+0.15), dark)
join_export('ubahn_wagen.glb')

# ---------- Bus (12 m) ----------
reset()
body = mat('Wagenkasten', (0.92, 0.92, 0.9), 0.35)
glass = mat('Glas', (0.03, 0.04, 0.05), 0.08, 0.3)
line = mat('Linie', (0.85, 0.6, 0.1), 0.4)
dark = mat('Fahrwerk', (0.05, 0.05, 0.05), 0.85)
light = mat('Licht', (1.0, 0.95, 0.8), 0.2, emit=(1.0, 0.95, 0.8))
L, Wd, Hh = 12.0, 2.55, 3.1
box('Kasten', (L, Wd, Hh-0.35), (0, 0, 0.35+(Hh-0.35)/2), body, bevel=0.25)
box('Fensterband', (L-1.0, Wd+0.04, 1.2), (0.2, 0, 2.05), glass, bevel=0.04)
box('Frontscheibe', (0.08, Wd-0.2, 1.9), (L/2+0.0, 0, 1.75), glass)
box('Heckscheibe', (0.08, Wd-0.4, 0.9), (-L/2, 0, 2.2), glass)
for y in (-0.95, 0.95): box('Scheinwerfer', (0.06, 0.35, 0.15), (L/2+0.02, y, 0.75), light)
box('Zierstreifen', (L-0.3, Wd+0.05, 0.25), (0, 0, 1.25), line)
for x in (4.6, 0.3): box('Tuer', (1.25, Wd+0.06, 2.3), (x, 0, 1.45), glass)
box('Zielanzeige', (0.06, 1.8, 0.3), (L/2+0.03, 0, 2.85), light)
for x in (3.7, -2.6):
    for y in (-1.1, 1.1): cyl('Rad', 0.5, 0.35, (x, y, 0.5), dark)
box('Dachaufbau', (3.5, 1.8, 0.3), (-3.5, 0, Hh+0.12), body, bevel=0.1)
join_export('bus.glb')
