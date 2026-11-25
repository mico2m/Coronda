"""Agrega un buzón low poly a los modelos de casa y crea assets/models/objects/buzon.glb.

Uso:  blender -b -P blender/agregar_buzon.py
- buzon.glb: el buzón solo (el juego lo pone delante de las casas que no traen el suyo).
- casa_model01.glb (y las demás de data/tables/casas.json que existan): se les agrega un Empty "buzon" con el buzón
  adentro, al frente a la derecha (el frente de la casa es -Y de Blender). Guarda también blender/casa_modelXX_buzon.blend.
Para tu propio modelo: alcanza con un objeto (malla o Empty) llamado "buzon" en la casa. El juego lo renombra
lote_<número>_buzon y Claude se para enfrente para dejar la nota.
"""
import bpy, bmesh, json, math, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def mat(name, hexc):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    h = hexc.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [(x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*lin, 1); b.inputs['Roughness'].default_value = 1
    return m

def box(name, size, loc, material, parent):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    bmesh.ops.translate(bm, verts=bm.verts, vec=loc)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(material); o.parent = parent
    return o

def buzon(at=(0, 0, 0), rot=0):
    root = bpy.data.objects.new('buzon', None); root.empty_display_type = 'PLAIN_AXES'; root.empty_display_size = 0.4
    bpy.context.scene.collection.objects.link(root)
    root.location = at; root.rotation_euler.z = rot
    box('buzon_poste', (0.09, 0.09, 1.05), (0, 0, 0.525), mat('buzon_madera', '#6e4a2b'), root)
    box('buzon_caja', (0.32, 0.5, 0.3), (0, 0, 1.2), mat('buzon_rojo', '#c8463a'), root)
    box('buzon_techo', (0.36, 0.54, 0.05), (0, 0, 1.375), mat('buzon_oscuro', '#7d2a22'), root)
    box('buzon_ranura', (0.2, 0.02, 0.03), (0, -0.255, 1.25), mat('buzon_negro', '#1f1a17'), root)
    box('buzon_bandera_palo', (0.03, 0.03, 0.28), (0.18, 0.1, 1.32), mat('buzon_madera', '#6e4a2b'), root)
    box('buzon_bandera', (0.03, 0.16, 0.1), (0.18, 0.04, 1.42), mat('buzon_amarillo', '#f2b544'), root)
    return root

def export(path):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_extras=True, export_apply=True,
                              export_yup=True, export_animations=True, export_morph_animation=False)

# 1) buzón solo
bpy.ops.wm.read_factory_settings(use_empty=True)
buzon()
export(os.path.join(ROOT, 'assets/models/objects/buzon.glb'))

# 2) cada casa que exista
casas = json.load(open(os.path.join(ROOT, 'data/tables/casas.json')))['casas']
for c in casas:
    path = os.path.join(ROOT, c['archivo'])
    if not os.path.exists(path):
        print('no existe', path); continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    sc = bpy.context.scene
    for o in list(sc.objects):
        if o.name.startswith('buzon'): bpy.data.objects.remove(o)  # si ya tenía uno de antes, se reemplaza
    from mathutils import Vector
    mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
    for o in sc.objects:
        if o.type == 'MESH':
            for v in o.bound_box:
                w = o.matrix_world @ Vector(v); mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
    # al frente (-Y) a la derecha, un poco afuera de la casa, sobre el piso
    buzon((mx.x - 1.0, mn.y - 0.8, mn.z))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, f"blender/{c['id']}_buzon.blend"))
    export(path)
    print('buzón agregado a', c['id'])
