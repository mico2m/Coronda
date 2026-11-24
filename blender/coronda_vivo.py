# Coronda en vivo: addon de Blender para ver los cambios en el juego al instante.
#
# Instalar: Edit > Preferences > Add-ons > (flechita arriba a la derecha) Install from Disk… > este archivo.
# Usar: en la Vista 3D apretá N > pestaña "Coronda".
#
#  - En vivo: cada vez que cambiás algo (mover, modelar, propiedades, materiales…) exporta el .glb solo, un instante
#    después de que soltás. El juego (dev.html) cambia el mundo sin recargar la página y sin moverte de donde estás.
#  - Abrir Coronda: enciende el servidor del proyecto si hace falta (sin terminal) y abre el juego en su ventana.
#  - Seguir la vista: la cámara libre del juego copia la vista de Blender mientras la movés.
#  - Jugar desde el cursor: pone al personaje donde está el cursor 3D, mirando hacia donde mira tu vista.
#  - .glb vinculados: un .glb importado que se recarga solo cuando cambia en disco (ej. la puerta o el personaje,
#    exportados desde su propio .blend). Se usa como Collection Instance, así no perdés dónde lo pusiste.
#  - Árbol de objetos del juego (tecla O en dev.html): los códigos que cambiás ahí se guardan acá, en el objeto, y se
#    exporta solo. Guardá el .blend (Ctrl+S) para que también queden en el archivo.
#  - Revisión: cuenta spawns, puertas, colisiones, NPC y objetos, y avisa lo que el juego no va a encontrar.
#
# Blender no puede mostrar una página web adentro de la ventana, así que el juego corre al lado: Blender exporta y le
# avisa al servidor del proyecto (studio/server.js), que a su vez le avisa al juego.

bl_info = {
    "name": "Coronda en vivo",
    "author": "Coronda",
    "version": (1, 2, 0),
    "blender": (3, 6, 0),
    "location": "Vista 3D > panel lateral (N) > Coronda",
    "description": "Exporta el .glb solo mientras editás y el juego lo muestra al instante",
    "category": "Import-Export",
}

import atexit
import glob
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
import webbrowser

import bpy
from bpy.app.handlers import persistent
from mathutils import Vector

PORT = int(os.environ.get("CORONDA_PORT", "5173"))
BASE = f"http://127.0.0.1:{PORT}"

state = {
    "dirty": False,        # hubo cambios desde el último export
    "changed_at": 0.0,     # cuándo fue el último cambio
    "exporting": False,
    "quiet_until": 0.0,    # después de exportar se ignoran los avisos que genera el propio export
    "exported_at": 0.0,
    "took": 0.0,
    "error": "",
    "server_proc": None,
    "server_ok": False,
    "server_checked": 0.0,
    "view_sent": None,
    "view_t": 0.0,
}


# ---------------------------------------------------------------- proyecto y archivo
def _is_project(d):
    return bool(d) and os.path.isfile(os.path.join(d, "data", "tables", "scenes.json"))


def project_root(context=None):
    """Carpeta de Coronda: la de las preferencias, o la que contenga al .blend."""
    prefs = _prefs(context)
    if prefs and _is_project(bpy.path.abspath(prefs.project_dir)):
        return os.path.normpath(bpy.path.abspath(prefs.project_dir))
    d = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else ""
    while d and os.path.dirname(d) != d:
        if _is_project(d):
            return d
        d = os.path.dirname(d)
    return ""


_glb_items = []


def glb_items(self, context):
    """Los .glb del proyecto, para elegir a cuál exportar."""
    global _glb_items
    root = project_root(context)
    files = []
    if root:
        for p in glob.glob(os.path.join(root, "assets", "**", "*.glb"), recursive=True):
            rel = os.path.relpath(p, root).replace("\\", "/")
            if ".backup" not in rel:
                files.append(rel)
    files.sort(key=lambda r: (not r.startswith("assets/models/worlds/"), r.lower()))
    items = [("AUTO", "Automático (mismo nombre que el .blend)", "")]
    items += [(f, f.replace("assets/models/", ""), f) for f in files]
    _glb_items = items  # Blender necesita que la lista siga viva
    return _glb_items


