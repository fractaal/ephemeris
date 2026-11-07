# blender -b -P exr2npy.py -- in.exr out.npy : an EXR's linear RGB as a float32 array (rows top first)
import bpy, sys, numpy as np
a = sys.argv[sys.argv.index('--') + 1:]
im = bpy.data.images.load(a[0]); w, h = im.size
px = np.empty(w * h * 4, np.float32); im.pixels.foreach_get(px)
np.save(a[1], px.reshape(h, w, 4)[::-1, :, :3])
print('size', w, h)
