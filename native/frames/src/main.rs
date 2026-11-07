// The studio's shared frames on Linux (app/frames.cjs): images on the GPU, made by Vulkan with memory that exports as a
// DMA-BUF in the driver's own tiled layout (an explicit DRM format modifier), for a render process to draw a frame into
// and the editor's window to show it, neither copying it. (Chromium will not make such images on every driver itself:
// on NVIDIA its allocator refuses the device. Made here, both Chromiums take them.)
//
// Commands on stdin, a line each; answers on stdout, a JSON line each:
//   ring <id> <w> <h> <n>   n RGBA images of w × h: { ring, w, h, modifier, bufs: [{ fd, stride, offset, size }] },
//                           or { ring, error }
//   free <id>               the ring's images let go of here (a process that took them keeps them until it lets go too):
//                           { freed }
// First it says { device, pid }. The descriptors are this process's; another process of the same user takes copies of
// them (pidfd_getfd: app/frames.cjs), which this allows any of them to do. It ends when stdin closes.
// Its GPU: EPHEMERIS_FRAMES_GPU (a part of the device's name), else the first discrete GPU, else the first.
use ash::{ext, khr, vk, Entry};
use std::collections::HashMap;
use std::io::{BufRead, Write};

struct Image { image: vk::Image, memory: vk::DeviceMemory, fd: i32 }