def target_path(context):
    """Ruta del .glb (relativa al proyecto) al que se exporta esta escena."""
    sc = context.scene
    root = project_root(context)
    if not root:
        return ""
    choice = sc.coronda_target
    if choice and choice != "AUTO":
        return choice
    stem = bpy.path.display_name_from_filepath(bpy.data.filepath).lower() if bpy.data.filepath else ""
    if not stem:
        return ""
    for p in glob.glob(os.path.join(root, "assets", "**", "*.glb"), recursive=True):
        if os.path.splitext(os.path.basename(p))[0].lower() == stem:
            return os.path.relpath(p, root).replace("\\", "/")
    return f"assets/models/worlds/{bpy.path.display_name_from_filepath(bpy.data.filepath)}.glb"


def _prefs(context=None):
    ctx = context or bpy.context
    addon = ctx.preferences.addons.get(__name__)
    return addon.preferences if addon else None


# ---------------------------------------------------------------- servidor del proyecto
def _get(path, timeout=0.4):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return r.status, r.read()


def server_alive():
    try:
        st, _ = _get("/__api/tree", 0.6)
        return st == 200
    except Exception:
        return False


def start_server(root):
    """Arranca node studio/server.js escondido (si no está andando ya)."""
    if server_alive():
        return True
    node = shutil.which("node")
    if not node:
        state["error"] = "No encuentro Node.js: instalalo desde nodejs.org"
        return False
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW: sin ventana negra
    try:
        state["server_proc"] = subprocess.Popen(
            [node, os.path.join(root, "studio", "server.js"), root], cwd=root,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, creationflags=flags)
    except OSError as e:
        state["error"] = f"No pude arrancar el servidor: {e}"
        return False
    for _ in range(30):
        time.sleep(0.15)
        if server_alive():
            return True
    state["error"] = f"El servidor no respondió (¿el puerto {PORT} lo usa otro programa?)"
    return False


@atexit.register
def _stop_server():
    p = state.get("server_proc")
    if p and p.poll() is None:
        p.terminate()


def post(payload):
    """Le avisa algo al juego a través del servidor, sin trabar Blender."""
    def run():
        try:
            req = urllib.request.Request(BASE + "/__blender", data=json.dumps(payload).encode("utf-8"),
                                         headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=0.6).read()
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- pedidos del juego (árbol de objetos, tecla O)
# El juego cambia un código (Custom Property) o elige un objeto; el servidor lo guarda en un buzón y acá se lee
# cada 1/4 s en segundo plano. Se aplica en Blender (el original) y se vuelve a exportar: el juego se actualiza solo.
inbox = []


def _poll_loop():
    while state.get("polling"):
        if state.get("server_ok"):
            try:
                _, body = _get("/__blender/inbox", 1.0)
                msgs = json.loads(body or b"[]")
                if msgs:
                    inbox.extend(msgs)
            except Exception:
                pass
            time.sleep(0.25)
        else:
            time.sleep(1.0)


def apply_inbox():
    ctx = bpy.context
    changed = False
    while inbox:
        m = inbox.pop(0)
        obj = bpy.data.objects.get(str(m.get("object", "")))
        if not obj:
            state["error"] = f"El juego pidió '{m.get('object')}', pero no está en este .blend"
            continue
        if m.get("cmd") == "select" and ctx.mode == "OBJECT" and obj.name in ctx.view_layer.objects:
            for o in ctx.view_layer.objects:
                o.select_set(False)
            obj.select_set(True)
            ctx.view_layer.objects.active = obj
        elif m.get("cmd") == "setprop":
            key, val = str(m.get("key", "")), m.get("value")
            if not key:
                continue
            if val is None:
                if key in obj.keys():
                    del obj[key]
            else:
                obj[key] = val
            obj.update_tag()
            changed = True
    if changed:  # exportar ya (aunque "En vivo" esté apagado): el cambio vino del juego y lo está esperando
        state["force_export"] = True
        state["dirty"] = True
        state["changed_at"] = 0.0
        state["unsaved_from_game"] = True
        _redraw()


# ---------------------------------------------------------------- exportar
def _window():
    wm = bpy.context.window_manager
    return wm.windows[0] if wm and wm.windows else None


