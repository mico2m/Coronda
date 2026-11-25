import bpy, math, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_BLEND = os.path.join(ROOT, 'blender/npc_claude.blend')
OUT_GLB = os.path.join(ROOT, 'assets/models/objects/npc_claude.glb')
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = 24

def mat(name, hexc):
    m = bpy.data.materials.new(name); m.use_nodes = True
    h = hexc.lstrip('#'); c = tuple(int(h[i:i+2], 16) / 255 for i in (0, 2, 4))
    lin = tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)
    b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*lin, 1); b.inputs['Roughness'].default_value = 0.8
    return m
M = {'cuerpo': mat('cuerpo', '#D97757'), 'cara': mat('cara', '#F4EDE4'), 'ojo': mat('ojo', '#1F1A17'),
     'chispa': mat('chispa', '#F2B544'), 'mejilla': mat('mejilla', '#EBA08A'), 'pie': mat('pie', '#8A4A33')}

# --- esqueleto ---
bpy.ops.object.armature_add(location=(0, 0, 0))
arm = bpy.context.object; arm.name = 'npc_claude_rig'; arm.data.name = 'rig'
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
root = eb[0]; root.name = 'root'; root.head = (0, 0, 0); root.tail = (0, 0.25, 0)
def bone(n, h, t, parent):
    b = eb.new(n); b.head = h; b.tail = t; b.parent = eb[parent]; return b
bone('cuerpo', (0, 0, 0.42), (0, 0, 0.95), 'root')
bone('cabeza', (0, 0, 0.95), (0, 0, 1.45), 'cuerpo')
bone('chispa', (0, 0, 1.52), (0, 0, 1.68), 'cabeza')
bone('brazo.L', (0.34, 0, 0.82), (0.46, 0, 0.5), 'cuerpo')
bone('brazo.R', (-0.34, 0, 0.82), (-0.46, 0, 0.5), 'cuerpo')
bone('pierna.L', (0.14, 0, 0.42), (0.14, 0, 0.04), 'root')
bone('pierna.R', (-0.14, 0, 0.42), (-0.14, 0, 0.04), 'root')
bpy.ops.object.mode_set(mode='OBJECT')

def attach(obj, b):
    obj.parent = arm; obj.parent_type = 'BONE'; obj.parent_bone = b
    # mantener la posición en el mundo
    pb = arm.pose.bones[b]
    obj.matrix_parent_inverse = (arm.matrix_world @ pb.matrix @ __import__('mathutils').Matrix.Translation((0, pb.length, 0))).inverted()

def sphere(name, loc, scale, m, seg=24, rings=16, b='cuerpo'):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, location=loc)
    o = bpy.context.object; o.name = name; o.scale = scale
    bpy.ops.object.transform_apply(scale=True); bpy.ops.object.shade_smooth()
    o.data.materials.append(m); attach(o, b); return o

sphere('cuerpo', (0, 0, 0.68), (0.36, 0.3, 0.36), M['cuerpo'])
sphere('cabeza', (0, 0, 1.2), (0.32, 0.29, 0.29), M['cara'], b='cabeza')
for s in (1, -1):
    sphere(f'ojo.{s}', (0.11 * s, -0.255, 1.23), (0.04, 0.02, 0.06), M['ojo'], 12, 8, 'cabeza')
    sphere(f'mejilla.{s}', (0.19 * s, -0.22, 1.13), (0.05, 0.015, 0.03), M['mejilla'], 12, 8, 'cabeza')
    sphere(f'brazo.{s}', (0.4 * s, 0, 0.64), (0.07, 0.07, 0.18), M['cuerpo'], 12, 8, 'brazo.L' if s > 0 else 'brazo.R')
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.07, depth=0.34, location=(0.14 * s, 0, 0.24))
    o = bpy.context.object; o.name = f'pierna.{s}'; o.data.materials.append(M['cuerpo']); bpy.ops.object.shade_smooth(); attach(o, 'pierna.L' if s > 0 else 'pierna.R')
    sphere(f'pie.{s}', (0.14 * s, -0.04, 0.05), (0.1, 0.14, 0.06), M['pie'], 12, 8, 'pierna.L' if s > 0 else 'pierna.R')