fn say(line: String) {
    let out = std::io::stdout();
    let mut out = out.lock();
    let _ = writeln!(out, "{}", line);
    let _ = out.flush();
}
fn quote(s: &str) -> String { format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")) }

fn main() {
    unsafe {
        if let Err(e) = run() { say(format!("{{\"error\":{}}}", quote(&e))); std::process::exit(1); }
    }
}

unsafe fn run() -> Result<(), String> {
    let entry = Entry::load().map_err(|e| format!("no Vulkan: {e}"))?;
    let app = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_2);
    let instance = entry.create_instance(&vk::InstanceCreateInfo::default().application_info(&app), None).map_err(|e| format!("instance: {e}"))?;
    let devices = instance.enumerate_physical_devices().map_err(|e| format!("devices: {e}"))?;
    let name_of = |p: vk::PhysicalDevice| instance.get_physical_device_properties(p).device_name_as_c_str().map(|c| c.to_string_lossy().to_string()).unwrap_or_default();
    let wanted = std::env::var("EPHEMERIS_FRAMES_GPU").ok().filter(|s| !s.is_empty());
    let pdev = match &wanted {
        Some(w) => devices.iter().copied().find(|p| name_of(*p).to_lowercase().contains(&w.to_lowercase())).ok_or(format!("no GPU named like {w}"))?,
        None => devices.iter().copied().find(|p| instance.get_physical_device_properties(*p).device_type == vk::PhysicalDeviceType::DISCRETE_GPU)
            .or(devices.first().copied()).ok_or("no GPU")?,
    };
    let qfi = instance.get_physical_device_queue_family_properties(pdev).iter()
        .position(|q| q.queue_flags.contains(vk::QueueFlags::GRAPHICS)).ok_or("no graphics queue")? as u32;
    let exts = [khr::external_memory_fd::NAME.as_ptr(), ext::external_memory_dma_buf::NAME.as_ptr(), ext::image_drm_format_modifier::NAME.as_ptr()];
    let prio = [1.0f32];
    let qci = [vk::DeviceQueueCreateInfo::default().queue_family_index(qfi).queue_priorities(&prio)];
    let device = instance.create_device(pdev, &vk::DeviceCreateInfo::default().queue_create_infos(&qci).enabled_extension_names(&exts), None)
        .map_err(|e| format!("device ({}): {e}", name_of(pdev)))?;
    let memfd = khr::external_memory_fd::Device::new(&instance, &device);
    let drm = ext::image_drm_format_modifier::Device::new(&instance, &device);

    // (the tiled layouts this driver can draw into, for RGBA: one plane each)
    let fmt = vk::Format::R8G8B8A8_UNORM;
    let mut list = vk::DrmFormatModifierPropertiesListEXT::default();
    instance.get_physical_device_format_properties2(pdev, fmt, &mut vk::FormatProperties2::default().push_next(&mut list));
    let mut mods = vec![vk::DrmFormatModifierPropertiesEXT::default(); list.drm_format_modifier_count as usize];
    let mut list = vk::DrmFormatModifierPropertiesListEXT::default().drm_format_modifier_properties(&mut mods);
    instance.get_physical_device_format_properties2(pdev, fmt, &mut vk::FormatProperties2::default().push_next(&mut list));
    let need = vk::FormatFeatureFlags::COLOR_ATTACHMENT | vk::FormatFeatureFlags::TRANSFER_DST | vk::FormatFeatureFlags::SAMPLED_IMAGE;
    let usable: Vec<u64> = mods.iter().filter(|m| m.drm_format_modifier_plane_count == 1 && m.drm_format_modifier_tiling_features.contains(need)).map(|m| m.drm_format_modifier).collect();
    if usable.is_empty() { return Err(format!("{} offers no RGBA layout it can draw into", name_of(pdev))); }
    let memprops = instance.get_physical_device_memory_properties(pdev);
    libc::prctl(libc::PR_SET_PTRACER, libc::PR_SET_PTRACER_ANY as libc::c_ulong, 0, 0, 0);
    say(format!("{{\"device\":{},\"pid\":{}}}", quote(&name_of(pdev)), std::process::id()));

    let make = |w: u32, h: u32| -> Result<(Image, u64, u64, u64, u64), String> {
        let mut ext_info = vk::ExternalMemoryImageCreateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
        let mut mod_info = vk::ImageDrmFormatModifierListCreateInfoEXT::default().drm_format_modifiers(&usable);
        let ici = vk::ImageCreateInfo::default().image_type(vk::ImageType::TYPE_2D).format(fmt)
            .extent(vk::Extent3D { width: w, height: h, depth: 1 }).mip_levels(1).array_layers(1)
            .samples(vk::SampleCountFlags::TYPE_1).tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
            .usage(vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::TRANSFER_SRC | vk::ImageUsageFlags::SAMPLED)
            .sharing_mode(vk::SharingMode::EXCLUSIVE).initial_layout(vk::ImageLayout::UNDEFINED)
            .push_next(&mut ext_info).push_next(&mut mod_info);
        let image = device.create_image(&ici, None).map_err(|e| format!("image: {e}"))?;
        let req = device.get_image_memory_requirements(image);
        let mt = (0..memprops.memory_type_count).find(|&i| req.memory_type_bits & (1 << i) != 0
            && memprops.memory_types[i as usize].property_flags.contains(vk::MemoryPropertyFlags::DEVICE_LOCAL)).ok_or("no memory for it")?;
        let mut export = vk::ExportMemoryAllocateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
        let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
        let memory = match device.allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(mt).push_next(&mut export).push_next(&mut dedicated), None) {
            Ok(m) => m, Err(e) => { device.destroy_image(image, None); return Err(format!("memory: {e}")); }
        };
        let fail = |e: String| { device.free_memory(memory, None); device.destroy_image(image, None); e };
        device.bind_image_memory(image, memory, 0).map_err(|e| fail(format!("bind: {e}")))?;
        let fd = memfd.get_memory_fd(&vk::MemoryGetFdInfoKHR::default().memory(memory).handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT)).map_err(|e| fail(format!("export: {e}")))?;
        let mut mp = vk::ImageDrmFormatModifierPropertiesEXT::default();
        drm.get_image_drm_format_modifier_properties(image, &mut mp).map_err(|e| fail(format!("layout: {e}")))?;
        let l = device.get_image_subresource_layout(image, vk::ImageSubresource { aspect_mask: vk::ImageAspectFlags::MEMORY_PLANE_0_EXT, mip_level: 0, array_layer: 0 });
        Ok((Image { image, memory, fd }, mp.drm_format_modifier, l.row_pitch, l.offset, req.size))
    };
    let mut rings: HashMap<String, Vec<Image>> = HashMap::new();
    let drop_ring = |imgs: Vec<Image>| { for i in imgs { libc::close(i.fd); device.free_memory(i.memory, None); device.destroy_image(i.image, None); } };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let p: Vec<&str> = line.split_whitespace().collect();
        match p.as_slice() {
            ["ring", id, w, h, n] => {
                let (Ok(w), Ok(h), Ok(n)) = (w.parse::<u32>(), h.parse::<u32>(), n.parse::<usize>()) else { say(format!("{{\"ring\":{},\"error\":\"bad size\"}}", quote(id))); continue };
                if w == 0 || h == 0 || w > 16384 || h > 16384 || n == 0 || n > 8 { say(format!("{{\"ring\":{},\"error\":\"bad size\"}}", quote(id))); continue; }
                let mut imgs = vec![];
                let mut bufs = vec![];
                let mut modifier = 0u64;
                let mut error = None;
                for _ in 0..n {
                    match make(w, h) {
                        Ok((img, m, stride, offset, size)) => { modifier = m; bufs.push(format!("{{\"fd\":{},\"stride\":{},\"offset\":{},\"size\":{}}}", img.fd, stride, offset, size)); imgs.push(img); }
                        Err(e) => { error = Some(e); break; }
                    }
                }
                if let Some(e) = error { drop_ring(imgs); say(format!("{{\"ring\":{},\"error\":{}}}", quote(id), quote(&e))); continue; }
                if let Some(old) = rings.insert(id.to_string(), imgs) { drop_ring(old); }
                say(format!("{{\"ring\":{},\"w\":{},\"h\":{},\"modifier\":\"{}\",\"bufs\":[{}]}}", quote(id), w, h, modifier, bufs.join(",")));
            }
            ["free", id] => { if let Some(imgs) = rings.remove(*id) { drop_ring(imgs); } say(format!("{{\"freed\":{}}}", quote(id))); }
            _ => say(format!("{{\"error\":{}}}", quote(&format!("unknown command: {line}")))),
        }
    }
    for (_, imgs) in rings.drain() { drop_ring(imgs); }
    device.destroy_device(None);
    instance.destroy_instance(None);
    Ok(())
}
