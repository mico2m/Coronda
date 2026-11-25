"""Genera el Bosque de Coronda (provisorio, low poly) con Blender.

Uso:  blender -b -P blender/generar_bosque.py
Crea:
  blender/bosque_coronda.blend                   (para editarlo a mano)
  assets/models/worlds/Bosque_Coronda.glb        (la escena)
  assets/models/objects/cartel_bosque.glb        (el cartel de la plaza que lleva al bosque)

Nombres que usa el juego (conservalos si hacés tu propio bosque):
  arbol_001, arbol_002…   un árbol talable (Empty o malla padre). Adentro:
     *_copa / *_tronco   lo que desaparece al talarlo        *_tocon   lo que queda (el tocón)
     col_arbol_…         su colisión (Empty, colision_forma = "cilindro")
  spawn                   llegada desde la plaza (mira al norte, hacia el bosque)
  col_suelo, col_borde_…  suelo y paredes invisibles
Los árboles se pueden mover, copiar (Shift+D, renombrar a arbol_041…) o borrar.
"""
import bpy, bmesh, math, random, os

random.seed(7)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene

def mat(name, hexc):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    h = hexc.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [(x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*lin, 1); b.inputs['Roughness'].default_value = 1
    return m

M = {k: mat(k, v) for k, v in {
    'pasto': '#5f9a3e', 'pasto2': '#4f8734', 'tierra': '#9b7651', 'tronco': '#6e4a2b', 'tocon': '#8a6038',
    'copa1': '#2f7a3a', 'copa2': '#3d8c40', 'copa3': '#26663a', 'piedra': '#8d9196', 'flor': '#f2d14b',
    'flor2': '#e86f8a', 'arbusto': '#3f7f36', 'colina': '#4a7d38', 'cartel': '#c9935a', 'cartel2': '#7a4f2c', 'col': '#ff00ff',
}.items()}

def obj_from(mesh_name, bm, material, parent=None, name=None):
    me = bpy.data.meshes.new(mesh_name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name or mesh_name, me); sc.collection.objects.link(o)
    o.data.materials.append(material)
    if parent: o.parent = parent
    return o

def cylinder(name, r, h, z0, mtl, parent=None, seg=8, r2=None, at=(0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(at[0], at[1], z0 + h / 2))
    return obj_from(name, bm, mtl, parent)

def empty(name, loc, parent=None, size=1, kind='PLAIN_AXES'):
    e = bpy.data.objects.new(name, None); e.empty_display_type = kind; e.empty_display_size = size
    e.location = loc; sc.collection.objects.link(e)
    if parent: e.parent = parent
    return e

# ---------- Suelo ----------
S = 50  # medio lado
bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=20, y_segments=20, size=S)
for v in bm.verts:  # ondulación suave solo en lo que se ve
    v.co.z = 0.06 * math.sin(v.co.x * 0.35) * math.cos(v.co.y * 0.3) - 0.02
suelo = obj_from('suelo', bm, M['pasto'])
bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=S)
obj_from('col_suelo', bm, M['col'])

# Sendero desde la llegada (sur) hacia el claro del centro
bm = bmesh.new()
pts = [(0, 44), (1.5, 34), (-1, 24), (2, 14), (0, 5)]
for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
    w = 1.6
    v = [bm.verts.new((x1 - w, y1, 0.02)), bm.verts.new((x1 + w, y1, 0.02)), bm.verts.new((x2 + w, y2, 0.02)), bm.verts.new((x2 - w, y2, 0.02))]
    bm.faces.new(v)
obj_from('sendero', bm, M['tierra'])
# Claro del centro
bm = bmesh.new(); bmesh.ops.create_circle(bm, cap_ends=True, segments=16, radius=6)
bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.015))
obj_from('claro', bm, M['tierra'])

# Paredes invisibles y colinas alrededor
for i, (x, y, sx, sy) in enumerate([(0, S, S, 0.5), (0, -S, S, 0.5), (S, 0, 0.5, S), (-S, 0, 0.5, S)]):
    e = empty(f'col_borde_{i + 1}', (x, y, 2), kind='CUBE'); e.scale = (sx, sy, 2)
for i in range(28):
    a = i / 28 * math.tau
    r = S + 6 + random.uniform(-2, 3)
    h = random.uniform(7, 14)
    c = cylinder(f'colina_{i + 1:02d}', random.uniform(9, 14), h, -0.5, M['colina'], seg=7, r2=0.5, at=(math.cos(a) * r, math.sin(a) * r))

