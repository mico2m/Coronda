"""
Coronda · GLB autosave
Exporta el .glb solo: cada vez que guardás el .blend (Ctrl+S) o, si querés,
cada vez que cambiás algo. Con el Studio abierto, el juego cambia el mundo
sin recargar y te deja donde estabas.

Instalar: Edit > Preferences > Add-ons > (flechita ⌄) Install from Disk… > este archivo.
Usar:     en la vista 3D apretá N > pestaña "Coronda" > activá "GLB autosave".
"""

bl_info = {
    "name": "Coronda · GLB autosave",
    "author": "Coronda",
    "version": (1, 2, 1),
    "blender": (3, 6, 0),
    "location": "Vista 3D > N > Coronda",
    "description": "Exporta el .glb solo al guardar (o al cambiar algo)",
    "category": "Import-Export",
}

import glob
import os
import shutil
import tempfile
import time

import bpy
from bpy.app.handlers import persistent

state = {
    "pending": False,     # hay que exportar en cuanto se pueda
    "changed_at": 0.0,    # último cambio (modo "al cambiar")
    "dirty": False,       # hubo cambios desde la última exportación
    "exporting": False,
    "quiet_until": 0.0,   # ignora los avisos que provoca la propia exportación
    "last_ok": 0.0,
    "took": 0.0,
    "error": "",
    "warning": "",
    "redrawn": 0.0,
}


# ---------------------------------------------------------------- a dónde exportar
def _is_project(d):
    return bool(d) and os.path.isfile(os.path.join(d, "data", "tables", "scenes.json"))


def project_root():
    """La carpeta de Coronda que contiene al .blend (o "" si el .blend está en otro lado)."""
    d = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else ""
    while d and os.path.dirname(d) != d:
        if _is_project(d):
            return d
        d = os.path.dirname(d)
    return ""


def target_path(sc):
    """Ruta absoluta del .glb, o "" si todavía no se puede saber."""
    custom = sc.coronda_glb_path.strip()
    if custom:
        p = bpy.path.abspath(custom)
        return p if p.lower().endswith(".glb") else p + ".glb"
    if not bpy.data.filepath:
        return ""
    stem = bpy.path.display_name_from_filepath(bpy.data.filepath)
    root = project_root()
    if root:  # dentro de Coronda: el .glb del proyecto que se llama igual que el .blend
        for p in glob.glob(os.path.join(root, "assets", "**", "*.glb"), recursive=True):
            if os.path.splitext(os.path.basename(p))[0].lower() == stem.lower():
                return p
        return os.path.join(root, "assets", "models", "worlds", stem + ".glb")
    return os.path.join(os.path.dirname(bpy.data.filepath), stem + ".glb")


def _nice(p):
    root = project_root()
    if root and os.path.normcase(p).startswith(os.path.normcase(root)):
        return os.path.relpath(p, root).replace("\\", "/")
    return p


# ---------------------------------------------------------------- exportar
def _window():
    wm = bpy.context.window_manager
    return wm.windows[0] if wm and wm.windows else None


def _gltf(opts):
    try:
        bpy.ops.export_scene.gltf(**opts)
    except TypeError:  # exportadores viejos no conocen alguna opción
        for k in ("use_visible", "export_apply", "export_animations", "export_morph_animation"):
            opts.pop(k, None)
        bpy.ops.export_scene.gltf(**opts)


