//! Step 1 of the native renderer's evaluation: a page's pixels as GPU memory in a renderer of our own.
//! dom-textures --gpu <name> --seeks <n> --out <dir>; the electron host's flags and display come from the environment.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use serde_json::{json, Value};

fn arg(name: &str, or: &str) -> String {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).map(|i| a[i + 1].clone()).unwrap_or_else(|| or.to_string())
}

/// A file descriptor of another process, as ours: the page's host is our child, so we may take it.
fn take_fd(pid: i32, fd: i32) -> Result<OwnedFd, String> {
    unsafe {
        let pidfd = libc::syscall(libc::SYS_pidfd_open, pid, 0) as i32;
        if pidfd < 0 { return Err(format!("pidfd_open: {}", std::io::Error::last_os_error())); }
        let got = libc::syscall(libc::SYS_pidfd_getfd, pidfd, fd, 0) as i32;
        let err = std::io::Error::last_os_error();
        libc::close(pidfd);
        if got < 0 { return Err(format!("pidfd_getfd: {err}")); }
        Ok(OwnedFd::from_raw_fd(got as RawFd))
    }
}
fn inode(fd: &OwnedFd) -> u64 {
    use std::os::fd::AsRawFd;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    unsafe { libc::fstat(fd.as_raw_fd(), &mut st) };
    st.st_ino
}

/// The same buffer through a CPU mapping, without Vulkan: what is really in it.
fn cpu_view(fd: &OwnedFd, stride: usize, w: u32, h: u32, ino: u64, frame: i64) {
    use std::os::fd::AsRawFd;
    let len = stride * h as usize;
    unsafe {
        let m = libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ, libc::MAP_SHARED, fd.as_raw_fd(), 0);
        if m == libc::MAP_FAILED { println!("  cpu view ino {ino}: mmap failed: {}", std::io::Error::last_os_error()); return; }
        let b = std::slice::from_raw_parts(m as *const u8, len);
        let mut nonzero = 0usize; let mut k = 0; while k < len { if b[k] != 0 { nonzero += 1; } k += 997; }
        let tag = (0..24).fold(0u32, |n, i| if b[(4 * stride) + ((i * 8 + 4) * 4) as usize + 1] > 128 { n | (1 << i) } else { n });
        println!("  cpu view ino {ino} frame {frame}: nonzero samples {nonzero} of {}, tag {tag}, first bytes {:?}", len / 997, &b[(4 * stride)..(4 * stride) + 8]);
        libc::munmap(m, len);
    }
    let _ = w;
}

struct Gpu { device: wgpu::Device, queue: wgpu::Queue, name: String }

fn open_gpu(want: &str) -> Gpu {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::VULKAN, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN));
    for a in &adapters { println!("adapter: {} ({:?})", a.get_info().name, a.get_info().device_type); }
    let adapter = adapters.into_iter().find(|a| a.get_info().name.to_lowercase().contains(&want.to_lowercase())).unwrap_or_else(|| panic!("no adapter named {want}"));
    let name = adapter.get_info().name;
    let has = adapter.features().contains(wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF);
    println!("renderer on: {name}; DMA-BUF import available: {has}");
    assert!(has, "this GPU cannot import DMA-BUFs through wgpu");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_features: wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF, required_limits: adapter.limits(), ..Default::default()
    })).expect("device");
    Gpu { device, queue, name }
}

