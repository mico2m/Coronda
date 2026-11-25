"""Casas: agrega el cartel con el nombre del dueño (Empty "cartel_dueno") a casa_model01.

Uso:  blender -b -P blender/agregar_cartel_casa.py
- Abre blender/casa_model01_buzon.blend (el archivo fuente de la casa), agrega un cartel de madera al frente, al lado
  del buzón, y adentro el Empty "cartel_dueno" justo sobre la tabla. Guarda el .blend y exporta
  assets/models/objects/casa_model01.glb (con Custom Properties).
- El nombre NO va en el modelo: el juego lo escribe sobre el Empty con el dueño que dice el servidor y lo cambia si la
  casa cambia de dueño (ver src/systems/lotes.js > cartelDueño). El frente del Empty (-Y de Blender) es hacia donde mira el texto.
Para tu propio modelo de casa: alcanza con un Empty llamado "cartel_dueno" donde quieras que se lea el nombre.
"""
import bpy, bmesh, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND = os.path.join(ROOT, 'blender/casa_model01_buzon.blend')
GLB = os.path.join(ROOT, 'assets/models/objects/casa_model01.glb')

def mat(name, hexc):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    h = hexc.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [(x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*lin, 1); b.inputs['Roughness'].default_value = 1
    return m

def box(name, size, loc, material, parent):
    old = bpy.data.objects.get(name)
    if old: bpy.data.objects.remove(old, do_unlink=True)
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    bmesh.ops.translate(bm, verts=bm.verts, vec=loc)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(material); o.parent = parent
    return o

def empty(name, loc, parent=None, kind='PLAIN_AXES', size=0.3):
    o = bpy.data.objects.get(name) or bpy.data.objects.new(name, None)
    if o.name not in bpy.context.scene.collection.objects: bpy.context.scene.collection.objects.link(o)
    o.empty_display_type = kind; o.empty_display_size = size
    o.parent = parent; o.location = loc
    return o

bpy.ops.wm.open_mainfile(filepath=BLEND)
buzon = bpy.data.objects.get('buzon')
# Al lado del buzón (mismo frente de la casa), 2,4 m hacia el centro
bx, by = (buzon.location.x, buzon.location.y) if buzon else (-8.0, 9.8)
rot = buzon.rotation_euler.z if buzon else 0.0
lado = 2.4 if bx < 0 else -2.4
raiz = empty('cartel_casa', (bx + lado, by, 0), kind='PLAIN_AXES', size=0.5)
raiz.rotation_euler = (0, 0, rot)
madera, oscura = mat('cartel_madera', '#8a5a33'), mat('cartel_madera_osc', '#5b3a20')
box('cartel_casa_poste_1', (0.1, 0.1, 1.5), (-0.85, 0, 0.75), oscura, raiz)
box('cartel_casa_poste_2', (0.1, 0.1, 1.5), (0.85, 0, 0.75), oscura, raiz)
box('cartel_casa_tabla', (2.0, 0.08, 0.5), (0, 0, 1.3), madera, raiz)
# El texto va en la cara de adelante de la tabla (-Y local), un poquito afuera
dueno = empty('cartel_dueno', (0, -0.05, 1.3), parent=raiz, kind='CUBE', size=0.1)
dueno.scale = (1, 1, 1)
dueno['cartel'] = 'dueno'

bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', use_selection=True, export_extras=True, export_apply=True,
                          export_yup=True, export_animations=True, export_morph_animation=False)
print('OK: cartel_dueno en', tuple(round(v, 2) for v in raiz.location))