def export_now():
    sc = bpy.context.scene
    dst = target_path(sc)
    state["pending"] = False
    if not dst:
        state["error"] = "Guardá el .blend primero (o elegí a dónde exportar)"
        return False
    tmpdir = os.path.join(tempfile.gettempdir(), "coronda_glb_autosave")
    os.makedirs(tmpdir, exist_ok=True)
    tmp = os.path.join(tmpdir, "export.glb")
    opts = dict(filepath=tmp, export_format="GLB", export_extras=True, export_yup=True,
                export_apply=sc.coronda_glb_apply, use_visible=sc.coronda_glb_visible,
                export_animations=sc.coronda_glb_anims)
    state["exporting"] = True
    t0 = time.time()
    ob = bpy.context.view_layer.objects.active
    mode = ob.mode if ob else "OBJECT"
    win = _window()
    def run(o):
        if win:
            with bpy.context.temp_override(window=win):
                _gltf(o)
        else:
            _gltf(o)

    try:
        state["warning"] = ""
        try:
            run(opts)
        except Exception as e:  # noqa: BLE001
            if not opts.get("export_animations"):
                raise
            # Bug del exportador de glTF (Blender 5.x): KeyError en get_sk_drivers al exportar un esqueleto
            # animado. Sin "Shape Keys Animation" esa parte no se ejecuta y las animaciones de huesos salen igual.
            print("[GLB autosave] el exportador falló:", str(e).strip().splitlines()[-1:], "-> reintento sin animación de shape keys")
            try:
                run(dict(opts, export_morph_animation=False))
                state["warning"] = "SHAPEKEYS"
            except Exception:  # noqa: BLE001
                run(dict(opts, export_animations=False))
                state["warning"] = "SINANIM"
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        # Se reemplaza de una: el juego nunca lee un .glb a medio escribir
        for intento in range(20):   # hasta ~6 s: el .glb pesa y algo puede tenerlo abierto un rato (el juego, el antivirus, el sincronizador)
            try:
                try:
                    os.replace(tmp, dst)
                except OSError:  # otra unidad de disco: copiar al lado y reemplazar
                    shutil.copyfile(tmp, dst + ".part")
                    os.replace(dst + ".part", dst)
                break
            except PermissionError:  # el juego justo lo estaba leyendo
                if intento == 19:
                    raise
                time.sleep(0.3)
        state["took"] = time.time() - t0
        state["last_ok"] = time.time()
        state["dirty"] = False
        state["error"] = ""
        return True
    except Exception as e:  # noqa: BLE001
        state["error"] = f"No se pudo exportar: {e}"
        print("[GLB autosave]", state["error"])
        return False
    finally:
        if ob and mode != "OBJECT" and ob.mode != mode:  # el exportador te saca de Edit Mode: volver
            try:
                if win:
                    with bpy.context.temp_override(window=win):
                        bpy.ops.object.mode_set(mode=mode)
                else:
                    bpy.ops.object.mode_set(mode=mode)
            except Exception:  # noqa: BLE001
                pass
        state["exporting"] = False
        state["quiet_until"] = time.time() + 0.6
        _redraw()


def _redraw():
    wm = bpy.context.window_manager
    for win in wm.windows if wm else []:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


# ---------------------------------------------------------------- cuándo exportar
@persistent
def on_save(*_):
    sc = bpy.context.scene
    if sc and sc.coronda_glb_autosave:
        state["pending"] = True  # se exporta un instante después, fuera del guardado


@persistent
def on_change(scene, depsgraph):
    if state["exporting"] or time.time() < state["quiet_until"]:
        return
    for u in depsgraph.updates:
        if isinstance(u.id, bpy.types.Scene) and not (u.is_updated_geometry or u.is_updated_transform):
            continue  # seleccionar, cambiar de herramienta…: el mundo no cambió
        state["dirty"] = True
        state["changed_at"] = time.time()
        return


def _dragging():
    """True mientras estás moviendo/rotando algo: se espera a que sueltes."""
    win = _window()
    try:
        return any(op.bl_idname.startswith("TRANSFORM_OT") for op in win.modal_operators) if win else False
    except Exception:  # noqa: BLE001
        return False


def tick():
    try:
        sc = bpy.context.scene
    except Exception:  # noqa: BLE001
        return 0.5
    if sc is None or state["exporting"]:
        return 0.3
    now = time.time()
    if sc.coronda_glb_autosave:
        live = sc.coronda_glb_when == "CHANGE"
        if live and state["dirty"] and now - state["changed_at"] >= sc.coronda_glb_delay:
            if bpy.context.mode == "OBJECT" and not _dragging():
                state["pending"] = True
        if state["pending"]:
            export_now()
    if now - state["redrawn"] > 1.0 and (state["dirty"] or now - state["last_ok"] < 90):
        state["redrawn"] = now  # para que el panel muestre "hace N s"
        _redraw()
    return 0.2


# ---------------------------------------------------------------- interfaz
class CORONDA_OT_glb_export(bpy.types.Operator):
    bl_idname = "coronda.glb_export"
    bl_label = "Exportar ahora"
    bl_description = "Exporta el .glb ya mismo"

    def execute(self, context):
        if export_now():
            self.report({"INFO"}, f"Exportado: {_nice(target_path(context.scene))}")
            return {"FINISHED"}
        self.report({"ERROR"}, state["error"])
        return {"CANCELLED"}


def _ago(t):
    s = int(time.time() - t)
    if s < 60:
        return f"hace {s} s"
    if s < 3600:
        return f"hace {s // 60} min"
    return time.strftime("a las %H:%M", time.localtime(t))


