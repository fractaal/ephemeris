# Builds an Ephemeris scene dump (dump.mjs) in Blender and renders it with Cycles, unbiased (no denoiser, no clamps,
# no glossy filter), to a linear EXR. Ephemeris's world (x right, y down, z toward the viewer, px) maps to Blender's as
# (x, -z, -y), 1 px = 1 unit; that mapping turns handedness, so each triangle's winding is reversed to keep its face
# outward.
#   blender -b -P build.py -- scene.json out.exr [width height samples bounces [one|gi<n> [passes]]]
#     one: only what Ephemeris's GI computes (one diffuse bounce, one glossy); gi<n>: with n diffuse bounces (GI's
#     bounces: n); passes: Cycles' light passes too
#   blender -b -P build.py -- --calibrate out.exr          (a sun of strength 1 on a white plane: 1/π)
#   blender -b -P build.py -- --calibrate-point out.exr    (1000 W, 100 above a white plane: POINT_W × 0.1)
import bpy, bmesh, json, math, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
B = lambda v: Vector((v[0], -v[2], -v[1]))
POINT_W = 0.02449   # (what a white matte surface shows head-on from a Cycles point light of 1 W, 1 away: --calibrate-point)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    device = 'CPU'
    # (the fastest GPU there is: an NVIDIA card's OptiX, then CUDA, then an AMD one's HIP)
    for kind in ('OPTIX', 'CUDA', 'HIP'):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == kind]
            if gpus:
                for d in prefs.devices: d.use = d.type == kind
                device = 'GPU'
                print('cycles device', kind, [d.name for d in gpus])
                break
        except Exception as e:
            print('no', kind, e)
    sc.cycles.device = device
    c = sc.cycles
    c.use_denoising = False
    c.sample_clamp_direct = 0
    c.sample_clamp_indirect = 0
    c.blur_glossy = 0
    c.caustics_reflective = True
    c.caustics_refractive = True
    c.use_adaptive_sampling = False
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0
    sc.view_settings.gamma = 1
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    sc.render.film_transparent = False
    sc.render.filter_size = 1.0
    return sc


def world(env):
    w = bpy.data.worlds.new('env'); bpy.context.scene.world = w
    w.use_nodes = True
    N, L = w.node_tree.nodes, w.node_tree.links
    N.clear()
    out = N.new('ShaderNodeOutputWorld'); bg = N.new('ShaderNodeBackground'); L.new(bg.outputs[0], out.inputs[0])
    bg.inputs['Strength'].default_value = env['intensity']
    tc = N.new('ShaderNodeTexCoord'); sep = N.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Generated'], sep.inputs[0])
    ab = N.new('ShaderNodeMath'); ab.operation = 'ABSOLUTE'; L.new(sep.outputs['Z'], ab.inputs[0])
    pw = N.new('ShaderNodeMath'); pw.operation = 'POWER'; L.new(ab.outputs[0], pw.inputs[0]); pw.inputs[1].default_value = 0.6
    cl = N.new('ShaderNodeMath'); cl.operation = 'MINIMUM'; L.new(pw.outputs[0], cl.inputs[0]); cl.inputs[1].default_value = 1.0
    def mix(a, b):
        m = N.new('ShaderNodeMix'); m.data_type = 'RGBA'; L.new(cl.outputs[0], m.inputs['Factor'])
        m.inputs['A'].default_value = (*a, 1); m.inputs['B'].default_value = (*b, 1); return m
    up, down = mix(env['horizon'], env['zenith']), mix(env['horizon'], env['nadir'])
    gt = N.new('ShaderNodeMath'); gt.operation = 'GREATER_THAN'; L.new(sep.outputs['Z'], gt.inputs[0]); gt.inputs[1].default_value = 0.0
    sel = N.new('ShaderNodeMix'); sel.data_type = 'RGBA'; L.new(gt.outputs[0], sel.inputs['Factor'])
    L.new(down.outputs['Result'], sel.inputs['A']); L.new(up.outputs['Result'], sel.inputs['B'])
    L.new(sel.outputs['Result'], bg.inputs['Color'])