def export_now(context=None):
    ctx = context or bpy.context
    root = project_root(ctx)
    rel = target_path(ctx)
    state["dirty"] = False
    if not root:
        state["error"] = "Elegí la carpeta del proyecto Coronda en las preferencias del addon"
        return False
    if not rel:
        state["error"] = "Guardá el .blend o elegí a qué .glb exportar"
        return False
    dst = os.path.join(root, rel)
    tmpdir = os.path.join(tempfile.gettempdir(), "coronda_vivo")
    os.makedirs(tmpdir, exist_ok=True)
    tmp = os.path.join(tmpdir, "export.glb")
    sc = ctx.scene
    opts = dict(filepath=tmp, export_format="GLB", export_extras=True, export_yup=True, export_apply=True,
                use_visible=sc.coronda_only_visible, export_animations=True)
    state["exporting"] = True
    t0 = time.time()
    try:
        win = _window()
        if win:
            with ctx.temp_override(window=win):
                _gltf(opts)
        else:
            _gltf(opts)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        try:
            os.replace(tmp, dst)  # de una: el juego nunca lee un archivo a medio escribir
        except OSError:
            shutil.copyfile(tmp, dst + ".part")
            os.replace(dst + ".part", dst)
        post({"cmd": "exported", "path": rel})  # el juego se entera al toque
        state["took"] = time.time() - t0
        state["exported_at"] = time.time()
        state["error"] = ""
        return True
    except Exception as e:  # noqa: BLE001
        state["error"] = f"No se pudo exportar: {e}"
        return False
    finally:
        state["exporting"] = False
        state["dirty"] = False
        state["quiet_until"] = time.time() + 0.5
        _redraw()


def _gltf(opts):
    try:
        bpy.ops.export_scene.gltf(**opts)
    except TypeError:  # versiones viejas del exportador no tienen alguna opción
        for k in ("use_visible", "export_apply", "export_animations"):
            opts.pop(k, None)
        bpy.ops.export_scene.gltf(**opts)


def _redraw():
    for win in bpy.context.window_manager.windows if bpy.context.window_manager else []:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


# ---------------------------------------------------------------- vista de Blender -> juego
def _view_region():
    wm = bpy.context.window_manager
    for win in wm.windows if wm else []:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                return area.spaces.active.region_3d
    return None


def to_three(v):
    """Blender (z arriba) -> Three.js (y arriba): x, z, -y. Lo mismo que hace el exportador .glb."""
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]


def view_pose():
    r3d = _view_region()
    if not r3d:
        return None
    m = r3d.view_matrix.inverted()
    pos = m.translation
    fwd = -(m.to_3x3() @ Vector((0.0, 0.0, 1.0)))
    f = Vector(to_three(fwd))
    yaw = math.atan2(-f.x, -f.z)            # la cámara del juego mira hacia -z con yaw 0
    pitch = math.asin(max(-1.0, min(1.0, f.y)))
    return {"pos": to_three(pos), "yaw": round(yaw, 4), "pitch": round(pitch, 4)}


# ---------------------------------------------------------------- avisos de cambios y reloj
@persistent
def on_depsgraph(scene, depsgraph):
    if state["exporting"] or time.time() < state["quiet_until"]:
        return
    if not getattr(scene, "coronda_live", False):
        return
    for u in depsgraph.updates:
        if isinstance(u.id, bpy.types.Scene) and not (u.is_updated_geometry or u.is_updated_transform):
            continue  # elegir objetos, cambiar de herramienta…: no cambia el mundo
        state["dirty"] = True
        state["changed_at"] = time.time()
        return


@persistent
def on_save(*_):
    state["unsaved_from_game"] = False


def _busy():
    """True mientras estás arrastrando algo (mover, rotar…): se espera a que sueltes."""
    win = _window()
    mods = getattr(win, "modal_operators", None) if win else None
    try:
        return any(op.bl_idname.startswith(("TRANSFORM_OT", "VIEW3D_OT_ruler", "MESH_OT_loopcut")) for op in mods) if mods else False
    except Exception:
        return False


def tick():
    try:
        sc = bpy.context.scene
    except Exception:
        return 0.5
    if sc is None:
        return 0.5
    now = time.time()
    if now - state["server_checked"] > 3:
        state["server_checked"] = now
        state["server_ok"] = server_alive()
    if inbox:
        apply_inbox()
    forced = state.get("force_export")
    if (getattr(sc, "coronda_live", False) or forced) and state["dirty"] and not state["exporting"]:
        if (forced or now - state["changed_at"] >= sc.coronda_delay) and bpy.context.mode == "OBJECT" and not _busy():
            state["force_export"] = False
            export_now()
    if getattr(sc, "coronda_auto_reload", True) and now - state.get("linked_t", 0) > 0.8 and not state["exporting"]:
        state["linked_t"] = now
        if linked_collections():
            check_linked()
    if now - state.get("redrawn", 0) > 1.0 and (state["dirty"] or now - state["exported_at"] < 90):
        state["redrawn"] = now  # para que el panel muestre "hace N s" y el estado de los cambios
        _redraw()
    if getattr(sc, "coronda_follow_view", False) and now - state["view_t"] > 0.08:
        pose = view_pose()
        if pose and pose != state["view_sent"]:
            state["view_sent"] = pose
            state["view_t"] = now
            post({"cmd": "view", **pose})
    return 0.1