# chispa: una estrellita de 4 puntas (rombo alargado + otro girado)
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.012, depth=0.12, location=(0, 0, 1.52))
o = bpy.context.object; o.name = 'antena'; o.data.materials.append(M['pie']); attach(o, 'cabeza')
for i, rot in enumerate([(0, 0, 0), (0, math.pi / 2, 0)]):
    bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.05, depth=0.24, location=(0, 0, 1.64))
    o = bpy.context.object; o.name = f'chispa.{i}'
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.symmetrize(direction='POSITIVE_Z') if False else None
    bpy.ops.object.mode_set(mode='OBJECT')
    o.rotation_euler = rot if i == 0 else (math.pi, 0, 0)
    o.scale = (1, 0.35, 1) if i == 0 else (0.35, 1, 1)
    bpy.ops.object.transform_apply(rotation=False, scale=True)
    o.data.materials.append(M['chispa']); attach(o, 'chispa')

# --- animaciones ---
arm.animation_data_create()
pb = arm.pose.bones
for p in pb: p.rotation_mode = 'XYZ'
def key(frame, data):
    sc.frame_set(frame)
    for b, (loc, rot) in data.items():
        p = pb[b]
        if loc is not None: p.location = loc; p.keyframe_insert('location', frame=frame)
        if rot is not None: p.rotation_euler = [math.radians(a) for a in rot]; p.keyframe_insert('rotation_euler', frame=frame)
def action(name, frames):
    a = bpy.data.actions.new(name); arm.animation_data.action = a
    for p in pb: p.location = (0, 0, 0); p.rotation_euler = (0, 0, 0)
    for f, d in frames: key(f, d)
    for fc in a.fcurves:
        for k in fc.keyframe_points: k.interpolation = 'BEZIER'
    a.use_fake_user = True
    tr = arm.animation_data.nla_tracks.new(); tr.name = name; tr.strips.new(name, 1, a); tr.mute = True
    arm.animation_data.action = None
    return a
Z = (0, 0, 0)
# idle: respira, la cabeza se inclina un poco, la chispa gira
action('idle', [
    (1,  {'cuerpo': ((0, 0, 0), Z), 'cabeza': (None, (0, 0, -3)), 'chispa': (None, (0, 0, 0)), 'brazo.L': (None, (0, 0, 0)), 'brazo.R': (None, (0, 0, 0))}),
    (25, {'cuerpo': ((0, 0.015, 0), Z), 'cabeza': (None, (0, 0, 3)), 'chispa': (None, (0, 180, 0)), 'brazo.L': (None, (0, 0, 4)), 'brazo.R': (None, (0, 0, -4))}),
    (49, {'cuerpo': ((0, 0, 0), Z), 'cabeza': (None, (0, 0, -3)), 'chispa': (None, (0, 360, 0)), 'brazo.L': (None, (0, 0, 0)), 'brazo.R': (None, (0, 0, 0))}),
])
# walk: piernas y brazos alternados, rebote
def wk(f, s):
    return (f, {'pierna.L': (None, (28 * s, 0, 0)), 'pierna.R': (None, (-28 * s, 0, 0)), 'brazo.L': (None, (-25 * s, 0, 0)), 'brazo.R': (None, (25 * s, 0, 0)),
                'cuerpo': ((0, 0.0, 0), (0, 4 * s, 0)), 'cabeza': (None, (0, -3 * s, 0)), 'chispa': (None, (0, 0, 0))})
def up(f):
    return (f, {'cuerpo': ((0, 0.04, 0), None)})
