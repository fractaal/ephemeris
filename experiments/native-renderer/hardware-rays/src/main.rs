//! hardware-rays --data <dir: dump.mjs's> --gpu <name>: the same rays through the renderer's own WGSL walk and through the GPU's ray tracing hardware.
use std::time::Instant;
use wgpu::util::DeviceExt;
use serde_json::Value;

fn arg(name: &str, or: &str) -> String { let a: Vec<String> = std::env::args().collect(); a.iter().position(|x| x == name).map(|i| a[i + 1].clone()).unwrap_or_else(|| or.to_string()) }
fn median(v: &mut Vec<f64>) -> f64 { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] }
fn floats(b: &[u8]) -> &[f32] { unsafe { std::slice::from_raw_parts(b.as_ptr() as *const f32, b.len() / 4) } }

fn e<'a>(b: u32, r: &'a wgpu::Buffer) -> wgpu::BindGroupEntry<'a> { wgpu::BindGroupEntry { binding: b, resource: r.as_entire_binding() } }

fn main() {
    let data = arg("--data", "out"); let want = arg("--gpu", "RTX");
    let read = |n: &str| std::fs::read(format!("{data}/{n}")).unwrap_or_else(|e| panic!("{n}: {e}"));
    let scene: Value = serde_json::from_slice(&read("scene.json")).unwrap();
    let (geo, scn, inst, cam, world, sp) = (read("geo.bin"), read("scn.bin"), read("inst.bin"), read("cam.bin"), read("world.bin"), read("sp.bin"));
    // (--lights n: only the first n of the frame's lights, to tell what they cost)
    let mut world = world;
    let lights: f32 = arg("--lights", "-1").parse().unwrap();
    if lights >= 0.0 { world[28..32].copy_from_slice(&lights.to_le_bytes()); }
    let drawn = (scene["drawn"][0].as_u64().unwrap() as u32, scene["drawn"][1].as_u64().unwrap() as u32);
    let n_rays = (drawn.0 * drawn.1) as u64;

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::VULKAN, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN)).into_iter().find(|a| a.get_info().name.to_lowercase().contains(&want.to_lowercase())).expect("adapter");
    println!("GPU: {}; ray query available: {}", adapter.get_info().name, adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY));
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY, required_limits: adapter.limits(), experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() }, ..Default::default()
    })).expect("device");
    device.on_uncaptured_error(std::sync::Arc::new(|e: wgpu::Error| { println!("GPU ERROR: {e}"); std::process::exit(2); }));
    let wait = || { device.poll(wgpu::PollType::wait_indefinitely()).unwrap(); };

    use wgpu::BufferUsages as B;
    let init = |label: &str, b: &[u8], usage| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: b, usage });
    let (b_cam, b_world) = (init("cam", &cam, B::UNIFORM), init("world", &world, B::UNIFORM));
    let (b_scn, b_inst, b_geo, b_sp) = (init("scn", &scn, B::STORAGE), init("inst", &inst, B::STORAGE), init("geo", &geo, B::STORAGE), init("sp", &sp, B::STORAGE));
    let rays = |l: &str| device.create_buffer(&wgpu::BufferDescriptor { label: Some(l), size: n_rays * 32, usage: B::STORAGE, mapped_at_creation: false });
    let (r_p, r_g, r_s) = (rays("primary"), rays("gi"), rays("shadow"));
    let hits = |l: &str| device.create_buffer(&wgpu::BufferDescriptor { label: Some(l), size: n_rays * 16, usage: B::STORAGE | B::COPY_SRC, mapped_at_creation: false });
    let (h_sw, h_hw) = (hits("hits sw"), hits("hits hw"));

    // the renderer's WGSL, as its shaders start, then the benchmark's
    let prelude = String::from_utf8(read("prelude.wgsl")).unwrap();
    let src = prelude.clone() + include_str!("bench.wgsl");
    let t0 = Instant::now();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("renderer"), source: wgpu::ShaderSource::Wgsl(src.into()) });
    println!("renderer's WGSL through wgpu's compiler (naga): {:.0} ms", t0.elapsed().as_secs_f64() * 1e3);
    let pipe = |m: &wgpu::ShaderModule, e: &str| { let t0 = Instant::now(); let p = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some(e), layout: None, module: m, entry_point: Some(e), compilation_options: Default::default(), cache: None }); println!("  pipeline {e}: {:.0} ms", t0.elapsed().as_secs_f64() * 1e3); p };
    let (p_gen, p_sc, p_sa) = (pipe(&module, "gen"), pipe(&module, "swClosest"), pipe(&module, "swAny"));
    let g0 = |p: &wgpu::ComputePipeline| device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &p.get_bind_group_layout(0), entries: &[e(0, &b_cam), e(1, &b_world)] });
    // (group 0 and 1 as each entry point reads them: what it does not reach is not in its layout)
    let run = |p: &wgpu::ComputePipeline, bgs: &[&wgpu::BindGroup], x: u32, y: u32| -> f64 {
        let mut enc = device.create_command_encoder(&Default::default());
        { let mut c = enc.begin_compute_pass(&Default::default()); c.set_pipeline(p); for (i, g) in bgs.iter().enumerate() { c.set_bind_group(i as u32, *g, &[]); } c.dispatch_workgroups(x, y, 1); }
        let t0 = Instant::now(); queue.submit([enc.finish()]); wait(); t0.elapsed().as_secs_f64() * 1e3
    };
    let reads = |bgl: &wgpu::BindGroupLayout, list: &[(u32, &wgpu::Buffer)]| device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: bgl, entries: &list.iter().map(|(b, r)| e(*b, r)).collect::<Vec<_>>() });

    // the rays
    let gen_g0 = g0(&p_gen);
    let gen_g1 = reads(&p_gen.get_bind_group_layout(1), &[(0, &b_scn), (1, &b_inst), (2, &b_geo)]);
    let gen_g2 = reads(&p_gen.get_bind_group_layout(2), &[(0, &r_p), (1, &r_g), (2, &r_s)]);
    let ms = run(&p_gen, &[&gen_g0, &gen_g1, &gen_g2], drawn.0.div_ceil(8), drawn.1.div_ceil(8));
    println!("rays made: {} a kind ({:.0} ms)", n_rays, ms);

    // the hardware's structures: a BLAS for each model, a TLAS over every copy
    let models = scene["models"].as_array().unwrap();
    let (mut pos, mut idx): (Vec<f32>, Vec<u32>) = (vec![], vec![]);
    let mut at = std::collections::HashMap::new();
    let mut sizes = vec![];
    for m in models {
        let (v, i, c, n) = (m["vertex"].as_u64().unwrap() as usize, m["index"].as_u64().unwrap() as usize, m["count"].as_u64().unwrap() as usize, m["vertices"].as_u64().unwrap() as usize);
        let (fv, fi) = ((pos.len() / 3) as u32, idx.len() as u32);
        let vf = floats(&geo[v..v + n * 32]);
        for k in 0..n { pos.extend_from_slice(&vf[k * 8..k * 8 + 3]); }
        idx.extend_from_slice(unsafe { std::slice::from_raw_parts(geo[i..i + c * 4].as_ptr() as *const u32, c) });
        at.insert(v as u64, sizes.len());
        sizes.push((fv, fi, wgpu::BlasTriangleGeometrySizeDescriptor { vertex_format: wgpu::VertexFormat::Float32x3, vertex_count: n as u32, index_format: Some(wgpu::IndexFormat::Uint32), index_count: Some(c as u32), flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE }));
    }
    let asb = |b: &[u8]| init("input", b, B::BLAS_INPUT);
    let vb = asb(unsafe { std::slice::from_raw_parts(pos.as_ptr() as *const u8, pos.len() * 4) });
    let ib = asb(unsafe { std::slice::from_raw_parts(idx.as_ptr() as *const u8, idx.len() * 4) });
    let blases: Vec<wgpu::Blas> = sizes.iter().map(|(_, _, s)| device.create_blas(&wgpu::CreateBlasDescriptor { label: None, flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE, update_mode: wgpu::AccelerationStructureUpdateMode::Build }, wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors: vec![s.clone()] })).collect();
    let meshes = scene["meshes"].as_array().unwrap();
    let per = scene["instanceFloats"].as_f64().unwrap() as usize;
    // (each copy's entry in the scene's items, which a hit names: as the renderer's hierarchy ordered them)
    let (t_items, t_mats) = (scene["tables"]["items"].as_u64().unwrap() as usize, scene["tables"]["materials"].as_u64().unwrap() as usize);
    let sf = floats(&scn);
    let mut item_of = std::collections::HashMap::new();
    for it in 0..t_mats - t_items { let c = sf[(t_items + it) * 4] as i32; if c >= 0 { item_of.insert(c as usize, it as u32); } }
    let copies: usize = meshes.iter().map(|m| m["copies"].as_u64().unwrap() as usize).sum();
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor { label: None, max_instances: copies as u32, flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE, update_mode: wgpu::AccelerationStructureUpdateMode::Build });
    let fl = floats(&inst);
    let fill = |tlas: &mut wgpu::Tlas| {
        let mut s = 0usize;
        for m in meshes { let b = &blases[at[&m["model"].as_u64().unwrap()]]; let first = m["first"].as_u64().unwrap() as usize; let mask = if m["glass"].as_bool().unwrap_or(false) { 2u8 } else { 1u8 };
            for k in 0..m["copies"].as_u64().unwrap() as usize {
                let o = (first + k) * per;
                // (the copy's model columns, translation in each's w: as rows)
                let t = [fl[o], fl[o + 4], fl[o + 8], fl[o + 3], fl[o + 1], fl[o + 5], fl[o + 9], fl[o + 7], fl[o + 2], fl[o + 6], fl[o + 10], fl[o + 11]];
                tlas[s] = Some(wgpu::TlasInstance::new(b, t, *item_of.get(&(first + k)).unwrap_or(&0), mask)); s += 1;
            } }
    };
    fill(&mut tlas);
    let entries: Vec<wgpu::BlasTriangleGeometry> = sizes.iter().map(|(fv, fi, s)| wgpu::BlasTriangleGeometry { size: s, vertex_buffer: &vb, first_vertex: *fv, vertex_stride: 12, index_buffer: Some(&ib), first_index: Some(*fi), transform_buffer: None, transform_buffer_offset: None }).collect();
    let mut enc = device.create_command_encoder(&Default::default());
    let list: Vec<wgpu::BlasBuildEntry> = blases.iter().zip(entries).map(|(b, g)| wgpu::BlasBuildEntry { blas: b, geometry: wgpu::BlasGeometries::TriangleGeometries(vec![g]) }).collect();
    enc.build_acceleration_structures(list.iter(), [&tlas]);
    let t0 = Instant::now(); queue.submit([enc.finish()]); wait();
    println!("hardware structures: {} models ({} triangles), {} copies: built in {:.1} ms", models.len(), idx.len() / 3, copies, t0.elapsed().as_secs_f64() * 1e3);
    let mut v = vec![];
    for _ in 0..7 { let t0 = Instant::now(); fill(&mut tlas); let mut enc = device.create_command_encoder(&Default::default()); enc.build_acceleration_structures([], [&tlas]); queue.submit([enc.finish()]); wait(); v.push(t0.elapsed().as_secs_f64() * 1e3); }
    println!("  TLAS again, as when copies move: {:.1} ms", median(&mut v));

    let hw = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("hw"), source: wgpu::ShaderSource::Wgsl(include_str!("hw.wgsl").into()) });
    let (p_hc, p_ha) = (pipe(&hw, "hwClosest"), pipe(&hw, "hwAny"));

    // each kind of ray through each
    let read_hits = |b: &wgpu::Buffer| -> Vec<[f32; 4]> {
        let s = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: b.size(), usage: B::COPY_DST | B::MAP_READ, mapped_at_creation: false });
        let mut enc = device.create_command_encoder(&Default::default()); enc.copy_buffer_to_buffer(b, 0, &s, 0, b.size()); queue.submit([enc.finish()]);
        s.slice(..).map_async(wgpu::MapMode::Read, |_| {}); wait();
        let m = s.slice(..).get_mapped_range().unwrap();
        unsafe { std::slice::from_raw_parts(m.as_ptr() as *const [f32; 4], n_rays as usize) }.to_vec()
    };
    let wg = (n_rays as u32).div_ceil(64);
    let (mut total_sw, mut total_hw) = (0.0, 0.0);
    let mut depth: Option<(Vec<[f32; 4]>, Vec<[f32; 4]>)> = None;
    for (name, r, any) in [("camera", &r_p, false), ("GI bounce", &r_g, false), ("sun shadow", &r_s, true)] {
        let p = if any { &p_sa } else { &p_sc };
        let g0s = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &p.get_bind_group_layout(0), entries: &[e(1, &b_world)] });
        let g1s = reads(&p.get_bind_group_layout(1), &[(0, &b_scn), (1, &b_inst), (2, &b_geo)]);
        let g2s = reads(&p.get_bind_group_layout(2), &[(3, r), (4, &h_sw)]);
        let ph = if any { &p_ha } else { &p_hc };
        let gh = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &ph.get_bind_group_layout(0), entries: &[wgpu::BindGroupEntry { binding: 0, resource: tlas.as_binding() }, e(1, r), e(2, &h_hw)] });
        let mut a: Vec<f64> = (0..5).map(|_| run(p, &[&g0s, &g1s, &g2s], wg, 1)).collect();
        let mut b: Vec<f64> = (0..9).map(|_| run(ph, &[&gh], wg, 1)).collect();
        let (ma, mb) = (median(&mut a), median(&mut b));
        let (sa, sb) = (read_hits(&h_sw), read_hits(&h_hw));
        let (mut sent, mut hit_both, mut miss_both, mut close, mut differ) = (0u64, 0u64, 0u64, 0u64, 0u64);
        for (x, y) in sa.iter().zip(sb.iter()) {
            if x[0] == -2.0 { continue; }
            sent += 1;
            match (x[0] >= 0.0, y[0] >= 0.0) { (true, true) => { hit_both += 1; if any || (x[0] - y[0]).abs() <= (0.01 * x[0]).max(0.5) { close += 1; } } (false, false) => miss_both += 1, _ => differ += 1 }
        }
        let agree = (close + miss_both) as f64 / sent.max(1) as f64 * 100.0;
        println!("{name:11}: {sent} rays | our WGSL {ma:8.1} ms ({:6.1} M/s) | hardware {mb:7.1} ms ({:7.1} M/s) | {:5.1}x | same answer {agree:.3}% (hit either way but not the other {differ}, both hit but further apart {})", sent as f64 / ma / 1e3, sent as f64 / mb / 1e3, ma / mb, hit_both - close);
        total_sw += ma; total_hw += mb;
        if name == "camera" { depth = Some((sa, sb)); }
    }
    println!("all three: our WGSL {total_sw:.1} ms, hardware {total_hw:.1} ms: {:.1}x", total_sw / total_hw);

    // the real thing: the renderer's GI ray with what it meets shaded, by its own walk and by the hardware (only traceScene and rayBlocked told apart)
    let swap = prelude.replace("fn traceScene(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> RayHit {", r#"fn traceScene(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> RayHit {
  var q: ray_query; rayQueryInitialize(&q, bxAcc, RayDesc(0u, 0xFFu, tmin, tmax, P, D)); rayQueryProceed(&q);
  let r = rayQueryGetCommittedIntersection(&q);
  if (r.kind == 0u) { return RayHit(tmax, -1, -1, vec2f(0.0)); }
  return RayHit(r.t, i32(r.instance_custom_data), i32(r.primitive_index), r.barycentrics);
}
fn traceSceneSoft(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> RayHit {"#).replace("fn rayBlocked(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> i32 {", r#"fn rayBlocked(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> i32 {
  var q: ray_query; rayQueryInitialize(&q, bxAcc, RayDesc(4u, 0x01u, tmin, tmax, P, D)); rayQueryProceed(&q);
  if (rayQueryGetCommittedIntersection(&q).kind != 0u) { return RAY_STOPPED; }
  var g: ray_query; rayQueryInitialize(&g, bxAcc, RayDesc(4u, 0x02u, tmin, tmax, P, D)); rayQueryProceed(&g);
  if (rayQueryGetCommittedIntersection(&g).kind != 0u) { return RAY_TINTED; }
  return RAY_CLEAR;
}
fn rayBlockedSoft(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> i32 {"#);
    assert!(swap.contains("traceSceneSoft") && swap.contains("rayBlockedSoft"), "the walkers were not found");
    let hw_src = format!("enable wgpu_ray_query;\n@group(3) @binding(0) var bxAcc: acceleration_structure;\n{swap}{}", include_str!("bench.wgsl"));
    let t0 = Instant::now();
    let hw_real = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("real hw"), source: wgpu::ShaderSource::Wgsl(hw_src.into()) });
    println!("real shader, hardware version, through naga: {:.0} ms", t0.elapsed().as_secs_f64() * 1e3);
    let (p_rs, p_rh) = (pipe(&module, "realGi"), pipe(&hw_real, "realGi"));
    // (no film's pictures here: a white one for each, where a surface asks for one)
    let white = device.create_texture_with_data(&queue, &wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] }, wgpu::util::TextureDataOrder::LayerMajor, &[255, 255, 255, 255]);
    let wv = white.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    let smp = device.create_sampler(&Default::default());
    let scene_group = |p: &wgpu::ComputePipeline| { let mut en = vec![e(0, &b_scn), e(1, &b_inst), e(2, &b_geo), e(3, &b_sp)]; for b in 4..10 { en.push(wgpu::BindGroupEntry { binding: b, resource: wgpu::BindingResource::TextureView(&wv) }); } en.push(wgpu::BindGroupEntry { binding: 10, resource: wgpu::BindingResource::Sampler(&smp) }); device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &p.get_bind_group_layout(1), entries: &en }) };
    let (g0a, g1a, g2a) = (g0(&p_rs), scene_group(&p_rs), reads(&p_rs.get_bind_group_layout(2), &[(3, &r_g), (4, &h_sw)]));
    let (g0b, g1b, g2b) = (g0(&p_rh), scene_group(&p_rh), reads(&p_rh.get_bind_group_layout(2), &[(3, &r_g), (4, &h_hw)]));
    let g3b = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &p_rh.get_bind_group_layout(3), entries: &[wgpu::BindGroupEntry { binding: 0, resource: tlas.as_binding() }] });
    let mut a: Vec<f64> = (0..5).map(|_| run(&p_rs, &[&g0a, &g1a, &g2a], wg, 1)).collect();
    let mut b: Vec<f64> = (0..9).map(|_| run(&p_rh, &[&g0b, &g1b, &g2b, &g3b], wg, 1)).collect();
    let (ma, mb) = (median(&mut a), median(&mut b));
    let (sa, sb) = (read_hits(&h_sw), read_hits(&h_hw));
    let (mut n, mut sum_a, mut sum_b, mut near, mut diff) = (0u64, 0f64, 0f64, 0u64, 0f64);
    for (x, y) in sa.iter().zip(sb.iter()) { if x[0] == -2.0 { continue; } n += 1; let (la, lb) = ((x[0] + x[1] + x[2]) as f64, (y[0] + y[1] + y[2]) as f64); sum_a += la; sum_b += lb; diff += (la - lb).abs(); if (la - lb).abs() <= (0.02 * la.abs()).max(0.003) { near += 1; } }
    println!("REAL GI rays, shaded: {n} rays | our WGSL {ma:.1} ms | hardware {mb:.1} ms | {:.1}x | light mean {:.4} vs {:.4}, rays within 2%: {:.2}%, mean difference {:.4}", ma / mb, sum_a / n as f64, sum_b / n as f64, near as f64 / n as f64 * 100.0, diff / n as f64);

    // a picture of what each saw from the camera, to look at
    if let Some((a, b)) = depth {
        let mut px = Vec::with_capacity((drawn.0 * drawn.1 * 2 * 3) as usize);
        for y in 0..drawn.1 as usize { for s in [&a, &b] { for x in 0..drawn.0 as usize { let t = s[y * drawn.0 as usize + x][0]; let v = if t < 0.0 { 20u8 } else { (40.0 + 215.0 * (1.0 - (t.log10() - 2.0).clamp(0.0, 2.5) / 2.5)) as u8 }; px.extend_from_slice(&[v, v, v]); } } }
        let f = std::fs::File::create(format!("{data}/both.png")).unwrap();
        let mut enc = png::Encoder::new(std::io::BufWriter::new(f), drawn.0 * 2, drawn.1); enc.set_color(png::ColorType::Rgb); enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&px).unwrap();
    }
}