# ---------------------------------------------------------------- revisión de la escena
def review(context):
    """Lo que el juego va a encontrar en esta escena, y lo que le va a faltar."""
    objs = list(context.scene.objects)
    def props(o):
        return {k: o[k] for k in o.keys() if not k.startswith("_")}
    spawns = [o for o in objs if o.name.lower().startswith("spawn")]
    doors = [o for o in objs if any(k in props(o) for k in ("puerta", "teleport"))]
    cols = [o for o in objs if o.name.lower().startswith("col_")]
    npcs = [o for o in objs if o.name.lower().startswith("npc_")]
    prefabs = [o for o in objs if "objeto" in props(o)]
    notes = []
    if not any(o.name.lower() in ("spawn",) or o.name.lower().startswith("spawn.") for o in spawns):
        notes.append(("ERROR", "No hay un Empty 'spawn' (donde aparece el personaje)"))
    if not cols:
        notes.append(("INFO", "Sin col_: nada choca y no hay suelo para el personaje"))
    root = project_root(context)
    names = {o.name.lower() for o in objs}
    for o in prefabs:
        v = str(o["objeto"]).strip()
        rel = v if ("/" in v or v.lower().endswith(".glb")) else f"assets/models/objects/{v}.glb"
        if root and not os.path.isfile(os.path.join(root, rel)):
            notes.append(("ERROR", f"{o.name}: no existe {rel}"))
    for o in doors:
        v = str(props(o).get("puerta", props(o).get("teleport", ""))).strip()
        if v and ":" not in v:
            key = v if v.lower().startswith("spawn") else f"spawn_{v}"
            if key.lower() not in names and not _is_scene_id(root, v):
                notes.append(("ERROR", f"{o.name}: no hay un Empty '{key}' en esta escena"))
    return {"spawns": len(spawns), "doors": len(doors), "cols": len(cols), "npcs": len(npcs), "prefabs": len(prefabs), "notes": notes}


def _is_scene_id(root, v):
    try:
        with open(os.path.join(root, "data", "tables", "scenes.json"), encoding="utf-8") as f:
            return v in json.load(f)
    except Exception:
        return False


# ---------------------------------------------------------------- operadores
class CORONDA_OT_export(bpy.types.Operator):
    bl_idname = "coronda.export"
    bl_label = "Exportar ahora"
    bl_description = "Exporta el .glb al proyecto Coronda (el juego lo muestra al instante)"

    def execute(self, context):
        if context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        ok = export_now(context)
        self.report({"INFO"} if ok else {"ERROR"}, f"Exportado: {target_path(context)}" if ok else state["error"])
        return {"FINISHED"} if ok else {"CANCELLED"}


class CORONDA_OT_open(bpy.types.Operator):
    bl_idname = "coronda.open"
    bl_label = "Abrir Coronda"
    bl_description = "Enciende el servidor del proyecto (si hace falta) y abre el juego en modo desarrollador"

    def execute(self, context):
        root = project_root(context)
        if not root:
            self.report({"ERROR"}, "Elegí la carpeta del proyecto Coronda en las preferencias del addon")
            return {"CANCELLED"}
        if not start_server(root):
            self.report({"ERROR"}, state["error"])
            return {"CANCELLED"}
        state["server_ok"] = True
        url = f"http://localhost:{PORT}/dev.html"
        prefs = _prefs(context)
        if prefs and prefs.app_window and _open_app_window(url):
            return {"FINISHED"}
        webbrowser.open(url)
        return {"FINISHED"}


def _open_app_window(url):
    """Una ventana propia de Edge o Chrome (sin pestañas), cómoda para tenerla al lado de Blender."""
    cands = []
    for base in (os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                      os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
    exe = next((c for c in cands if os.path.isfile(c)), None)
    if not exe:
        return False
    profile = os.path.join(tempfile.gettempdir(), "coronda_vivo", "ventana")
    try:
        subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                          "--no-default-browser-check", "--window-size=960,720",
                          "--autoplay-policy=no-user-gesture-required"])
        return True
    except OSError:
        return False


