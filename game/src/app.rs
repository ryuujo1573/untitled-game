use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use glam::Vec3;
use winit::keyboard::KeyCode;
use winit::window::Window;

use crate::engine::camera::Camera;
use crate::engine::physics::Physics;
use crate::engine::raycaster::raycast;
use crate::renderer::render_loop::{spawn_render_thread, RenderCommand};
use crate::renderer::types::{CameraState, ChunkMeshData, EguiFrame, FrameState};
use crate::renderer::RendererHandle;
use crate::world::block::BlockType;
use crate::world::World;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum GameMode {
    Creative,
    // Survival,  // future
}

impl std::fmt::Display for GameMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GameMode::Creative => write!(f, "Creative"),
        }
    }
}

#[derive(Default, Clone, Copy, PartialEq)]
enum PausePanel {
    #[default]
    Main,
    Settings,
    QuitConfirm,
}

#[derive(Default, Clone, Copy)]
enum MenuAction {
    #[default]
    None,
    Resume,
    Quit,
}

pub struct GameApp {
    pub window: Arc<Window>,
    renderer: RendererHandle,

    egui_ctx: egui::Context,
    egui_winit: egui_winit::State,

    world: World,
    camera: Camera,
    physics: Physics,

    /// Currently held keys.
    keys: HashSet<KeyCode>,
    /// Mouse capture active.
    cursor_grabbed: bool,

    last_tick: Instant,
    world_time: f32,

    /// Block type to place on right-click.
    selected_block: BlockType,

    /// World coords of the currently targeted block.
    targeted_block: Option<[i32; 3]>,

    /// FPS tracking.
    fps: u32,
    frame_count: u32,
    fps_timer: Instant,

    /// Active game mode.
    game_mode: GameMode,
    /// Whether the player is currently flying
    /// (creative mode only).
    flying: bool,
    /// Timestamp of the last Space press (for
    /// double-tap detection).
    last_space_time: Option<Instant>,

    /// Pause state.
    pub paused: bool,
    pause_panel: PausePanel,
    /// Brightness multiplier (0.0 – 2.0, default 1.0).
    brightness: f32,
}

impl GameApp {
    pub fn new(window: Arc<Window>) -> Self {
        use crate::renderer::gpu::GpuContext;
        let gpu = GpuContext::from_window(window.clone());
        let max_texture_side = gpu.max_texture_side;
        let (tx, join) = spawn_render_thread(gpu);
        let renderer = RendererHandle {
            tx,
            join: Some(join),
        };

        let mut world = World::new();
        world.generate(4);

        let camera = Camera::new();
        let physics = Physics::new(&camera);

        // Upload initial chunk meshes.
        let keys: Vec<(i32, i32)> = world.chunks.keys().copied().collect();
        for key in keys {
            let chunk = world.chunks.get(&key).unwrap();
            let mesh = chunk.build_mesh(Some(&world));
            let _ = renderer.tx.send(RenderCommand::LoadChunk(ChunkMeshData {
                cx: key.0,
                cz: key.1,
                positions: mesh.positions,
                normals: mesh.normals,
                uvls: mesh.uvls,
                lights: mesh.lights,
                vertex_count: mesh.vertex_count,
            }));
        }

        let egui_ctx = egui::Context::default();
        let egui_winit = egui_winit::State::new(
            egui_ctx.clone(),
            egui::ViewportId::ROOT,
            &*window,
            Some(window.scale_factor() as f32),
            None,
            Some(max_texture_side),
        );

        Self {
            window,
            renderer,
            egui_ctx,
            egui_winit,
            world,
            camera,
            physics,
            keys: HashSet::new(),
            cursor_grabbed: false,
            last_tick: Instant::now(),
            world_time: 0.25,
            selected_block: BlockType::Dirt,
            targeted_block: None,
            fps: 0,
            frame_count: 0,
            fps_timer: Instant::now(),
            game_mode: GameMode::Creative,
            flying: false,
            last_space_time: None,
            paused: false,
            pause_panel: PausePanel::Main,
            brightness: 1.0,
        }
    }