def material(m, label):
    mat = bpy.data.materials.new(label); mat.use_nodes = True
    N, L = mat.node_tree.nodes, mat.node_tree.links
    p = N['Principled BSDF']
    rgb = lambda c: (*c, 1)
    attr = N.new('ShaderNodeAttribute'); attr.attribute_name = 'tint'
    mul = N.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1
    mul.inputs['A'].default_value = rgb(m['baseColor']); L.new(attr.outputs['Color'], mul.inputs['B']); L.new(mul.outputs['Result'], p.inputs['Base Color'])
    set_ = lambda k, v: p.inputs[k].__setattr__('default_value', v)
    set_('Metallic', m['metallic']); set_('Roughness', m['roughness']); set_('IOR', m['ior'])
    set_('Specular IOR Level', m['specularIorLevel']); set_('Specular Tint', rgb(m['specularTint']))
    set_('Transmission Weight', m['transmissionWeight'])
    set_('Coat Weight', m['coatWeight']); set_('Coat Roughness', m['coatRoughness']); set_('Coat IOR', m['coatIor']); set_('Coat Tint', rgb(m['coatTint']))
    set_('Sheen Weight', m['sheenWeight']); set_('Sheen Roughness', m['sheenRoughness']); set_('Sheen Tint', rgb(m['sheenTint']))
    set_('Emission Color', rgb(m['emission'])); set_('Emission Strength', 1.0 if max(m['emission']) > 0 else 0.0)
    return mat


def mesh(d):
    me = bpy.data.meshes.new(d['label'])
    pos = d['pos']; V = len(pos) // 3
    verts = [tuple(B(pos[i * 3:i * 3 + 3])) for i in range(V)]
    idx = d['idx']
    faces = [(idx[i], idx[i + 2], idx[i + 1]) for i in range(0, len(idx), 3)]
    me.from_pydata(verts, [], faces)
    me.update()
    nrm = d['nrm']
    me.normals_split_custom_set_from_vertices([tuple(B(nrm[i * 3:i * 3 + 3])) for i in range(V)])
    # per copy tint, on every vertex of the copy
    per = d['verts']; tint = d['tint']
    ca = me.color_attributes.new('tint', 'FLOAT_COLOR', 'POINT')
    for v in range(V):
        k = v // per; ca.data[v].color = (tint[k * 3], tint[k * 3 + 1], tint[k * 3 + 2], 1)
    ob = bpy.data.objects.new(d['label'], me); bpy.context.scene.collection.objects.link(ob)
    me.materials.append(material(d['material'], d['label']))
    for poly in me.polygons: poly.use_smooth = True
    return ob


def camera(c, W, H):
    cam = bpy.data.cameras.new('cam'); ob = bpy.data.objects.new('cam', cam); bpy.context.scene.collection.objects.link(ob)
    bpy.context.scene.camera = ob
    eye, tgt = B((c['x'], c['y'], c['z'])), B((c['tx'], c['ty'], c['tz']))
    ob.location = eye
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = (tgt - eye).to_track_quat('-Z', 'Y')
    cam.sensor_fit = 'HORIZONTAL'; cam.sensor_width = 36
    cam.lens = c['focal'] * c.get('zoom', 1) * 36 / 1920
    cam.clip_start = 1; cam.clip_end = 200000
    sc = bpy.context.scene; sc.render.resolution_x = W; sc.render.resolution_y = H; sc.render.resolution_percentage = 100


def sun(L, units=math.pi):
    # (Ephemeris's light colour × intensity is irradiance / π: a white matte surface lit head-on by intensity 1 shows 1
    # (shaders.js highlight()); Blender's sun strength is irradiance (it shows 1/π): units π)
    s = bpy.data.lights.new('sun', 'SUN'); s.energy = L['intensity'] * units; s.color = L['color']
    s.angle = math.radians(L.get('angle') or 1.0)
    ob = bpy.data.objects.new('sun', s); bpy.context.scene.collection.objects.link(ob)
    ob.rotation_mode = 'QUATERNION'; ob.rotation_quaternion = B(L['dir']).to_track_quat('-Z', 'Y')


def point(L):
    # (Ephemeris's point light shows colour × intensity × 10⁶ / d² on a white matte surface head-on, its reach's fade aside
    # (shaders.js lightHere); a Cycles point light of P watts shows P × POINT_W / d² there: --calibrate-point)
    s = bpy.data.lights.new('point', 'POINT'); s.energy = L['intensity'] * 1e6 / POINT_W; s.color = L['color']
    s.shadow_soft_size = L.get('radius') or 20
    ob = bpy.data.objects.new('point', s); bpy.context.scene.collection.objects.link(ob); ob.location = B(L['at'])