fn import(g: &Gpu, fd: OwnedFd, w: u32, h: u32, modifier: u64, stride: u64, offset: u64) -> Result<wgpu::Texture, String> {
    let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
    let hal_desc = wgpu::hal::TextureDescriptor {
        label: Some("page"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::wgt::TextureUses::COPY_SRC | wgpu::wgt::TextureUses::RESOURCE, memory_flags: wgpu::hal::MemoryFlags::empty(), view_formats: vec![],
    };
    let tex = unsafe {
        let hal = g.device.as_hal::<wgpu::hal::api::Vulkan>().ok_or("not Vulkan")?;
        hal.texture_from_dmabuf_fd(fd, &hal_desc, modifier, stride, offset).map_err(|e| format!("import: {e:?}"))?
    };
    Ok(unsafe { g.device.create_texture_from_hal::<wgpu::hal::api::Vulkan>(tex, &wgpu::TextureDescriptor {
        label: Some("page"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    }, wgpu::wgt::TextureUses::UNINITIALIZED) })
}

/// The page's textures: each buffer imported the first time it is seen, then read.
struct Pages { imported: HashMap<u64, wgpu::Texture>, import_ms: Vec<f64>, paints_read: u32, size: (u32, u32), last_tex: Option<wgpu::Texture>, pid: i32 }
impl Pages {
    fn take(&mut self, g: &Gpu, p: &Value, send: &mut dyn FnMut(Value)) -> Result<Vec<u8>, String> {
        let (id, fd) = (p["id"].as_i64().unwrap(), p["fd"].as_i64().unwrap() as i32);
        let (pw, ph) = (p["w"].as_u64().unwrap() as u32, p["h"].as_u64().unwrap() as u32);
        let mine = take_fd(self.pid, fd)?;
        let ino = inode(&mine);
        if std::env::var("CPU_VIEW").is_ok() { cpu_view(&mine, p["stride"].as_u64().unwrap() as usize, pw, ph, ino, p["frameCount"].as_i64().unwrap_or(-1)); }
        if !self.imported.contains_key(&ino) {
            let t0 = Instant::now();
            let t = import(g, mine, pw, ph, p["modifier"].as_str().unwrap().parse().unwrap(), p["stride"].as_u64().unwrap(), p["offset"].as_u64().unwrap())?;
            self.import_ms.push(t0.elapsed().as_secs_f64() * 1e3);
            self.imported.insert(ino, t);
        }
        let t = self.imported[&ino].clone();
        let px = read(g, &t);
        if std::env::var("CPU_VIEW").is_ok() { let nz = px.iter().step_by(997).filter(|x| **x != 0).count(); println!("  vulkan read: nonzero samples {nz} of {}, tag {}", px.len() / 997, cells(&px, pw, 0, 0)); }
        self.size = (pw, ph);
        self.last_tex = Some(t);
        self.paints_read += 1;
        send(json!({ "release": id }));
        Ok(px)
    }
}

fn wait(g: &Gpu) { g.device.poll(wgpu::PollType::wait_indefinitely()).unwrap(); }

/// The texture's bytes as the CPU sees them (B, G, R, A), rows packed.
fn read(g: &Gpu, t: &wgpu::Texture) -> Vec<u8> {
    let (w, h) = (t.width(), t.height());
    let row = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let buf = g.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (row * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut e = g.device.create_command_encoder(&Default::default());
    e.copy_texture_to_buffer(t.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None } }, t.size());
    g.queue.submit([e.finish()]);
    buf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    wait(g);
    let m = buf.slice(..).get_mapped_range().unwrap();
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h as usize { out.extend_from_slice(&m[y * row as usize..y * row as usize + (w * 4) as usize]); }
    out
}

/// The moment in the 24 cells of 8 px starting at (x, y).
fn cells(px: &[u8], w: u32, x: u32, y: u32) -> u32 {
    let mut n = 0;
    for i in 0..24u32 {
        let at = (((y + 4) * w + x + i * 8 + 4) * 4) as usize;
        if px[at + 1] > 128 { n |= 1 << i; }
    }
    n
}
fn hash(b: &[u8]) -> u64 { let mut h = 0xcbf29ce484222325u64; for x in b { h ^= *x as u64; h = h.wrapping_mul(0x100000001b3); } h }
fn median(v: &mut Vec<f64>) -> f64 { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); if v.is_empty() { 0.0 } else { v[v.len() / 2] } }