    pub fn key_down(&mut self, key: KeyCode, repeat: bool) {
        // ESC is always handled (pause navigation).
        if key == KeyCode::Escape {
            if self.paused {
                match self.pause_panel {
                    PausePanel::Main => {
                        self.paused = false;
                        self.set_cursor_grab(true);
                    }
                    _ => {
                        self.pause_panel = PausePanel::Main;
                    }
                }
            } else {
                self.keys.clear();
                self.paused = true;
                self.set_cursor_grab(false);
            }
            return;
        }
        if self.paused {
            return;
        }
        self.keys.insert(key);
        // Only handle one-shot actions on fresh presses,
        // not on OS key-repeat events.
        if repeat {
            return;
        }
        if key == KeyCode::Space {
            if self.game_mode == GameMode::Creative {
                let now = Instant::now();
                let double_tap = self
                    .last_space_time
                    .map(|t| now.duration_since(t).as_secs_f32() < 0.35)
                    .unwrap_or(false);
                if double_tap {
                    // Toggle flying.
                    self.flying = !self.flying;
                    if self.flying {
                        // Kill vertical velocity so
                        // the player doesn't drift.
                        self.physics.velocity.y = 0.0;
                    }
                    self.last_space_time = None;
                } else {
                    self.last_space_time = Some(now);
                    if !self.flying {
                        self.physics.jump();
                    }
                }
            } else {
                self.physics.jump();
            }
        }
    }

    pub fn key_up(&mut self, key: KeyCode) {
        self.keys.remove(&key);
    }

    /// Feed a winit window event to egui.
    /// Returns whether egui consumed it.
    pub fn egui_on_event(
        &mut self,
        event: &winit::event::WindowEvent,
    ) -> egui_winit::EventResponse {
        self.egui_winit.on_window_event(&self.window, event)
    }

    pub fn mouse_moved(&mut self, dx: f64, dy: f64) {
        if self.cursor_grabbed {
            self.camera.rotate(dx as f32, dy as f32);
        }
    }

    pub fn mouse_left_pressed(&mut self) {
        if self.paused {
            return;
        }
        if !self.cursor_grabbed {
            self.set_cursor_grab(true);
            return;
        }
        // Break the targeted block.
        if let Some([bx, by, bz]) = self.targeted_block {
            if let Some((cx, cz)) = self.world.set_block(bx, by, bz, BlockType::Air) {
                self.rebuild_neighbors(bx, by, bz, cx, cz);
            }
        }
    }

    pub fn mouse_right_pressed(&mut self) {
        if self.paused || !self.cursor_grabbed {
            return;
        }
        // Place selected block adjacent to targeted face.
        let eye = self.camera.position;
        let dir = self.camera.forward();
        if let Some(hit) = raycast(eye, dir, &self.world, 8.0) {
            let px = hit.bx + hit.nx;
            let py = hit.by + hit.ny;
            let pz = hit.bz + hit.nz;
            if self.world.get_block(px, py, pz) == BlockType::Air {
                let b = self.selected_block;
                if let Some((cx, cz)) = self.world.set_block(px, py, pz, b) {
                    self.rebuild_neighbors(px, py, pz, cx, cz);
                }
            }
        }
    }

    pub fn resized(&mut self, width: u32, height: u32) {
        let _ = self
            .renderer
            .tx
            .send(RenderCommand::Resize { width, height });
    }