if argv[0] in ('--calibrate', '--calibrate-point'):
    # a white matte plane facing up, a sun of strength 1 straight down, a black world: Ephemeris shows 1/π there
    sc = reset(); out = argv[1]
    w = bpy.data.worlds.new('black'); sc.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs['Color'].default_value = (0, 0, 0, 1)
    bpy.ops.mesh.primitive_plane_add(size=1000)
    m = material({'baseColor': [1, 1, 1], 'metallic': 0, 'roughness': 1, 'ior': 1.5, 'specularIorLevel': 0, 'specularTint': [1, 1, 1], 'transmissionWeight': 0, 'coatWeight': 0,
                  'coatRoughness': 0, 'coatIor': 1.5, 'coatTint': [1, 1, 1], 'sheenWeight': 0, 'sheenRoughness': 0.5, 'sheenTint': [1, 1, 1], 'emission': [0, 0, 0]}, 'white')
    me = bpy.context.object.data; ca = me.color_attributes.new('tint', 'FLOAT_COLOR', 'POINT')
    for d in ca.data: d.color = (1, 1, 1, 1)
    me.materials.append(m)
    if argv[0] == '--calibrate': sun({'intensity': 1.0, 'color': (1, 1, 1), 'angle': 0.5, 'dir': [0, 1, 0]}, units=1.0)
    else: point({'intensity': 1000 / 1e6 * POINT_W, 'color': (1, 1, 1), 'radius': 0.01, 'at': [0, -100, 0]})
    camera({'x': 0, 'y': -300, 'z': 0.001, 'tx': 0, 'ty': 0, 'tz': 0, 'focal': 1000}, 64, 64)
    sc.cycles.samples = 64; sc.cycles.max_bounces = 0
    sc.render.filepath = out; bpy.ops.render.render(write_still=True)
else:
    src, out = argv[0], argv[1]
    W, H, spp, bounces = (int(argv[2]), int(argv[3]), int(argv[4]), int(argv[5])) if len(argv) > 5 else (960, 540, 512, 12)
    # (one: what Ephemeris's GI computes: one diffuse bounce and one glossy, glass passed through; gi<n>: the same with
    # n diffuse bounces, as GI's bounces: n computes it)
    mode = argv[6] if len(argv) > 6 else ''
    one = mode == 'one' or mode.startswith('gi')
    diffuse = int(mode[2:]) if mode.startswith('gi') else 1
    d = json.load(open(src))
    sc = reset()
    world(d['environment'])
    for m in d['meshes']:
        mesh(m)
        # (what lies within a light's radius is its bulb, and does not shadow it: shadowRay, trace.js)
        v = m['pos']
        if any(L['kind'] == 'point' and all(math.dist(v[i:i + 3], L['at']) <= (L.get('radius') or 20) for i in range(0, len(v), 3)) for L in d['lights']):
            bpy.context.scene.collection.objects[m['label']].visible_shadow = False
    for L in d['lights']:
        if L['kind'] == 'sun': sun(L)
        elif L['kind'] == 'point': point(L)
        else: print('skipped light', L['kind'])
    camera(d['camera'], W, H)
    c = sc.cycles; c.samples = spp; c.max_bounces = bounces; c.diffuse_bounces = bounces; c.glossy_bounces = bounces
    c.transmission_bounces = max(bounces, 8); c.transparent_max_bounces = 8
    if one: c.max_bounces = 10 + diffuse; c.diffuse_bounces = diffuse; c.glossy_bounces = 1; c.transmission_bounces = 8
    sc.render.filepath = out
    if len(argv) > 7 and argv[7] == 'passes':
        # the light by kind (Cycles' passes), each its own EXR beside out (out-diffdir.exr, …). NB Cycles counts the
        # environment's light reaching a surface as direct, where Ephemeris's GI has it among its own
        vl = sc.view_layers[0]
        for k in ('diffuse_direct', 'diffuse_indirect', 'diffuse_color', 'glossy_direct', 'glossy_indirect', 'glossy_color'):
            setattr(vl, 'use_pass_' + k, True)
        tree = bpy.data.node_groups.new('passes', 'CompositorNodeTree'); sc.compositing_node_group = tree
        rl, fo = tree.nodes.new('CompositorNodeRLayers'), tree.nodes.new('CompositorNodeOutputFile')
        base = out.rsplit('.', 1)[0] + '-'
        fo.directory, fo.file_name = base.rsplit('/', 1)
        fo.format.media_type = 'IMAGE'; fo.format.file_format = 'OPEN_EXR'; fo.format.color_depth = '32'
        fo.file_output_items.clear()
        for k, n in {'Diffuse Direct': 'diffdir', 'Diffuse Indirect': 'diffind', 'Diffuse Color': 'diffcol',
                     'Glossy Direct': 'glossdir', 'Glossy Indirect': 'glossind', 'Glossy Color': 'glosscol'}.items():
            fo.file_output_items.new('RGBA', n); tree.links.new(rl.outputs[k], fo.inputs[n])
    bpy.ops.render.render(write_still=True)
print('done', out)