class CORONDA_PT_glb_autosave(bpy.types.Panel):
    bl_label = "GLB autosave"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Coronda"

    def draw_header(self, context):
        self.layout.prop(context.scene, "coronda_glb_autosave", text="")

    def draw(self, context):
        sc = context.scene
        lay = self.layout
        col = lay.column()
        col.prop(sc, "coronda_glb_when", expand=True)
        if sc.coronda_glb_when == "CHANGE":
            col.prop(sc, "coronda_glb_delay")
        col.separator()

        dst = target_path(sc)
        box = lay.box()
        box.label(text="Exporta a:", icon="EXPORT")
        box.label(text=_nice(dst) if dst else "(guardá el .blend primero)")
        box.prop(sc, "coronda_glb_path", text="Otro")
        col = lay.column()
        col.prop(sc, "coronda_glb_visible")
        col.prop(sc, "coronda_glb_apply")
        col.prop(sc, "coronda_glb_anims")
        lay.operator("coronda.glb_export", icon="FILE_REFRESH")

        if state["exporting"]:
            lay.label(text="Exportando…", icon="TIME")
        elif state["error"]:
            lay.label(text=state["error"], icon="ERROR")
        elif state["warning"] == "SHAPEKEYS":
            col = lay.column(align=True)
            col.label(text=f"Exportado {_ago(state['last_ok'])}, con animaciones", icon="CHECKMARK")
            col.label(text="(sin animación de shape keys: el")
            col.label(text="exportador de Blender falla con ella)")
        elif state["warning"]:
            col = lay.column(align=True)
            col.label(text="Exportado, pero SIN animaciones:", icon="ERROR")
            col.label(text="el exportador de Blender falló con ellas.")
            col.label(text="Mirá la consola o destildá 'Animaciones'.")
        elif not sc.coronda_glb_autosave:
            lay.label(text="Apagado", icon="PAUSE")
        elif sc.coronda_glb_when == "CHANGE" and state["dirty"]:
            msg = "Salí de Edit Mode para exportar" if context.mode != "OBJECT" else "Cambios: exporta en un momento…"
            lay.label(text=msg, icon="MODIFIER")
        elif state["last_ok"]:
            lay.label(text=f"Exportado {_ago(state['last_ok'])} ({state['took']:.1f} s)", icon="CHECKMARK")
        else:
            lay.label(text="Listo: guardá con Ctrl+S" if sc.coronda_glb_when == "SAVE" else "Listo", icon="CHECKMARK")


def _toggled(self, context):
    if self.coronda_glb_autosave:
        state["error"] = ""
        if bpy.data.filepath or self.coronda_glb_path.strip():
            state["pending"] = True  # al activarlo, una primera exportación


PROPS = {
    "coronda_glb_autosave": bpy.props.BoolProperty(
        name="GLB autosave", default=False, update=_toggled,
        description="Exportar el .glb solo"),
    "coronda_glb_when": bpy.props.EnumProperty(
        name="Cuándo",
        items=[("SAVE", "Al guardar", "Exporta cada vez que guardás el .blend (Ctrl+S)"),
               ("CHANGE", "Al cambiar algo", "Exporta un ratito después de cada cambio, sin guardar")],
        default="SAVE"),
    "coronda_glb_delay": bpy.props.FloatProperty(
        name="Esperar (s)", default=1.0, min=0.2, max=10.0, step=10, precision=1,
        description="Cuánto esperar después del último cambio antes de exportar"),
    "coronda_glb_path": bpy.props.StringProperty(
        name="Archivo .glb", subtype="FILE_PATH", default="",
        description="Vacío = automático (el .glb del proyecto que se llama igual que el .blend)"),
    "coronda_glb_visible": bpy.props.BoolProperty(
        name="Solo lo visible", default=False,
        description="No exportar lo que tengas oculto (ojito cerrado)"),
    "coronda_glb_anims": bpy.props.BoolProperty(
        name="Animaciones", default=True,
        description="Exportar las animaciones (puertas, objetos animados). Si el exportador falla con ellas, se exporta igual sin animaciones y se avisa"),
    "coronda_glb_apply": bpy.props.BoolProperty(
        name="Aplicar modificadores", default=True,
        description="Exporta los objetos con sus modificadores aplicados"),
}

CLASSES = (CORONDA_OT_glb_export, CORONDA_PT_glb_autosave)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    for k, v in PROPS.items():
        setattr(bpy.types.Scene, k, v)
    if on_save not in bpy.app.handlers.save_post:
        bpy.app.handlers.save_post.append(on_save)
    if on_change not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(on_change)
    if not bpy.app.timers.is_registered(tick):
        bpy.app.timers.register(tick, first_interval=0.5, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(tick):
        bpy.app.timers.unregister(tick)
    for lst, fn in ((bpy.app.handlers.save_post, on_save), (bpy.app.handlers.depsgraph_update_post, on_change)):
        if fn in lst:
            lst.remove(fn)
    for k in PROPS:
        if hasattr(bpy.types.Scene, k):
            delattr(bpy.types.Scene, k)
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)


if __name__ == "__main__":
    register()