action('walk', [wk(1, 1), up(5), wk(9, -1), up(13), wk(17, 1)])
# talk: asiente y gesticula
action('talk', [
    (1,  {'cabeza': (None, (0, 0, 0)), 'brazo.L': (None, (0, 0, 0)), 'brazo.R': (None, (0, 0, 0)), 'cuerpo': ((0, 0, 0), Z), 'chispa': (None, (0, 0, 0))}),
    (7,  {'cabeza': (None, (-8, 0, 4)), 'brazo.L': (None, (-35, 0, 20)), 'brazo.R': (None, (0, 0, 0)), 'cuerpo': ((0, 0.01, 0), Z), 'chispa': (None, (0, 90, 0))}),
    (13, {'cabeza': (None, (4, 0, -3)), 'brazo.L': (None, (-20, 0, 10)), 'brazo.R': (None, (-15, 0, -10)), 'cuerpo': ((0, 0, 0), Z), 'chispa': (None, (0, 180, 0))}),
    (19, {'cabeza': (None, (-6, 0, -2)), 'brazo.L': (None, (0, 0, 0)), 'brazo.R': (None, (-30, 0, -20)), 'cuerpo': ((0, 0.01, 0), Z), 'chispa': (None, (0, 270, 0))}),
    (25, {'cabeza': (None, (0, 0, 0)), 'brazo.L': (None, (0, 0, 0)), 'brazo.R': (None, (0, 0, 0)), 'cuerpo': ((0, 0, 0), Z), 'chispa': (None, (0, 360, 0))}),
])
# work: martilla en el banco (brazo derecho arriba y abajo, mira hacia abajo)
action('work', [
    (1,  {'brazo.R': (None, (-110, 0, -10)), 'brazo.L': (None, (-40, 0, 15)), 'cabeza': (None, (12, 0, 0)), 'cuerpo': ((0, 0, 0), (6, 0, 0)), 'chispa': (None, (0, 0, 0))}),
    (5,  {'brazo.R': (None, (-20, 0, -10)), 'brazo.L': (None, (-40, 0, 15)), 'cabeza': (None, (16, 0, 0)), 'cuerpo': ((0, -0.01, 0), (8, 0, 0)), 'chispa': (None, (0, 90, 0))}),
    (9,  {'brazo.R': (None, (-110, 0, -10)), 'brazo.L': (None, (-40, 0, 15)), 'cabeza': (None, (12, 0, 0)), 'cuerpo': ((0, 0, 0), (6, 0, 0)), 'chispa': (None, (0, 180, 0))}),
    (13, {'brazo.R': (None, (-20, 0, -10)), 'brazo.L': (None, (-40, 0, 15)), 'cabeza': (None, (16, 0, 0)), 'cuerpo': ((0, -0.01, 0), (8, 0, 0)), 'chispa': (None, (0, 270, 0))}),
    (17, {'brazo.R': (None, (-110, 0, -10)), 'brazo.L': (None, (-40, 0, 15)), 'cabeza': (None, (12, 0, 0)), 'cuerpo': ((0, 0, 0), (6, 0, 0)), 'chispa': (None, (0, 360, 0))}),
])
# carry: lleva algo con los dos brazos adelante
action('carry', [
    (1,  {'brazo.L': (None, (-75, 0, 10)), 'brazo.R': (None, (-75, 0, -10)), 'pierna.L': (None, (25, 0, 0)), 'pierna.R': (None, (-25, 0, 0)), 'cuerpo': ((0, 0, 0), (-4, 0, 0))}),
    (9,  {'brazo.L': (None, (-75, 0, 10)), 'brazo.R': (None, (-75, 0, -10)), 'pierna.L': (None, (-25, 0, 0)), 'pierna.R': (None, (25, 0, 0)), 'cuerpo': ((0, 0.03, 0), (-4, 0, 0))}),
    (17, {'brazo.L': (None, (-75, 0, 10)), 'brazo.R': (None, (-75, 0, -10)), 'pierna.L': (None, (25, 0, 0)), 'pierna.R': (None, (-25, 0, 0)), 'cuerpo': ((0, 0, 0), (-4, 0, 0))}),
])
for p in pb: p.location = (0, 0, 0); p.rotation_euler = (0, 0, 0)
sc.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', export_animations=True,
    export_animation_mode='NLA_TRACKS', export_morph_animation=False, export_apply=False, export_yup=True)
print('OK')