class CORONDA_OT_view(bpy.types.Operator):
    bl_idname = "coronda.view"
    bl_label = "Ir a la vista"
    bl_description = "Pone la cámara libre del juego exactamente donde está tu vista de Blender"

    def execute(self, context):
        pose = view_pose()
        if not pose:
            return {"CANCELLED"}
        post({"cmd": "view", **pose})
        return {"FINISHED"}


class CORONDA_OT_play(bpy.types.Operator):
    bl_idname = "coronda.play"
    bl_label = "Jugar desde el cursor"
    bl_description = "Pone al personaje donde está el cursor 3D, mirando hacia donde mira tu vista"

    def execute(self, context):
        pose = view_pose() or {"yaw": 0}
        post({"cmd": "play", "pos": to_three(context.scene.cursor.location), "yaw": pose["yaw"]})
        return {"FINISHED"}


class CORONDA_OT_pick_folder(bpy.types.Operator):
    bl_idname = "coronda.pick_folder"
    bl_label = "Elegir carpeta"
    bl_description = "Carpeta del proyecto Coronda (la que tiene index.html, data y assets)"
    directory: bpy.props.StringProperty(subtype="DIR_PATH")

    def invoke(self, context, event):
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        d = os.path.normpath(self.directory)
        if not _is_project(d):
            self.report({"ERROR"}, "Esa carpeta no es Coronda (no tiene data/tables/scenes.json)")
            return {"CANCELLED"}
        _prefs(context).project_dir = d
        return {"FINISHED"}



# ---------------------------------------------------------------- .glb vinculados (se recargan solos)
# "Vincular un .glb" lo importa a una colección aparte (fuera de la escena) y pone una Collection Instance donde está
# el cursor. Cuando ese .glb cambia en disco (lo exportaste desde otro .blend), la colección se vuelve a importar sola y
# todas sus instancias se actualizan, sin perder dónde las pusiste. Si el .glb está en assets/models/objects, la
# instancia ya lleva la Custom Property "objeto": es un objeto reutilizable de Coronda listo para exportar.
LINK_KEY = "coronda_glb"


def linked_collections():
    return [c for c in bpy.data.collections if c.get(LINK_KEY)]


def _abs_glb(path):
    return os.path.normpath(bpy.path.abspath(path))


def _file_sig(path):
    try:
        st = os.stat(path)
        return f"{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        return ""


def load_into(coll, path):
    """Importa el .glb y deja sus objetos (solo ellos) adentro de coll. Devuelve cuántos objetos quedaron."""
    win = _window()
    view_layer = bpy.context.view_layer
    keep_sel = [o.name for o in bpy.context.selected_objects] if hasattr(bpy.context, "selected_objects") else []
    keep_act = view_layer.objects.active.name if view_layer.objects.active else None
    old = list(coll.all_objects)
    before = set(bpy.data.objects)
    state["exporting"] = True  # que el import no dispare una exportación en vivo
    try:
        if win:
            with bpy.context.temp_override(window=win):
                bpy.ops.import_scene.gltf(filepath=path)
        else:
            bpy.ops.import_scene.gltf(filepath=path)
    finally:
        state["exporting"] = False
        state["quiet_until"] = time.time() + 0.5
    new = [o for o in bpy.data.objects if o not in before]
    for o in old:  # lo de la versión anterior se va
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:  # su malla (o huesos) tampoco queda dando vueltas
            for bucket in (bpy.data.meshes, bpy.data.armatures, bpy.data.curves, bpy.data.lights, bpy.data.cameras):
                try:
                    bucket.remove(data)
                    break
                except (TypeError, ReferenceError, RuntimeError):
                    continue
    for o in new:  # lo nuevo sale de la escena y va solo a la colección vinculada
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
    # se devuelve la selección que tenías
    for o in view_layer.objects:
        o.select_set(o.name in keep_sel)
    if keep_act and keep_act in view_layer.objects:
        view_layer.objects.active = view_layer.objects[keep_act]
    coll[LINK_KEY + "_sig"] = _file_sig(path)
    coll[LINK_KEY + "_at"] = time.time()
    return len(new)