    /// Called each frame from the winit event loop.
    pub fn update_and_render(&mut self) {
        let now = Instant::now();
        let dt = now.duration_since(self.last_tick).as_secs_f32();
        self.last_tick = now;

        // Advance world time (0-1, day cycle).
        self.world_time = (self.world_time + dt / 120.0) % 1.0;

        if !self.paused {
            if self.flying {
                // ── Flying physics ─────────────────
                const FLY_SPEED: f32 = 10.0;
                let (wish_x, wish_z) = self.compute_wish_vel();
                let wish_y = if self.keys.contains(&KeyCode::Space) {
                    1.0_f32
                } else if self.keys.contains(&KeyCode::ShiftLeft)
                    || self.keys.contains(&KeyCode::ShiftRight)
                {
                    -1.0_f32
                } else {
                    0.0_f32
                };
                let dt = dt.min(0.05);
                self.camera.position.x += wish_x * FLY_SPEED * dt;
                self.camera.position.y += wish_y * FLY_SPEED * dt;
                self.camera.position.z += wish_z * FLY_SPEED * dt;
                // Keep physics feet in sync so that
                // landing after disabling fly works.
                self.physics.velocity = Vec3::ZERO;
                self.physics.sync_to_camera(&self.camera);
            } else {
                // ── Normal physics ─────────────────
                let (wish_x, wish_z) = self.compute_wish_vel();
                self.physics
                    .update(wish_x, wish_z, dt, &self.world, &mut self.camera);
            }

            // Raycast to find targeted block.
            let eye = self.camera.position;
            let dir = self.camera.forward();
            self.targeted_block = raycast(eye, dir, &self.world, 8.0).map(|h| [h.bx, h.by, h.bz]);
        } else {
            // Clear targeted block while paused.
            self.targeted_block = None;
        }

        // FPS + window title (update once per second).
        self.frame_count += 1;
        let fps_elapsed = now.duration_since(self.fps_timer).as_secs_f32();
        if fps_elapsed >= 1.0 {
            self.fps = self.frame_count;
            self.frame_count = 0;
            self.fps_timer = now;
            let p = self.camera.position;
            let block_name = self
                .targeted_block
                .map(|[bx, by, bz]| format!("{:?}", self.world.get_block(bx, by, bz)))
                .unwrap_or_else(|| "—".to_string());
            let _ = self.window.set_title(&format!(
                "Voidborne  \
                 FPS:{fps}  \
                 XYZ:{x:.1},{y:.1},{z:.1}  \
                 Looking:{block}",
                fps = self.fps,
                x = p.x,
                y = p.y,
                z = p.z,
                block = block_name,
            ));
        }

        // Build frame state.
        let size = self.window.inner_size();
        let aspect = size.width as f32 / size.height as f32;
        let view = self.camera.view_matrix().to_cols_array();
        let proj = self.camera.projection_matrix(aspect).to_cols_array();

        let sun_angle = self.world_time * 2.0 * std::f32::consts::PI;
        let sun_dir = [
            sun_angle.cos(),
            sun_angle.sin().abs() + 0.2,
            sun_angle.sin() * 0.3,
        ];

        let _ = self
            .renderer
            .tx
            .send(RenderCommand::UpdateFrame(FrameState {
                camera: CameraState {
                    position: self.camera.position.to_array(),
                    view_matrix: view,
                    projection_matrix: proj,
                },
                sun_direction: sun_dir,
                time: self.world_time,
                targeted_block: self.targeted_block,
            }));

        // ── egui frame ─────────────────────────────
        let raw = self.egui_winit.take_egui_input(&self.window);
        let ppp = self.window.scale_factor() as f32;

        // Snapshots (Copy) for the closure.
        let paused = self.paused;
        let cam_pos = self.camera.position;
        let fps = self.fps;
        let targeted = self.targeted_block;
        let game_mode = self.game_mode;
        let flying = self.flying;

        // Mutable locals for UI-driven state changes.
        let mut next_panel = self.pause_panel;
        let mut brightness = self.brightness;
        let mut action = MenuAction::None;

        let full_output = self.egui_ctx.run(raw, |ctx| {
            ctx.set_visuals(egui::Visuals::dark());
            action = pause_ui(
                ctx,
                paused,
                cam_pos,
                fps,
                targeted,
                game_mode,
                flying,
                &mut next_panel,
                &mut brightness,
            );
        });

        // Apply UI state changes.
        self.pause_panel = next_panel;
        self.brightness = brightness;
        match action {
            MenuAction::Resume => {
                self.paused = false;
                self.set_cursor_grab(true);
            }
            MenuAction::Quit => {
                std::process::exit(0);
            }
            MenuAction::None => {}
        }

        self.egui_winit
            .handle_platform_output(&self.window, full_output.platform_output);
        let primitives = self.egui_ctx.tessellate(full_output.shapes, ppp);
        let inner = self.window.inner_size();
        let screen_descriptor = egui_wgpu::ScreenDescriptor {
            size_in_pixels: [inner.width, inner.height],
            pixels_per_point: ppp,
        };
        let _ = self.renderer.tx.send(RenderCommand::UpdateEgui(EguiFrame {
            primitives,
            textures_delta: full_output.textures_delta,
            screen_descriptor,
        }));

        self.window.request_redraw();
    }

    fn compute_wish_vel(&self) -> (f32, f32) {
        let ff = self.camera.flat_forward();
        let rr = self.camera.right();
        let mut wx = 0.0f32;
        let mut wz = 0.0f32;

        if self.keys.contains(&KeyCode::KeyW) {
            wx += ff.x;
            wz += ff.z;
        }
        if self.keys.contains(&KeyCode::KeyS) {
            wx -= ff.x;
            wz -= ff.z;
        }
        if self.keys.contains(&KeyCode::KeyA) {
            wx -= rr.x;
            wz -= rr.z;
        }
        if self.keys.contains(&KeyCode::KeyD) {
            wx += rr.x;
            wz += rr.z;
        }

        // Normalise diagonal movement.
        let len = (wx * wx + wz * wz).sqrt().max(f32::EPSILON);
        if len > 1.0 {
            (wx / len, wz / len)
        } else {
            (wx, wz)
        }
    }

