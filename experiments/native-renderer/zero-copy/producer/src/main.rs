// Zero-copy spike, the producer: a ring of images on the NVIDIA card, made by Vulkan with memory that exports as a
// DMA-BUF (an explicit DRM format modifier), drawn each frame (a background that changes with the frame, a moving bar,
// a corner block whose red is the frame number) and announced on stdout once the GPU has finished it.
// usage: producer <w> <h> <linear|tiled|alloc> <frames> [fps]   (alloc: make and export the ring, draw nothing, until stdin closes)
use ash::{ext, khr, vk, Entry};
use std::io::Write;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RING: usize = 3;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let w: u32 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(1472);
    let h: u32 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(828);
    let linear = a.get(3).map(|s| s == "linear").unwrap_or(true);
    let alloc_only = a.get(3).map(|s| s == "alloc").unwrap_or(false);
    let frames: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(600);
    let fps: f64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(60.0);
    unsafe { run(w, h, linear && !alloc_only, alloc_only, frames, fps) }
}

unsafe fn run(w: u32, h: u32, linear: bool, alloc_only: bool, frames: u64, fps: f64) {
    let entry = Entry::load().expect("vulkan loader");
    let app = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_3);
    let instance = entry.create_instance(&vk::InstanceCreateInfo::default().application_info(&app), None).expect("instance");
    let pdev = instance.enumerate_physical_devices().unwrap().into_iter().find(|p| {
        let pr = instance.get_physical_device_properties(*p);
        pr.device_name_as_c_str().unwrap().to_string_lossy().contains("NVIDIA")
    }).expect("an NVIDIA device");
    let name = instance.get_physical_device_properties(pdev).device_name_as_c_str().unwrap().to_string_lossy().to_string();
    let qfi = instance.get_physical_device_queue_family_properties(pdev).iter()
        .position(|q| q.queue_flags.contains(vk::QueueFlags::GRAPHICS)).unwrap() as u32;
    let exts = [khr::external_memory_fd::NAME.as_ptr(), ext::external_memory_dma_buf::NAME.as_ptr(),
        ext::image_drm_format_modifier::NAME.as_ptr(), ext::queue_family_foreign::NAME.as_ptr()];
    let prio = [1.0f32];
    let qci = [vk::DeviceQueueCreateInfo::default().queue_family_index(qfi).queue_priorities(&prio)];
    let mut f13 = vk::PhysicalDeviceVulkan13Features::default().dynamic_rendering(true).synchronization2(true);
    let device = instance.create_device(pdev, &vk::DeviceCreateInfo::default().queue_create_infos(&qci)
        .enabled_extension_names(&exts).push_next(&mut f13), None).expect("device");
    let queue = device.get_device_queue(qfi, 0);
    let memfd = khr::external_memory_fd::Device::new(&instance, &device);
    let drm = ext::image_drm_format_modifier::Device::new(&instance, &device);

    // the modifiers this driver offers for BGRA (DRM ARGB8888)
    let fmt = vk::Format::B8G8R8A8_UNORM;
    let mut list = vk::DrmFormatModifierPropertiesListEXT::default();
    instance.get_physical_device_format_properties2(pdev, fmt, &mut vk::FormatProperties2::default().push_next(&mut list));
    let mut mods = vec![vk::DrmFormatModifierPropertiesEXT::default(); list.drm_format_modifier_count as usize];
    let mut list = vk::DrmFormatModifierPropertiesListEXT::default().drm_format_modifier_properties(&mut mods);
    instance.get_physical_device_format_properties2(pdev, fmt, &mut vk::FormatProperties2::default().push_next(&mut list));
    let need = vk::FormatFeatureFlags::COLOR_ATTACHMENT | vk::FormatFeatureFlags::TRANSFER_DST;
    for m in &mods { eprintln!("modifier {:#018x} planes {} color+transfer {}", m.drm_format_modifier, m.drm_format_modifier_plane_count, m.drm_format_modifier_tiling_features.contains(need)); }
    let modifier = mods.iter().filter(|m| m.drm_format_modifier_plane_count == 1 && m.drm_format_modifier_tiling_features.contains(need))
        .map(|m| m.drm_format_modifier).find(|&m| if linear { m == 0 } else { m != 0 }).expect("a usable modifier");

    let memprops = instance.get_physical_device_memory_properties(pdev);
    let mut bufs = vec![];
    for _ in 0..RING {
        let mut ext_info = vk::ExternalMemoryImageCreateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
        let one = [modifier];
        let mut mod_info = vk::ImageDrmFormatModifierListCreateInfoEXT::default().drm_format_modifiers(&one);
        let ici = vk::ImageCreateInfo::default().image_type(vk::ImageType::TYPE_2D).format(fmt)
            .extent(vk::Extent3D { width: w, height: h, depth: 1 }).mip_levels(1).array_layers(1)
            .samples(vk::SampleCountFlags::TYPE_1).tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
            .usage(vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::TRANSFER_SRC | vk::ImageUsageFlags::SAMPLED)
            .sharing_mode(vk::SharingMode::EXCLUSIVE).initial_layout(vk::ImageLayout::UNDEFINED)
            .push_next(&mut ext_info).push_next(&mut mod_info);
        let image = device.create_image(&ici, None).expect("image");
        let req = device.get_image_memory_requirements(image);
        let mt = (0..memprops.memory_type_count).find(|&i| req.memory_type_bits & (1 << i) != 0
            && memprops.memory_types[i as usize].property_flags.contains(vk::MemoryPropertyFlags::DEVICE_LOCAL)).expect("memory type");
        let mut export = vk::ExportMemoryAllocateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
        let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
        let mem = device.allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(mt)
            .push_next(&mut export).push_next(&mut dedicated), None).expect("memory");
        device.bind_image_memory(image, mem, 0).unwrap();
        let fd = memfd.get_memory_fd(&vk::MemoryGetFdInfoKHR::default().memory(mem).handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT)).expect("export fd");
        let mut mp = vk::ImageDrmFormatModifierPropertiesEXT::default();
        drm.get_image_drm_format_modifier_properties(image, &mut mp).unwrap();
        let layout = device.get_image_subresource_layout(image, vk::ImageSubresource { aspect_mask: vk::ImageAspectFlags::MEMORY_PLANE_0_EXT, mip_level: 0, array_layer: 0 });
        let view = device.create_image_view(&vk::ImageViewCreateInfo::default().image(image).view_type(vk::ImageViewType::TYPE_2D).format(fmt)
            .subresource_range(vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 }), None).unwrap();
        bufs.push((image, view, fd, layout.row_pitch, layout.offset, req.size, mp.drm_format_modifier));
    }
    let pool = device.create_command_pool(&vk::CommandPoolCreateInfo::default().queue_family_index(qfi)
        .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER), None).unwrap();
    let cmd = device.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).command_buffer_count(1)).unwrap()[0];
    let fence = device.create_fence(&vk::FenceCreateInfo::default(), None).unwrap();

    let out = std::io::stdout();
    let b: Vec<String> = bufs.iter().map(|x| format!("{{\"fd\":{},\"stride\":{},\"offset\":{},\"size\":{}}}", x.2, x.3, x.4, x.5)).collect();
    writeln!(out.lock(), "{{\"device\":\"{}\",\"w\":{},\"h\":{},\"modifier\":\"{}\",\"bufs\":[{}]}}", name, w, h, bufs[0].6, b.join(",")).unwrap();
    out.lock().flush().unwrap();

    if alloc_only {
        // (any process of this user may take the descriptors with pidfd_getfd, not only our parent)
        libc::prctl(libc::PR_SET_PTRACER, libc::PR_SET_PTRACER_ANY as libc::c_ulong, 0, 0, 0);
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        return;
    }
    let range = vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 };
    let start = Instant::now();
    for n in 0..frames {
        let k = (n as usize) % RING;
        let (image, view, ..) = bufs[k];
        device.reset_command_buffer(cmd, vk::CommandBufferResetFlags::empty()).unwrap();
        device.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default()).unwrap();
        // (taken back from whoever read it, its contents dropped)
        let acquire = [vk::ImageMemoryBarrier2::default().image(image).subresource_range(range)
            .src_stage_mask(vk::PipelineStageFlags2::TOP_OF_PIPE).dst_stage_mask(vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT)
            .dst_access_mask(vk::AccessFlags2::COLOR_ATTACHMENT_WRITE)
            .old_layout(vk::ImageLayout::UNDEFINED).new_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)
            .src_queue_family_index(vk::QUEUE_FAMILY_FOREIGN_EXT).dst_queue_family_index(qfi)];
        device.cmd_pipeline_barrier2(cmd, &vk::DependencyInfo::default().image_memory_barriers(&acquire));
        let t = n as f32 / 60.0;
        let bg = vk::ClearValue { color: vk::ClearColorValue { float32: [0.2 + 0.2 * (t * 2.0).sin(), 0.25, 0.45 + 0.2 * (t * 1.3).cos(), 1.0] } };
        let att = [vk::RenderingAttachmentInfo::default().image_view(view).image_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)
            .load_op(vk::AttachmentLoadOp::CLEAR).store_op(vk::AttachmentStoreOp::STORE).clear_value(bg)];
        device.cmd_begin_rendering(cmd, &vk::RenderingInfo::default().render_area(vk::Rect2D { offset: vk::Offset2D::default(), extent: vk::Extent2D { width: w, height: h } })
            .layer_count(1).color_attachments(&att));
        let bar_x = ((n * 8) % (w as u64 - 64)) as i32;
        let clear = |c: [f32; 4], x: i32, y: i32, cw: u32, ch: u32| {
            let a = [vk::ClearAttachment { aspect_mask: vk::ImageAspectFlags::COLOR, color_attachment: 0, clear_value: vk::ClearValue { color: vk::ClearColorValue { float32: c } } }];
            let r = [vk::ClearRect { rect: vk::Rect2D { offset: vk::Offset2D { x, y }, extent: vk::Extent2D { width: cw, height: ch } }, base_array_layer: 0, layer_count: 1 }];
            device.cmd_clear_attachments(cmd, &a, &r);
        };
        clear([1.0, 1.0, 1.0, 1.0], bar_x, 0, 64, h);
        clear([(n % 256) as f32 / 255.0, 1.0, 0.0, 1.0], 0, 0, 32, 32);
        device.cmd_end_rendering(cmd);
        // (handed over to whoever reads it next)
        let release = [vk::ImageMemoryBarrier2::default().image(image).subresource_range(range)
            .src_stage_mask(vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT).src_access_mask(vk::AccessFlags2::COLOR_ATTACHMENT_WRITE)
            .dst_stage_mask(vk::PipelineStageFlags2::BOTTOM_OF_PIPE)
            .old_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL).new_layout(vk::ImageLayout::GENERAL)
            .src_queue_family_index(qfi).dst_queue_family_index(vk::QUEUE_FAMILY_FOREIGN_EXT)];
        device.cmd_pipeline_barrier2(cmd, &vk::DependencyInfo::default().image_memory_barriers(&release));
        device.end_command_buffer(cmd).unwrap();
        let cmds = [cmd];
        device.queue_submit(queue, &[vk::SubmitInfo::default().command_buffers(&cmds)], fence).unwrap();
        device.wait_for_fences(&[fence], true, u64::MAX).unwrap();
        device.reset_fences(&[fence]).unwrap();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
        writeln!(out.lock(), "{{\"frame\":{},\"buf\":{},\"t\":{:.3},\"bar\":{}}}", n, k, now, bar_x).unwrap();
        out.lock().flush().unwrap();
        let next = start + Duration::from_secs_f64((n + 1) as f64 / fps);
        if let Some(d) = next.checked_duration_since(Instant::now()) { std::thread::sleep(d); }
    }
    std::thread::sleep(Duration::from_millis(500));
}