# ---------- Árboles ----------
def tree(n, x, y, s=1.0):
    root = empty(f'arbol_{n:03d}', (x, y, 0), size=0.6)
    th = 2.6 * s
    cylinder(f'arbol_{n:03d}_tocon', 0.26 * s, 0.45, 0, M['tocon'], root, seg=7)
    cylinder(f'arbol_{n:03d}_tronco', 0.22 * s, th - 0.45, 0.45, M['tronco'], root, seg=7, r2=0.16 * s)
    copa = random.choice([M['copa1'], M['copa2'], M['copa3']])
    if random.random() < 0.6:  # pino: tres conos
        for k in range(3):
            cylinder(f'arbol_{n:03d}_copa{k + 1}', (1.6 - k * 0.42) * s, 1.5 * s, th - 0.4 + k * 0.85 * s, copa, root, seg=7, r2=0.05)
    else:  # frondoso: icosfera
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.35 * s)
        for v in bm.verts: v.co.z *= 0.85
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, th + 0.6 * s))
        obj_from(f'arbol_{n:03d}_copa', bm, copa, root)
    col = empty(f'col_arbol_{n:03d}', (0, 0, 1), root, kind='CIRCLE')
    col.scale = (0.3 * s, 0.3 * s, 2.2); col['colision_forma'] = 'cilindro'
    root.rotation_euler.z = random.uniform(0, math.tau)
    return root

spots = []
def free(x, y, d):
    if abs(x) < 3.2 and y > 3: return False          # sendero
    if math.hypot(x, y) < 7.5: return False          # claro
    if abs(x) < 6 and y > 38: return False           # llegada
    return all(math.hypot(x - a, y - b) > d for a, b in spots)
n = 0
tries = 0
while n < 46 and tries < 5000:
    tries += 1
    x, y = random.uniform(-S + 6, S - 6), random.uniform(-S + 6, S - 6)
    if free(x, y, 5.2):
        n += 1; spots.append((x, y)); tree(n, x, y, random.uniform(0.85, 1.25))

# Arbustos, piedras y flores (decoración, sin colisión)
for i in range(40):
    x, y = random.uniform(-S + 4, S - 4), random.uniform(-S + 4, S - 4)
    if not free(x, y, 1.6): continue
    k = random.random()
    if k < 0.4:
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=random.uniform(0.5, 0.9))
        for v in bm.verts: v.co.z = v.co.z * 0.6 + 0.3
        bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, 0)); obj_from(f'arbusto_{i}', bm, M['arbusto'])
    elif k < 0.7:
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=random.uniform(0.3, 0.7))
        for v in bm.verts: v.co.z *= 0.55
        bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, 0.05)); obj_from(f'piedra_{i}', bm, M['piedra'])
    else:
        for j in range(5):
            fx, fy = x + random.uniform(-0.8, 0.8), y + random.uniform(-0.8, 0.8)
            cylinder(f'flor_{i}_{j}', 0.09, 0.08, 0.12, random.choice([M['flor'], M['flor2']]), seg=5, at=(fx, fy))

# ---------- Llegada ----------
sp = empty('spawn', (0, 42, 0), kind='SINGLE_ARROW', size=1)
sp.rotation_euler = (0, 0, math.pi)  # el frente del spawn es su eje +Y de Blender: girado mira al bosque (-Y)

# Cartel de vuelta (al lado de la llegada)
def cartel(parent_name, x, y, rot):
    root = empty(parent_name, (x, y, 0), size=0.5)
    cylinder(f'{parent_name}_poste', 0.07, 2.0, 0, M['cartel2'], root, seg=6)
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co.x *= 1.3; v.co.y *= 0.08; v.co.z *= 0.5
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0.3, 0, 1.7))
    obj_from(f'{parent_name}_tabla', bm, M['cartel'], root)
    bm = bmesh.new()  # flecha
    tri = [bm.verts.new(p) for p in [(0.95, -0.05, 1.95), (0.95, -0.05, 1.45), (1.25, -0.05, 1.7)]]
    bm.faces.new(tri)
    obj_from(f'{parent_name}_flecha', bm, M['cartel2'], root)
    root.rotation_euler.z = rot
    return root
cartel('cartel_volver', 3.2, 44.5, math.radians(180))
# Empty del teleport de vuelta (el cartel es solo el adorno): al acercarte, "E Volver a la plaza"
tp = empty('volver_plaza', (3.2, 44.5, 1.0), kind='CUBE', size=1)
tp.rotation_euler.z = math.radians(180); tp.scale = (1.4, 0.6, 1.0)
tp['teleport'] = 'coronda_plaza'; tp['teleport_modo'] = 'E'; tp['teleport_radio'] = 1.2; tp['teleport_texto'] = 'Volver a la plaza'

# ---------- Guardar y exportar ----------
os.makedirs(os.path.join(ROOT, 'assets/models/worlds'), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender/bosque_coronda.blend'))
def export(path, objs=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in (objs or sc.objects): o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_extras=True,
                              export_apply=True, export_yup=True, export_animations=False, export_morph_animation=False)
export(os.path.join(ROOT, 'assets/models/worlds/Bosque_Coronda.glb'))

# Cartel para la plaza (objeto aparte)
for o in list(sc.objects): bpy.data.objects.remove(o)
c = cartel('cartel_bosque', 0, 0, 0)
c.location = (0, 0, 0)
export(os.path.join(ROOT, 'assets/models/objects/cartel_bosque.glb'))
print('OK árboles:', n)