    /// Send updated mesh for (cx,cz) and its edge
    /// neighbors if the modified block touches a face.
    fn rebuild_neighbors(&self, wx: i32, _wy: i32, wz: i32, cx: i32, cz: i32) {
        self.send_chunk_mesh(cx, cz);
        let lx = wx.rem_euclid(16);
        let lz = wz.rem_euclid(16);
        if lx == 0 {
            self.send_chunk_mesh(cx - 1, cz);
        }
        if lx == 15 {
            self.send_chunk_mesh(cx + 1, cz);
        }
        if lz == 0 {
            self.send_chunk_mesh(cx, cz - 1);
        }
        if lz == 15 {
            self.send_chunk_mesh(cx, cz + 1);
        }
    }

    fn send_chunk_mesh(&self, cx: i32, cz: i32) {
        if !self.world.chunks.contains_key(&(cx, cz)) {
            return;
        }
        let snapshot = self.world.mesh_snapshot(cx, cz);
        let tx = self.renderer.tx.clone();
        std::thread::spawn(move || {
            let Some(chunk) = snapshot.get_chunk(cx, cz) else {
                return;
            };
            let mesh = chunk.build_mesh(Some(&snapshot));
            let _ = tx.send(RenderCommand::LoadChunk(ChunkMeshData {
                cx,
                cz,
                positions: mesh.positions,
                normals: mesh.normals,
                uvls: mesh.uvls,
                lights: mesh.lights,
                vertex_count: mesh.vertex_count,
            }));
        });
    }

    fn set_cursor_grab(&mut self, grab: bool) {
        use winit::window::CursorGrabMode;
        self.cursor_grabbed = grab;
        let _ = self.window.set_cursor_visible(!grab);
        if grab {
            // Try confined first, fall back to locked.
            if self
                .window
                .set_cursor_grab(CursorGrabMode::Confined)
                .is_err()
            {
                let _ = self.window.set_cursor_grab(CursorGrabMode::Locked);
            }
        } else {
            let _ = self.window.set_cursor_grab(CursorGrabMode::None);
        }
    }
}

// ── Pause menu UI (standalone to avoid self borrows) ──

