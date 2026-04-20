use glam::Vec3;

use crate::engine::camera::Camera;
use crate::world::block::BlockType;
use crate::world::World;

const GRAVITY: f32 = -28.0; // units/s²
const JUMP_SPEED: f32 = 9.0; // units/s upward
const WALK_SPEED: f32 = 5.0; // units/s horizontal
const TERMINAL_VEL: f32 = -50.0; // min Y velocity
const EYE_HEIGHT: f32 = 1.6; // camera Y above feet
const HALF_W: f32 = 0.3; // player AABB half-width
const PLAYER_HEIGHT: f32 = 1.8; // player AABB height

pub struct Physics {
    pub velocity: Vec3,
    pub on_ground: bool,
    /// Feet position; camera = feet + EYE_HEIGHT.
    feet: Vec3,
}

impl Physics {
    pub fn new(camera: &Camera) -> Self {
        let feet = Vec3::new(
            camera.position.x,
            camera.position.y - EYE_HEIGHT,
            camera.position.z,
        );
        Self {
            velocity: Vec3::ZERO,
            on_ground: false,
            feet,
        }
    }

    /// Attempt a jump; only when standing on ground.
    pub fn jump(&mut self) {
        if self.on_ground {
            self.velocity.y = JUMP_SPEED;
            self.on_ground = false;
        }
    }

    /// Sync the physics feet position to match the
    /// camera (call after directly moving the camera,
    /// e.g. while flying).
    pub fn sync_to_camera(&mut self, camera: &Camera) {
        self.feet = Vec3::new(
            camera.position.x,
            camera.position.y - EYE_HEIGHT,
            camera.position.z,
        );
    }

    /// Advance physics one frame.
    ///
    /// `wish_x` / `wish_z` — desired horizontal
    /// movement direction (pre-computed from camera
    /// yaw + key input, normalised).
    pub fn update(
        &mut self,
        wish_x: f32,
        wish_z: f32,
        dt: f32,
        world: &World,
        camera: &mut Camera,
    ) {
        // Cap dt to avoid tunnelling through blocks
        // on long pauses / breakpoints.
        let dt = dt.min(0.05);

        // Gravity
        self.velocity.y += GRAVITY * dt;
        if self.velocity.y < TERMINAL_VEL {
            self.velocity.y = TERMINAL_VEL;
        }

        // Horizontal wish velocity
        self.velocity.x = wish_x * WALK_SPEED;
        self.velocity.z = wish_z * WALK_SPEED;

        self.on_ground = false;

        // Sweep X
        self.feet.x += self.velocity.x * dt;
        if self.collides_world(world) {
            self.feet.x -= self.velocity.x * dt;
            self.velocity.x = 0.0;
        }

        // Sweep Y
        let vel_y = self.velocity.y;
        self.feet.y += vel_y * dt;
        if self.collides_world(world) {
            self.feet.y -= vel_y * dt;
            if vel_y < 0.0 {
                self.on_ground = true;
            }
            self.velocity.y = 0.0;
        }

        // Sweep Z
        self.feet.z += self.velocity.z * dt;
        if self.collides_world(world) {
            self.feet.z -= self.velocity.z * dt;
            self.velocity.z = 0.0;
        }

        // Sync camera
        camera.position.x = self.feet.x;
        camera.position.y = self.feet.y + EYE_HEIGHT;
        camera.position.z = self.feet.z;
    }

    fn collides_world(&self, world: &World) -> bool {
        let min_x = self.feet.x - HALF_W;
        let max_x = self.feet.x + HALF_W;
        let min_y = self.feet.y;
        let max_y = self.feet.y + PLAYER_HEIGHT;
        let min_z = self.feet.z - HALF_W;
        let max_z = self.feet.z + HALF_W;

        let bx0 = min_x.floor() as i32;
        let bx1 = max_x.floor() as i32;
        let by0 = min_y.floor() as i32;
        let by1 = max_y.floor() as i32;
        let bz0 = min_z.floor() as i32;
        let bz1 = max_z.floor() as i32;

        for bx in bx0..=bx1 {
            for by in by0..=by1 {
                for bz in bz0..=bz1 {
                    if world.get_block(bx, by, bz) != BlockType::Air {
                        return true;
                    }
                }
            }
        }
        false
    }

    pub fn get_state(&self) -> PhysicsState {
        PhysicsState {
            velocity: self.velocity.to_array(),
            on_ground: self.on_ground,
        }
    }

    pub fn set_state(&mut self, state: &PhysicsState, camera: &Camera) {
        self.velocity = Vec3::from(state.velocity);
        self.on_ground = state.on_ground;
        self.feet = Vec3::new(
            camera.position.x,
            camera.position.y - EYE_HEIGHT,
            camera.position.z,
        );
    }
}

pub struct PhysicsState {
    pub velocity: [f32; 3],
    pub on_ground: bool,
}
