#!/usr/bin/env python3
"""Genera assets/models/objects/tienda.glb (la Carpintería de Claude) sin Blender ni librerías.

Uso (desde la carpeta del proyecto):   python3 blender/generar_tienda.py

Es un modelo base low poly con colores lisos (el juego no usa luces). Sirve para probar todo el sistema ya;
cuando tengas tu propio modelo, reemplazá el .glb conservando los NOMBRES de los Empties y de los col_… (ver abajo).

Medidas (metros, Y arriba, origen = centro del piso del edificio). El frente (puerta) mira a +Z (como el frente de Blender -Y).
  Edificio 10 x 20 m.  Sala de ventas: z de 2 a 10.  Taller (fabricación): z de -10 a 2.

Empties que usa el juego (todos con la flecha de frente hacia donde mira el NPC / jugador):
  pos_mostrador   donde se para Claude detrás del mostrador (mira al cliente)
  pos_cliente     donde se para el jugador frente al mostrador;  cola_1 … cola_5  la fila de espera
  pos_taller      donde Claude trabaja el mueble;  banco_obra  sobre el banco: ahí se ve el mueble en construcción
  pos_entrada     justo adentro de la puerta;  pos_afuera  justo afuera
  slot_01 … slot_50   grilla de 5 x 10 de la sala de fabricación (un pedido por slot, 1 m de separación)
Colisiones: todo objeto col_… (sólido e invisible).  El techo se llama «techo» (el juego lo oculta al entrar).
"""
import json
import math
import os
import struct

H = 3.3          # alto de paredes
T = 0.3          # grosor de paredes
SLOT_COLS, SLOT_ROWS, SLOT_STEP = 5, 10, 1.0
SLOT_X0, SLOT_Z0 = -3.0, 0.5   # centro del slot_01 (columna 0, fila 0); las filas avanzan hacia -Z

COLORS = {
    'madera': 0xC99A62, 'cemento': 0x8C8F94, 'slot': 0x6A6E73, 'pared': 0xEADCB8, 'techo': 0xA94C34,
    'mostrador': 0x80502A, 'mostrador_tapa': 0xB07A45, 'estante': 0x6B4423, 'banco': 0x9A6A3A,
    'tablones': 0xD2A66B, 'tronco': 0x7B5230, 'cartel': 0xE9B949, 'cartel_borde': 0x5A3A1E,
    'herramienta': 0x5E6670, 'col': 0xFF00FF,
}


def rgba(h):
    return [((h >> 16) & 255) / 255.0, ((h >> 8) & 255) / 255.0, (h & 255) / 255.0, 1.0]


def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


class Geo:
    def __init__(self):
        self.pos, self.nor, self.idx = [], [], []

    def quad(self, a, b, c, d, expect):
        """Cuadrilátero a-b-c-d; se ordena solo para que la cara mire hacia `expect` (normal exterior)."""
        n = cross(sub(b, a), sub(c, a))
        if dot(n, expect) < 0:
            a, b, c, d = a, d, c, b
            n = cross(sub(b, a), sub(c, a))
        ln = math.sqrt(dot(n, n)) or 1.0
        n = (n[0] / ln, n[1] / ln, n[2] / ln)
        i = len(self.pos)
        self.pos += [a, b, c, d]
        self.nor += [n] * 4
        self.idx += [i, i + 1, i + 2, i, i + 2, i + 3]

    def tri(self, a, b, c, expect):
        n = cross(sub(b, a), sub(c, a))
        if dot(n, expect) < 0:
            b, c = c, b
            n = cross(sub(b, a), sub(c, a))
        ln = math.sqrt(dot(n, n)) or 1.0
        n = (n[0] / ln, n[1] / ln, n[2] / ln)
        i = len(self.pos)
        self.pos += [a, b, c]
        self.nor += [n] * 3
        self.idx += [i, i + 1, i + 2]

    def box(self, x0, x1, y0, y1, z0, z1):
        p = lambda x, y, z: (x, y, z)
        self.quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1), (1, 0, 0))
        self.quad(p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1), (-1, 0, 0))
        self.quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), (0, 1, 0))
        self.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), (0, -1, 0))
        self.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), (0, 0, 1))
        self.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0), (0, 0, -1))