def add_instance(context, coll):
    """Una Collection Instance de coll en el cursor 3D (con "objeto" si es un objeto de Coronda)."""
    path = _abs_glb(coll[LINK_KEY])
    stem = os.path.splitext(os.path.basename(path))[0]
    e = bpy.data.objects.new(stem, None)
    e.instance_type = "COLLECTION"
    e.instance_collection = coll
    e.empty_display_type = "PLAIN_AXES"
    e.empty_display_size = 0.5
    e.location = context.scene.cursor.location
    root = project_root(context)
    if root:
        rel = os.path.relpath(path, root).replace("\\", "/")
        if rel.startswith("assets/models/objects/"):
            e["objeto"] = stem
    (context.collection or context.scene.collection).objects.link(e)
    for o in context.view_layer.objects:
        o.select_set(False)
    e.select_set(True)
    context.view_layer.objects.active = e
    return e


def check_linked():
    """Vuelve a importar los .glb vinculados que cambiaron en disco. Devuelve los nombres actualizados."""
    done = []
    if bpy.context.mode != "OBJECT":
        return done
    own = ""
    try:
        root = project_root()
        rel = target_path(bpy.context)
        own = os.path.normpath(os.path.join(root, rel)) if root and rel else ""
    except Exception:
        pass
    for coll in linked_collections():
        path = _abs_glb(coll[LINK_KEY])
        if path == own:
            continue  # el .glb que exporta esta misma escena: no se recarga a sí mismo
        sig = _file_sig(path)
        if not sig or sig == coll.get(LINK_KEY + "_sig"):
            continue
        # se espera a que termine de escribirse: el tamaño tiene que repetirse en dos vueltas seguidas
        pend = state.setdefault("pending_sig", {})
        if pend.get(coll.name) != sig:
            pend[coll.name] = sig
            continue
        pend.pop(coll.name, None)
        try:
            load_into(coll, path)
            done.append(coll.name)
        except Exception as e:  # noqa: BLE001
            state["error"] = f"No se pudo recargar {os.path.basename(path)}: {e}"
    if done:
        _redraw()
    return done


class CORONDA_OT_link_glb(bpy.types.Operator):
    bl_idname = "coronda.link_glb"
    bl_label = "Vincular un .glb…"
    bl_description = ("Importa un .glb que se recarga solo cada vez que ese archivo cambia, y lo pone en el cursor 3D "
                      "(como Collection Instance: movela o duplicala con Alt+D)")
    filepath: bpy.props.StringProperty(subtype="FILE_PATH")
    filter_glob: bpy.props.StringProperty(default="*.glb;*.gltf", options={"HIDDEN"})

    def invoke(self, context, event):
        root = project_root(context)
        if root and not self.filepath:
            self.filepath = os.path.join(root, "assets", "models", "objects", "")
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        path = os.path.normpath(self.filepath)
        if not os.path.isfile(path):
            self.report({"ERROR"}, "Elegí un archivo .glb")
            return {"CANCELLED"}
        if context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        coll = next((c for c in linked_collections() if _abs_glb(c[LINK_KEY]) == path), None)
        if not coll:
            coll = bpy.data.collections.new("glb: " + os.path.basename(path))
            coll[LINK_KEY] = bpy.path.relpath(path) if bpy.data.filepath else path
            coll.use_fake_user = True  # vive fuera de la escena: no se exporta dos veces, solo sus instancias
            try:
                n = load_into(coll, path)
            except Exception as e:  # noqa: BLE001
                bpy.data.collections.remove(coll)
                self.report({"ERROR"}, f"No se pudo importar: {e}")
                return {"CANCELLED"}
            self.report({"INFO"}, f"Vinculado {os.path.basename(path)} ({n} objetos): se recarga solo")
        add_instance(context, coll)
        return {"FINISHED"}


