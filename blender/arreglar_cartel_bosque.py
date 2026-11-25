"""Bosque de Coronda: deja configurado el Empty para volver a la plaza desde el cartel.

Uso:  blender -b -P blender/arreglar_cartel_bosque.py
- Abre blender/bosque_coronda.blend, crea (o arregla) el Empty "volver_plaza" sobre el cartel "cartel_volver", con sus
  Custom Properties: teleport = coronda_plaza (modo E, 1,2 m, "Volver a la plaza").
- El Empty suelto llamado "Empty" que había al lado del cartel (sin propiedades) se usa para eso.
- Guarda el .blend y exporta assets/models/worlds/Bosque_Coronda.glb CON las Custom Properties (Include > Custom
  Properties): sin eso el juego no ve el teleport (era lo que pasaba).
En el juego: data/scenes/bosque_coronda.json > doors (aparecés en la plaza al lado del cartel del bosque).
"""
import bpy, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND = os.path.join(ROOT, 'blender/bosque_coronda.blend')
GLB = os.path.join(ROOT, 'assets/models/worlds/Bosque_Coronda.glb')

bpy.ops.wm.open_mainfile(filepath=BLEND)
sc = bpy.context.scene
cartel = bpy.data.objects.get('cartel_volver')
if cartel is None:
    raise SystemExit('No está el cartel "cartel_volver" en el .blend')
# el cartel queda como adorno: la interacción es del Empty (así no hay dos teleports)
for k in ('teleport', 'teleport_modo', 'teleport_radio', 'teleport_texto'):
    if k in cartel.keys():
        del cartel[k]

tp = bpy.data.objects.get('volver_plaza') or bpy.data.objects.get('Empty')
if tp is None:
    tp = bpy.data.objects.new('volver_plaza', None)
    sc.collection.objects.link(tp)
tp.name = 'volver_plaza'
tp.parent = None
tp.empty_display_type = 'CUBE'
tp.empty_display_size = 1
# un volumen que abarca el cartel (±1 m escalado): al acercarte aparece "E Volver a la plaza"
tp.location = (cartel.location.x, cartel.location.y, 1.0)
tp.rotation_euler = cartel.rotation_euler.copy()
tp.scale = (1.4, 0.6, 1.0)
tp['teleport'] = 'coronda_plaza'
tp['teleport_modo'] = 'E'
tp['teleport_radio'] = 1.2
tp['teleport_texto'] = 'Volver a la plaza'

bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.object.select_all(action='DESELECT')
for o in sc.objects:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', use_selection=True, export_extras=True,
                          export_apply=True, export_yup=True, export_animations=False, export_morph_animation=False)
print('OK: volver_plaza en', tuple(round(v, 2) for v in tp.location))