class Builder:
    def __init__(self):
        self.meshes = []      # [{name, parts: {material: Geo}}]
        self.nodes = []
        self.materials = {}   # clave -> índice

    def mesh(self, name, parts, extras=None):
        self.meshes.append({'name': name, 'parts': parts})
        node = {'name': name, 'mesh': len(self.meshes) - 1}
        if extras: node['extras'] = extras
        self.nodes.append(node)

    def empty(self, name, pos, yaw_deg=0.0, extras=None):
        node = {'name': name, 'translation': [round(v, 4) for v in pos]}
        if yaw_deg:
            h = math.radians(yaw_deg) / 2
            node['rotation'] = [0, round(math.sin(h), 6), 0, round(math.cos(h), 6)]
        if extras: node['extras'] = extras
        self.nodes.append(node)

    def mat(self, key):
        if key not in self.materials:
            self.materials[key] = len(self.materials)
        return self.materials[key]

    def write(self, path):
        blob = bytearray()
        views, accessors, meshes_json = [], [], []

        def add_view(data, target):
            while len(blob) % 4: blob.append(0)
            views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data), 'target': target})
            blob.extend(data)
            return len(views) - 1

        for m in self.meshes:
            prims = []
            for key, g in m['parts'].items():
                if not g.idx: continue
                vp = add_view(b''.join(struct.pack('<3f', *p) for p in g.pos), 34962)
                vn = add_view(b''.join(struct.pack('<3f', *n) for n in g.nor), 34962)
                vi = add_view(b''.join(struct.pack('<H', i) for i in g.idx), 34963)
                mn = [min(p[k] for p in g.pos) for k in range(3)]
                mx = [max(p[k] for p in g.pos) for k in range(3)]
                accessors.append({'bufferView': vp, 'componentType': 5126, 'count': len(g.pos), 'type': 'VEC3', 'min': mn, 'max': mx})
                accessors.append({'bufferView': vn, 'componentType': 5126, 'count': len(g.nor), 'type': 'VEC3'})
                accessors.append({'bufferView': vi, 'componentType': 5123, 'count': len(g.idx), 'type': 'SCALAR'})
                a = len(accessors) - 3
                prims.append({'attributes': {'POSITION': a, 'NORMAL': a + 1}, 'indices': a + 2, 'material': self.mat(key)})
            meshes_json.append({'name': m['name'], 'primitives': prims})

        mats = [None] * len(self.materials)
        for key, i in self.materials.items():
            mats[i] = {'name': key, 'doubleSided': True,
                       'pbrMetallicRoughness': {'baseColorFactor': rgba(COLORS[key]), 'metallicFactor': 0.0, 'roughnessFactor': 1.0}}
        gltf = {
            'asset': {'version': '2.0', 'generator': 'coronda/generar_tienda.py'},
            'scene': 0, 'scenes': [{'name': 'tienda', 'nodes': list(range(len(self.nodes)))}],
            'nodes': self.nodes, 'meshes': meshes_json, 'materials': mats,
            'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}],
        }
        js = json.dumps(gltf, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        while len(blob) % 4: blob.append(0)
        total = 12 + 8 + len(js) + 8 + len(blob)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(struct.pack('<4sII', b'glTF', 2, total))
            f.write(struct.pack('<I4s', len(js), b'JSON')); f.write(js)
            f.write(struct.pack('<I4s', len(blob), b'BIN\x00')); f.write(blob)
        return total


def boxes(boxlist):
    g = Geo()
    for b in boxlist: g.box(*b)
    return g


def build():
    b = Builder()
    X0, X1, Z0, Z1 = -5.0, 5.0, -10.0, 10.0

    # ---- Pisos ----
    b.mesh('piso_tienda', {'madera': boxes([(X0, X1, 0, 0.08, 2.0, Z1)])})
    b.mesh('piso_taller', {'cemento': boxes([(X0, X1, 0, 0.08, Z0, 2.0)])})
    pads = Geo()
    for r in range(SLOT_ROWS):
        for c in range(SLOT_COLS):
            cx, cz = SLOT_X0 + c * SLOT_STEP, SLOT_Z0 - r * SLOT_STEP
            pads.box(cx - 0.42, cx + 0.42, 0.08, 0.095, cz - 0.42, cz + 0.42)
    b.mesh('piso_slots', {'slot': pads})

    # ---- Paredes (con puerta al frente de 2,5 m y paso al taller de 2 m) ----
    wl = [
        (X0, X0 + T, 0, H, Z0, Z1),                    # izquierda
        (X1 - T, X1, 0, H, Z0, Z1),                    # derecha
        (X0, X1, 0, H, Z0, Z0 + T),                    # fondo
        (X0, -1.25, 0, H, Z1 - T, Z1),                 # frente, a la izquierda de la puerta
        (1.25, X1, 0, H, Z1 - T, Z1),                  # frente, a la derecha
        (-1.25, 1.25, 2.5, H, Z1 - T, Z1),             # dintel de la puerta
        (X0, 2.5, 0, H, 2.0 - T / 2, 2.0 + T / 2),     # divisoria taller / ventas (izquierda)
        (4.5, X1, 0, H, 2.0 - T / 2, 2.0 + T / 2),     # divisoria (derecha)
        (2.5, 4.5, 2.5, H, 2.0 - T / 2, 2.0 + T / 2),  # dintel del paso
    ]
    walls = boxes(wl)
    for z, nz in ((Z1, 1), (Z0, -1)):                  # triángulos de los frentes del techo a dos aguas
        walls.tri((X0, H, z), (X1, H, z), (0, 5.0, z), (0, 0, nz))
    b.mesh('paredes', {'pared': walls})

    # ---- Techo a dos aguas (se llama «techo»: el juego lo oculta cuando entrás) ----
    roof = Geo()
    ex, ey, ry = 5.6, 3.0, 5.1
    for s in (-1, 1):
        a, c = (s * ex, ey, Z1 + 0.6), (s * ex, ey, Z0 - 0.6)
        r1, r2 = (0, ry, Z1 + 0.6), (0, ry, Z0 - 0.6)
        roof.quad(a, r1, r2, c, (s * 0.35, 1, 0))
    b.mesh('techo', {'techo': roof})

    # ---- Mobiliario ----
    counter = Geo(); top = Geo()
    counter.box(X0 + T, 1.5, 0, 1.05, 5.1, 5.9)
    top.box(X0 + T, 1.6, 1.05, 1.12, 5.0, 6.0)
    b.mesh('mostrador', {'mostrador': counter, 'mostrador_tapa': top})
    b.mesh('estantes', {'estante': boxes([
        (X0 + T, X0 + T + 0.45, 0.0, 2.2, 2.4, 4.9),        # estante detrás del mostrador
        (X0 + T, X0 + T + 0.45, 0.0, 2.2, Z0 + T, -0.4),    # estante del taller
    ])})
    b.mesh('tablones', {'tablones': boxes([
        (3.0, 4.6, 0.08, 0.35, -9.6, -8.4), (3.0, 4.6, 0.35, 0.62, -9.6, -8.4), (3.2, 4.4, 0.62, 0.85, -9.5, -8.5),
        (X0 + T + 0.05, X0 + T + 0.4, 1.0, 1.15, 2.6, 4.7),  # tablas apoyadas en el estante
    ])})
    b.mesh('troncos', {'tronco': boxes([(-4.4, -3.9, 0.08, 0.55, -9.5, -8.6), (-4.4, -3.9, 0.08, 0.55, -8.45, -7.55),
                                        (-4.35, -3.95, 0.55, 1.0, -9.2, -8.2)])})
    b.mesh('banco_trabajo', {'banco': boxes([(3.2, 4.6, 0.08, 0.95, -6.5, -4.5)]),
                             'herramienta': boxes([(3.4, 3.7, 0.95, 1.0, -5.9, -5.6), (4.1, 4.4, 0.95, 1.0, -5.4, -5.2)])})
    b.mesh('cartel_tienda', {'cartel_borde': boxes([(-1.9, 1.9, 3.55, 4.25, Z1 + 0.12, Z1 + 0.2)]),
                             'cartel': boxes([(-1.75, 1.75, 3.65, 4.15, Z1 + 0.2, Z1 + 0.27)])})

    # ---- Colisiones (sólidas e invisibles) ----
    cols = {
        'col_piso': (X0, X1, -0.3, 0.08, Z0, Z1),
        'col_pared_izq': wl[0], 'col_pared_der': wl[1], 'col_pared_fondo': wl[2],
        'col_pared_frente_izq': wl[3], 'col_pared_frente_der': wl[4], 'col_dintel_puerta': wl[5],
        'col_div_izq': wl[6], 'col_div_der': wl[7], 'col_dintel_paso': wl[8],
        'col_mostrador': (X0 + T, 1.5, 0, 1.12, 5.0, 6.0),
        'col_estante_ventas': (X0 + T, X0 + T + 0.45, 0, 2.2, 2.4, 4.9),
        'col_estante_taller': (X0 + T, X0 + T + 0.45, 0, 2.2, Z0 + T, -0.4),
        'col_banco': (3.2, 4.6, 0, 0.95, -6.5, -4.5),
        'col_tablones': (3.0, 4.6, 0, 0.85, -9.6, -8.4),
        'col_troncos': (-4.4, -3.9, 0, 1.0, -9.5, -7.55),
    }
    for name, box in cols.items():
        b.mesh(name, {'col': boxes([box])})

    # ---- Empties ----
    b.empty('pos_mostrador', (-1.0, 0.08, 4.4), 0)
    b.empty('pos_cliente', (-1.0, 0.08, 6.7), 180)
    for i in range(5):
        b.empty(f'cola_{i + 1}', (-1.0, 0.08, 6.7 + (i + 1) * 1.0), 180)
    b.empty('pos_taller', (2.5, 0.08, -5.5), 90)
    b.empty('banco_obra', (3.9, 0.98, -5.5))
    b.empty('pos_entrada', (0.0, 0.08, 9.0), 0)
    b.empty('pos_afuera', (0.0, 0.0, 12.0), 0)
    n = 0
    for r in range(SLOT_ROWS):
        for c in range(SLOT_COLS):
            n += 1
            b.empty(f'slot_{n:02d}', (SLOT_X0 + c * SLOT_STEP, 0.095, SLOT_Z0 - r * SLOT_STEP), extras={'slot': n})
    return b


def build_suelo():
    """assets/models/objects/suelo_plaza.glb: el suelo sólido (invisible) de la plaza, con la cara de arriba en y = 0.
    Sin esto el mapa no tiene suelo con colisión: el personaje no sube/baja y al entrar a la tienda (que sí lo tiene)
    caería al salir. Se coloca en data/scenes/coronda_plaza.json > objects."""
    b = Builder()
    b.mesh('col_suelo', {'col': boxes([(-60, 60, -1.0, 0.0, -60, 60)])})
    return b


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for nombre, modelo in (('tienda', build()), ('suelo_plaza', build_suelo())):
        out = os.path.join(root, 'assets', 'models', 'objects', f'{nombre}.glb')
        print(f'OK: {out} ({modelo.write(out)} bytes)')