class CORONDA_OT_glb_action(bpy.types.Operator):
    bl_idname = "coronda.glb_action"
    bl_label = ".glb vinculado"
    coll: bpy.props.StringProperty()
    action: bpy.props.EnumProperty(items=[("RELOAD", "Recargar", "Volver a importar ahora"),
                                          ("ADD", "Otra copia", "Poner otra instancia en el cursor 3D"),
                                          ("UNLINK", "Quitar", "Borra el vínculo y todas sus instancias")])

    @classmethod
    def description(cls, context, props):
        return {"RELOAD": "Volver a importar este .glb ahora", "ADD": "Poner otra copia en el cursor 3D",
                "UNLINK": "Quitar el vínculo y todas sus copias de la escena"}[props.action]

    def execute(self, context):
        coll = bpy.data.collections.get(self.coll)
        if not coll:
            return {"CANCELLED"}
        if self.action == "RELOAD":
            if context.mode != "OBJECT":
                bpy.ops.object.mode_set(mode="OBJECT")
            load_into(coll, _abs_glb(coll[LINK_KEY]))
        elif self.action == "ADD":
            add_instance(context, coll)
        else:
            for o in [o for o in bpy.data.objects if o.instance_collection == coll]:
                bpy.data.objects.remove(o, do_unlink=True)
            for o in list(coll.all_objects):
                bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.collections.remove(coll)
        _redraw()
        return {"FINISHED"}


class CORONDA_PT_linked(bpy.types.Panel):
    bl_label = ".glb vinculados"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Coronda"
    bl_parent_id = "CORONDA_PT_main"

    def draw(self, context):
        lay = self.layout
        lay.operator("coronda.link_glb", icon="LINKED")
        colls = linked_collections()
        if not colls:
            lay.label(text="Se recargan solos al exportarlos", icon="INFO")
            return
        lay.prop(context.scene, "coronda_auto_reload")
        for c in colls:
            box = lay.box()
            row = box.row(align=True)
            n = sum(1 for o in bpy.data.objects if o.instance_collection == c)
            path = _abs_glb(c[LINK_KEY])
            ok = os.path.isfile(path)
            row.label(text=f"{os.path.basename(path)} · {n} cop{'ia' if n == 1 else 'ias'}", icon="FILE_3D" if ok else "ERROR")
            for act, icon in (("RELOAD", "FILE_REFRESH"), ("ADD", "ADD"), ("UNLINK", "X")):
                op = row.operator("coronda.glb_action", text="", icon=icon)
                op.coll, op.action = c.name, act
            at = c.get(LINK_KEY + "_at")
            sub = box.row()
            sub.scale_y = 0.8
            sub.label(text=("No encuentro el archivo" if not ok else f"Actualizado {_ago(at)}" if at else ""))

# ---------------------------------------------------------------- panel
def _ago(t):
    s = time.time() - t
    return "recién" if s < 2 else f"hace {int(s)} s" if s < 60 else f"hace {int(s // 60)} min"


class CORONDA_PT_main(bpy.types.Panel):
    bl_label = "Coronda en vivo"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Coronda"

    def draw(self, context):
        lay = self.layout
        sc = context.scene
        root = project_root(context)

        box = lay.box()
        if root:
            box.label(text=os.path.basename(root), icon="FILE_FOLDER")
        else:
            box.label(text="No encuentro el proyecto Coronda", icon="ERROR")
            box.operator("coronda.pick_folder", icon="FILEBROWSER")
            return
        box.prop(sc, "coronda_target", text="")
        rel = target_path(context)
        box.label(text=f"→ {rel}" if rel else "Guardá el .blend para exportar", icon="EXPORT")

        col = lay.column(align=True)
        col.scale_y = 1.4
        col.prop(sc, "coronda_live", text="En vivo" if not sc.coronda_live else "En vivo: exportando al cambiar",
                 toggle=True, icon="REC" if sc.coronda_live else "PLAY")
        row = lay.row(align=True)
        row.operator("coronda.export", icon="EXPORT")
        row.operator("coronda.open", icon="URL")

        st = lay.column(align=True)
        st.scale_y = 0.85
        if state["error"]:
            st.label(text=state["error"], icon="ERROR")
        elif state["exporting"]:
            st.label(text="Exportando…", icon="TIME")
        elif state["dirty"] and sc.coronda_live:
            st.label(text="Cambios: exporta cuando sueltes", icon="TIME")
        elif state["exported_at"]:
            st.label(text=f"Exportado {_ago(state['exported_at'])} ({state['took']:.2f} s)", icon="CHECKMARK")
        if state.get("unsaved_from_game"):
            st.label(text="Hay códigos cambiados desde el juego: guardá el .blend (Ctrl+S)", icon="FILE_TICK")
        st.label(text="Servidor andando" if state["server_ok"] else "Servidor apagado (lo enciende Abrir Coronda)",
                 icon="LINKED" if state["server_ok"] else "UNLINKED")


