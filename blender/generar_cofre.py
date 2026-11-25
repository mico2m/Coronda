"""Cofre de almacenamiento (mueble que fabrica Claude en la Carpintería).

Uso:  blender -b -P blender/generar_cofre.py
Deja blender/cofre.blend (para editarlo) y assets/models/muebles/cofre.glb.
Como todos los muebles: origen en la base, al centro; metros reales; el frente mira hacia -Y de Blender.
"col_cofre" es su caja de colisión (el juego la usa para chocar y no la dibuja).
Datos del mueble (precio, tiempo, capacidad): data/muebles.json > "cofre".
"""
import bpy, bmesh, os, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene

def mat(name, hexc):
    m = bpy.data.materials.new(name); m.use_nodes = True
    h = hexc.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [(x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*lin, 1); b.inputs['Roughness'].default_value = 1
    return m

def box(name, size, loc, material, parent=None):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    bmesh.ops.translate(bm, verts=bm.verts, vec=loc)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); sc.collection.objects.link(o)
    if material: o.data.materials.append(material)
    o.parent = parent
    return o

def tapa(name, w, d, r, z, material, parent):
    # medio cilindro acostado (la tapa redondeada)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=r, radius2=r, depth=w)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=__import__('mathutils').Matrix.Rotation(math.radians(90), 3, 'Y'))
    for v in list(bm.verts):
        if v.co.z < -1e-4: v.co.z = 0
    for v in bm.verts: v.co.y *= d / (2 * r)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, z))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); sc.collection.objects.link(o)
    o.data.materials.append(material); o.parent = parent
    return o

raiz = bpy.data.objects.new('cofre', None); sc.collection.objects.link(raiz)
madera, oscura, metal, cerrojo = mat('cofre_madera', '#8a5428'), mat('cofre_madera_osc', '#5e3818'), mat('cofre_metal', '#c9a23f'), mat('cofre_cerrojo', '#3a2a0a')
W, D, H = 0.9, 0.55, 0.42
box('cofre_caja', (W, D, H), (0, 0, H / 2), madera, raiz)
box('cofre_borde', (W + 0.02, D + 0.02, 0.05), (0, 0, H - 0.02), oscura, raiz)
tapa('cofre_tapa', W, D, 0.2, H, madera, raiz)
for x in (-W / 2 + 0.12, W / 2 - 0.12):
    box(f'cofre_fleje_{"i" if x < 0 else "d"}', (0.07, D + 0.03, H + 0.01), (x, 0, H / 2), metal, raiz)
    tapa(f'cofre_fleje_tapa_{"i" if x < 0 else "d"}', 0.07, D + 0.03, 0.205, H, metal, raiz)
box('cofre_cerradura', (0.14, 0.04, 0.16), (0, -D / 2 - 0.02, H - 0.02), metal, raiz)
box('cofre_ojo', (0.03, 0.02, 0.06), (0, -D / 2 - 0.045, H - 0.03), cerrojo, raiz)
col = box('col_cofre', (W, D, H + 0.2), (0, 0, (H + 0.2) / 2), None, raiz)
col.display_type = 'WIRE'; col.hide_render = True

os.makedirs(os.path.join(ROOT, 'assets/models/muebles'), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender/cofre.blend'))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(ROOT, 'assets/models/muebles/cofre.glb'), export_format='GLB', use_selection=True,
                          export_extras=True, export_apply=True, export_yup=True, export_animations=False)
print('OK cofre')