fn pause_ui(
    ctx: &egui::Context,
    paused: bool,
    cam_pos: Vec3,
    fps: u32,
    targeted: Option<[i32; 3]>,
    game_mode: GameMode,
    flying: bool,
    panel: &mut PausePanel,
    brightness: &mut f32,
) -> MenuAction {
    // Always show debug overlay (top-left).
    egui::Area::new(egui::Id::new("debug_hud"))
        .fixed_pos(egui::pos2(8.0, 8.0))
        .order(egui::Order::Foreground)
        .show(ctx, |ui| {
            egui::Frame::none()
                .fill(egui::Color32::from_black_alpha(120))
                .inner_margin(egui::Margin::same(6))
                .rounding(egui::CornerRadius::same(4))
                .show(ui, |ui| {
                    let mono = |s: &str| {
                        egui::RichText::new(s)
                            .monospace()
                            .size(12.0)
                            .color(egui::Color32::WHITE)
                    };
                    ui.label(mono(&format!("FPS: {fps}")));
                    ui.label(mono(&format!(
                        "XYZ: {:.1} / {:.1} / {:.1}",
                        cam_pos.x, cam_pos.y, cam_pos.z,
                    )));
                    let mode_str = if flying {
                        format!("{game_mode} (Flying)")
                    } else {
                        format!("{game_mode}")
                    };
                    ui.label(mono(&format!("Mode: {mode_str}")));
                    if let Some([bx, by, bz]) = targeted {
                        ui.label(mono(&format!("Target: {bx},{by},{bz}")));
                    }
                });
        });

    if !paused {
        return MenuAction::None;
    }

    // ── Dark backdrop ──────────────────────────────
    let screen = ctx.screen_rect();
    ctx.layer_painter(egui::LayerId::new(
        egui::Order::Background,
        egui::Id::new("pause_backdrop"),
    ))
    .rect_filled(screen, 0.0, egui::Color32::from_black_alpha(160));

    let card = egui::Frame::none()
        .fill(egui::Color32::from_rgba_unmultiplied(12, 18, 28, 238))
        .rounding(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::same(24));

    let mut action = MenuAction::None;

    match *panel {
        // ── Main pause panel ───────────────────────
        PausePanel::Main => {
            egui::Area::new(egui::Id::new("pause_main"))
                .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
                .show(ctx, |ui| {
                    card.show(ui, |ui| {
                        ui.set_min_width(260.0);
                        ui.vertical_centered(|ui| {
                            ui.add_space(4.0);
                            ui.label(
                                egui::RichText::new("Paused")
                                    .size(28.0)
                                    .color(egui::Color32::WHITE)
                                    .strong(),
                            );
                            ui.add_space(16.0);

                            let btn = egui::vec2(240.0, 36.0);
                            if ui.add_sized(btn, egui::Button::new("Resume")).clicked() {
                                action = MenuAction::Resume;
                            }
                            ui.add_space(6.0);
                            if ui.add_sized(btn, egui::Button::new("Settings")).clicked() {
                                *panel = PausePanel::Settings;
                            }
                            ui.add_space(6.0);
                            if ui
                                .add_sized(
                                    btn,
                                    egui::Button::new(
                                        egui::RichText::new("Quit to title")
                                            .color(egui::Color32::from_rgb(255, 110, 110)),
                                    ),
                                )
                                .clicked()
                            {
                                *panel = PausePanel::QuitConfirm;
                            }
                            ui.add_space(4.0);
                        });
                    });
                });
        }

        // ── Settings panel ─────────────────────────
        PausePanel::Settings => {
            egui::Area::new(egui::Id::new("pause_settings"))
                .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
                .show(ctx, |ui| {
                    card.show(ui, |ui| {
                        ui.set_min_width(300.0);
                        ui.horizontal(|ui| {
                            if ui.button("← Back").clicked() {
                                *panel = PausePanel::Main;
                            }
                            ui.add_space(8.0);
                            ui.label(
                                egui::RichText::new("Settings")
                                    .size(22.0)
                                    .color(egui::Color32::WHITE)
                                    .strong(),
                            );
                        });
                        ui.add_space(16.0);

                        // Brightness slider (0 – 200 %).
                        let mut pct = (*brightness * 100.0).round() as i32;
                        ui.horizontal(|ui| {
                            ui.label(
                                egui::RichText::new("Brightness")
                                    .color(egui::Color32::from_gray(210)),
                            );
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    ui.label(
                                        egui::RichText::new(format!("{pct}%"))
                                            .monospace()
                                            .color(egui::Color32::from_gray(180)),
                                    );
                                },
                            );
                        });
                        let mut pct_f = pct as f32;
                        if ui
                            .add(egui::Slider::new(&mut pct_f, 0.0..=200.0).show_value(false))
                            .changed()
                        {
                            *brightness = pct_f / 100.0;
                        }

                        ui.add_space(20.0);
                        if ui
                            .add_sized([252.0, 32.0], egui::Button::new("Done"))
                            .clicked()
                        {
                            *panel = PausePanel::Main;
                        }
                    });
                });
        }

        // ── Quit confirm ───────────────────────────
        PausePanel::QuitConfirm => {
            // Extra dark overlay.
            ctx.layer_painter(egui::LayerId::new(
                egui::Order::Foreground,
                egui::Id::new("qc_backdrop"),
            ))
            .rect_filled(screen, 0.0, egui::Color32::from_black_alpha(100));

            egui::Area::new(egui::Id::new("quit_confirm"))
                .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
                .show(ctx, |ui| {
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgba_unmultiplied(12, 18, 28, 245))
                        .rounding(egui::CornerRadius::same(10))
                        .inner_margin(egui::Margin::same(24))
                        .stroke(egui::Stroke::new(
                            1.0,
                            egui::Color32::from_rgba_unmultiplied(255, 255, 255, 25),
                        ))
                        .show(ui, |ui| {
                            ui.set_min_width(280.0);
                            ui.label(
                                egui::RichText::new("Quit to title")
                                    .size(18.0)
                                    .color(egui::Color32::WHITE)
                                    .strong(),
                            );
                            ui.add_space(4.0);
                            ui.label(
                                egui::RichText::new(
                                    "Save this world \
                                 before leaving?",
                                )
                                .color(egui::Color32::from_gray(170)),
                            );
                            ui.add_space(16.0);
                            ui.horizontal(|ui| {
                                if ui
                                    .add_sized([80.0, 30.0], egui::Button::new("Save"))
                                    .clicked()
                                {
                                    // TODO: save
                                    action = MenuAction::Quit;
                                }
                                if ui
                                    .add_sized([80.0, 30.0], egui::Button::new("Discard"))
                                    .clicked()
                                {
                                    action = MenuAction::Quit;
                                }
                                if ui
                                    .add_sized([80.0, 30.0], egui::Button::new("Cancel"))
                                    .clicked()
                                {
                                    *panel = PausePanel::Main;
                                }
                            });
                        });
                });
        }
    }

    action
}