class CORONDA_PT_game(bpy.types.Panel):
    bl_label = "En el juego"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Coronda"
    bl_parent_id = "CORONDA_PT_main"

    def draw(self, context):
        lay = self.layout
        sc = context.scene
        lay.prop(sc, "coronda_follow_view", toggle=True, icon="CAMERA_DATA")
        row = lay.row(align=True)
        row.operator("coronda.view", icon="VIEW_CAMERA")
        row.operator("coronda.play", icon="PIVOT_CURSOR")
        lay.label(text="El juego tiene que estar abierto", icon="INFO")


class CORONDA_PT_review(bpy.types.Panel):
    bl_label = "Revisión"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Coronda"
    bl_parent_id = "CORONDA_PT_main"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        lay = self.layout
        r = review(context)
        grid = lay.grid_flow(columns=2, align=True)
        for icon, label, n in (("EMPTY_ARROWS", "Spawns", r["spawns"]), ("OUTLINER_OB_EMPTY", "Puertas", r["doors"]),
                               ("MOD_PHYSICS", "Colisiones", r["cols"]), ("ARMATURE_DATA", "NPC", r["npcs"]),
                               ("LINKED", "Objetos", r["prefabs"])):
            grid.label(text=f"{label}: {n}", icon=icon)
        for kind, text in r["notes"][:8]:
            lay.label(text=text, icon="ERROR" if kind == "ERROR" else "INFO")
        if not r["notes"]:
            lay.label(text="Todo en orden", icon="CHECKMARK")
        lay.prop(context.scene, "coronda_only_visible")
        lay.prop(context.scene, "coronda_delay")


class CORONDA_Prefs(bpy.types.AddonPreferences):
    bl_idname = __name__
    project_dir: bpy.props.StringProperty(name="Carpeta del proyecto", subtype="DIR_PATH",
                                          description="La carpeta de Coronda (la que tiene index.html, data y assets)")
    app_window: bpy.props.BoolProperty(name="Abrir el juego en una ventana propia (Edge o Chrome)", default=True)

    def draw(self, context):
        self.layout.prop(self, "project_dir")
        self.layout.prop(self, "app_window")


CLASSES = (CORONDA_Prefs, CORONDA_OT_export, CORONDA_OT_open, CORONDA_OT_view, CORONDA_OT_play,
           CORONDA_OT_pick_folder, CORONDA_OT_link_glb, CORONDA_OT_glb_action,
           CORONDA_PT_main, CORONDA_PT_game, CORONDA_PT_linked, CORONDA_PT_review)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    S = bpy.types.Scene
    S.coronda_live = bpy.props.BoolProperty(name="En vivo", default=False,
                                            description="Exportar el .glb solo cada vez que cambiás algo")
    S.coronda_target = bpy.props.EnumProperty(name="Exportar a", items=glb_items,
                                              description="A qué .glb del proyecto se exporta esta escena")
    S.coronda_only_visible = bpy.props.BoolProperty(name="Solo lo visible", default=False,
                                                    description="No exportar lo que está oculto en Blender")
    S.coronda_delay = bpy.props.FloatProperty(name="Espera", default=0.6, min=0.2, max=5.0, subtype="TIME", unit="TIME",
                                              description="Cuánto esperar después del último cambio para exportar")
    S.coronda_follow_view = bpy.props.BoolProperty(name="Seguir la vista", default=False,
                                                   description="La cámara libre del juego copia tu vista de Blender mientras la movés")
    S.coronda_auto_reload = bpy.props.BoolProperty(name="Recargar solos al cambiar", default=True,
                                                   description="Volver a importar los .glb vinculados cuando cambian en disco")
    bpy.app.handlers.depsgraph_update_post.append(on_depsgraph)
    bpy.app.handlers.save_post.append(on_save)
    state["polling"] = True
    threading.Thread(target=_poll_loop, daemon=True).start()
    if not bpy.app.timers.is_registered(tick):
        bpy.app.timers.register(tick, first_interval=1.0, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(tick):
        bpy.app.timers.unregister(tick)
    state["polling"] = False
    if on_save in bpy.app.handlers.save_post:
        bpy.app.handlers.save_post.remove(on_save)
    if on_depsgraph in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(on_depsgraph)
    S = bpy.types.Scene
    for p in ("coronda_live", "coronda_target", "coronda_only_visible", "coronda_delay", "coronda_follow_view",
              "coronda_auto_reload"):
        if hasattr(S, p):
            delattr(S, p)
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    _stop_server()


if __name__ == "__main__":
    register()