fn main() {
    let want = arg("--gpu", "RTX");
    let seeks: u32 = arg("--seeks", "60").parse().unwrap();
    let out = arg("--out", "out");
    let (w, h): (u32, u32) = (arg("--w", "1920").parse().unwrap(), arg("--h", "1080").parse().unwrap());
    std::fs::create_dir_all(&out).ok();
    let g = open_gpu(&want);

    let host = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("electron");
    let mut cmd = Command::new(std::env::var("ELECTRON").expect("ELECTRON: the path of the binary"));
    cmd.arg(&host).args(std::env::var("HOST_FLAGS").unwrap_or_default().split_whitespace()).env_remove("ELECTRON_RUN_AS_NODE")
        .env("DOM_W", w.to_string()).env("DOM_H", h.to_string()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(std::fs::File::create(format!("{out}/host.log")).map(Stdio::from).unwrap_or(Stdio::null()));
    if let Ok(v) = std::env::var("HOST_VK") { cmd.env("VK_DRIVER_FILES", v); }
    if let Ok(v) = std::env::var("HOST_PRELOAD") { cmd.env("LD_PRELOAD", v); }
    let mut child = cmd.spawn().expect("electron");
    let pid = child.id() as i32;
    let mut to_host = child.stdin.take().unwrap();
    let from_host = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || { for l in BufReader::new(from_host).lines().map_while(Result::ok) { if let Some(j) = l.strip_prefix("@@") { if let Ok(v) = serde_json::from_str(j) { if tx.send(v).is_err() { break; } } } } });
    let mut send = move |v: Value| { writeln!(to_host, "{v}").ok(); to_host.flush().ok(); };

    let mut pages = Pages { imported: HashMap::new(), import_ms: Vec::new(), paints_read: 0, size: (0, 0), last_tex: None, pid };
    let mut last_px: Vec<u8> = vec![];
    let start = Instant::now();

    // up, and the first paints
    let mut ready = None;
    let mut fail: Option<String> = None;
    while start.elapsed() < Duration::from_secs(90) {
        let Ok(m) = rx.recv_timeout(Duration::from_secs(90)) else { break };
        match m["ev"].as_str() {
            Some("ready") => { println!("page: {m}"); ready = Some(m); }
            Some("paint") => { match pages.take(&g, &m, &mut send) { Ok(px) => { last_px = px; } Err(e) => { fail = Some(e); break; } } if ready.is_some() && pages.paints_read >= 2 { break; } }
            Some("cpu") | Some("nohandle") => { fail = Some(format!("the host gave {:?}, not a shared texture", m["ev"])); break; }
            _ => {}
        }
    }
    if let Some(e) = fail { println!("FAILED: {e}"); send(json!({ "quit": true })); child.wait().ok(); std::process::exit(1); }
    println!("first paint read after {:.2} s; texture {}x{}, buffers imported so far {}", start.elapsed().as_secs_f64(), pages.size.0, pages.size.1, pages.imported.len());
    let size = pages.size;

    // frame accuracy: each moment asked for, in an order that jumps about, some twice: which paint shows it, and does any show it wrong?
    let (mut late_paints, mut stale_after_ack, mut torn, mut never) = (0u32, 0u32, 0u32, 0u32);
    let (mut asked_ms, mut acked_ms) = (Vec::new(), Vec::new());
    let mut seen: HashMap<u32, u64> = HashMap::new();
    let (mut repeats, mut repeats_differ) = (0u32, 0u32);
    let mut bad_tags = vec![];
    for k in 0..seeks {
        let n = 1 + (k * 7919) % (seeks / 2 + 1).max(1);   // (jumps about; about half of them come twice)
        let t0 = Instant::now();
        send(json!({ "seek": n }));
        let (mut acked, mut got) = (None::<Instant>, false);
        while t0.elapsed() < Duration::from_secs(4) {
            let Ok(m) = rx.recv_timeout(Duration::from_millis(500)) else { continue };
            match m["ev"].as_str() {
                Some("later") => println!("page, later: {m}"),
                Some("seeked") if m["n"].as_u64() == Some(n as u64) => {
                    acked = Some(Instant::now());
                    if got { break; }
                    // (the page is unchanged where this moment was the last: nothing would paint)
                    send(json!({ "invalidate": true }));
                }
                Some("paint") => {
                    let px = pages.take(&g, &m, &mut send).expect("read");
                    let a = cells(&px, size.0, 0, 0);
                    let b = cells(&px, size.0, size.0 - 24 * 8, size.1 - 8);
                    if a != b { torn += 1; bad_tags.push((n, a, b)); }
                    if a == n && b == n {
                        if !got { asked_ms.push(t0.elapsed().as_secs_f64() * 1e3); if let Some(t) = acked { acked_ms.push(t.elapsed().as_secs_f64() * 1e3); } }
                        got = true;
                        let hv = hash(&px);
                        if let Some(old) = seen.get(&n) { repeats += 1; if *old != hv { repeats_differ += 1; } } else { seen.insert(n, hv); }
                        last_px = px;
                        if acked.is_some() { break; }
                    } else {
                        late_paints += 1;
                        if acked.is_some() { stale_after_ack += 1; }
                    }
                }
                _ => {}
            }
        }
        if !got { never += 1; }
    }
    println!("moments asked {seeks}: never shown {never}; old paints before the right one {late_paints}, of them after the page said done {stale_after_ack}; corners disagreeing {torn} {:?}", &bad_tags[..bad_tags.len().min(4)]);
    println!("right paint after: asking {:.1} ms (median), the page saying done {:.1} ms; moments drawn twice {repeats}, differing bytes {repeats_differ}", median(&mut asked_ms), median(&mut acked_ms));
    println!("buffers: {} imported, median {:.2} ms each (then reused); paints read {}", pages.imported.len(), median(&mut pages.import_ms), pages.paints_read);

    // where does the memory live? a copy of the page's texture into this GPU's own, against its own to its own and an upload from the CPU
    let t = pages.last_tex.clone().unwrap();
    let local = |usage| g.device.create_texture(&wgpu::TextureDescriptor { label: None, size: t.size(), mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8Unorm, usage, view_formats: &[] });
    let a = local(wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC);
    let b = local(wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING);
    let copy = |src: &wgpu::Texture, dst: &wgpu::Texture| { let mut e = g.device.create_command_encoder(&Default::default()); e.copy_texture_to_texture(src.as_image_copy(), dst.as_image_copy(), src.size()); let t0 = Instant::now(); g.queue.submit([e.finish()]); wait(&g); t0.elapsed().as_secs_f64() * 1e3 };
    let time = |f: &dyn Fn() -> f64| { let mut v: Vec<f64> = (0..40).map(|_| f()).collect(); median(&mut v) };
    let empty = time(&|| { let t0 = Instant::now(); g.queue.submit([g.device.create_command_encoder(&Default::default()).finish()]); wait(&g); t0.elapsed().as_secs_f64() * 1e3 });
    let upload = time(&|| { let t0 = Instant::now(); g.queue.write_texture(a.as_image_copy(), &last_px, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * 4), rows_per_image: None }, t.size()); g.queue.submit([]); wait(&g); t0.elapsed().as_secs_f64() * 1e3 });
    let from_page = time(&|| copy(&t, &b));
    let from_own = time(&|| copy(&a, &b));
    println!("{}: {:.1} MB; nothing {empty:.2} ms; page's texture → own {from_page:.2} ms; own → own {from_own:.2} ms; upload from the CPU {upload:.2} ms", g.name, (size.0 * size.1 * 4) as f64 / 1e6);

    // drawn by a shader of ours: the proof it is a texture to the renderer, over a colour of our own
    let shader = g.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(r#"
@group(0) @binding(0) var page: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(vec2f(f32(i & 1u), f32(i >> 1u)) * 4.0 - 1.0, 0.0, 1.0); }
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = textureLoad(page, vec2i(p.xy), 0);
  let under = vec3f(0.05, 0.12, 0.22) + vec3f(0.3, 0.1, 0.0) * p.y / 1080.0;
  return vec4f(c.rgb + under * (1.0 - c.a), 1.0);   // (over ours: the page's alpha is premultiplied)
}"#.into()) });
    let pipe = g.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: None, layout: None, vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())] }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None });
    let target = g.device.create_texture(&wgpu::TextureDescriptor { label: None, size: t.size(), mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let bind = g.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&t.create_view(&Default::default())) }] });
    let mut e = g.device.create_command_encoder(&Default::default());
    { let view = target.create_view(&Default::default()); let mut p = e.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
      p.set_pipeline(&pipe); p.set_bind_group(0, &bind, &[]); p.draw(0..3, 0..1); }
    g.queue.submit([e.finish()]); wait(&g);
    let px = read(&g, &target);
    let file = std::fs::File::create(format!("{out}/composed.png")).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), size.0, size.1); enc.set_color(png::ColorType::Rgba); enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&px).unwrap();
    println!("composed: {out}/composed.png");

    send(json!({ "quit": true }));
    std::thread::sleep(Duration::from_millis(300));
    child.kill().ok(); child.wait().ok();
}
