mod app;
mod engine;
mod renderer;
mod session;
mod world;

use std::sync::Arc;

use app::GameApp;
use winit::application::ApplicationHandler;
use winit::event::{DeviceEvent, DeviceId, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::PhysicalKey;
use winit::window::{Window, WindowId};

struct Handler {
    game: Option<GameApp>,
}

impl ApplicationHandler for Handler {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.game.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("Voidborne")
            .with_inner_size(winit::dpi::LogicalSize::new(1280u32, 720u32));
        let window = Arc::new(
            event_loop
                .create_window(attrs)
                .expect("failed to create window"),
        );
        self.game = Some(GameApp::new(window));
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(game) = self.game.as_mut() else {
            return;
        };

        // Feed every event to egui first.
        let consumed = game.egui_on_event(&event).consumed;

        match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                game.resized(size.width, size.height);
            }
            WindowEvent::RedrawRequested => {
                game.update_and_render();
            }
            WindowEvent::MouseInput {
                button: MouseButton::Left,
                state: winit::event::ElementState::Pressed,
                ..
            } if !consumed => {
                game.mouse_left_pressed();
            }
            WindowEvent::MouseInput {
                button: MouseButton::Right,
                state: winit::event::ElementState::Pressed,
                ..
            } if !consumed => {
                game.mouse_right_pressed();
            }
            WindowEvent::KeyboardInput {
                event:
                    winit::event::KeyEvent {
                        physical_key: PhysicalKey::Code(code),
                        state,
                        repeat,
                        ..
                    },
                ..
            } if !consumed => match state {
                winit::event::ElementState::Pressed => {
                    game.key_down(code, repeat);
                }
                winit::event::ElementState::Released => {
                    game.key_up(code);
                }
            },
            _ => {}
        }
    }

    fn device_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _device_id: DeviceId,
        event: DeviceEvent,
    ) {
        if let DeviceEvent::MouseMotion { delta } = event {
            if let Some(game) = self.game.as_mut() {
                game.mouse_moved(delta.0, delta.1);
            }
        }
    }
}

fn main() {
    env_logger::init();

    let event_loop = EventLoop::new().expect("failed to create event loop");
    event_loop.set_control_flow(ControlFlow::Poll);

    let mut handler = Handler { game: None };
    event_loop.run_app(&mut handler).expect("event loop error");
}
