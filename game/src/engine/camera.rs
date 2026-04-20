use glam::{Mat4, Vec3};

const SENSITIVITY: f32 = 0.002;

pub struct Camera {
    pub position: Vec3,
    /// Yaw in radians (rotation around Y axis).
    pub yaw: f32,
    /// Pitch in radians (rotation around X axis).
    pub pitch: f32,
}

impl Camera {
    pub fn new() -> Self {
        Self {
            position: Vec3::new(32.0, 20.0, 32.0),
            yaw: 0.0,
            pitch: -0.3,
        }
    }

    /// Unit forward vector from yaw + pitch.
    pub fn forward(&self) -> Vec3 {
        Vec3::new(
            self.pitch.cos() * self.yaw.sin(),
            self.pitch.sin(),
            -self.pitch.cos() * self.yaw.cos(),
        )
    }

    /// Unit right vector (always horizontal).
    pub fn right(&self) -> Vec3 {
        Vec3::new(self.yaw.cos(), 0.0, self.yaw.sin())
    }

    /// Forward projected onto XZ — used for walking so
    /// pitch doesn't affect movement direction.
    pub fn flat_forward(&self) -> Vec3 {
        Vec3::new(
            self.yaw.sin(),
            0.0,
            -self.yaw.cos(),
        )
    }

    pub fn rotate(&mut self, dx: f32, dy: f32) {
        self.yaw += dx * SENSITIVITY;
        self.pitch -= dy * SENSITIVITY;
        let limit = 89.0_f32.to_radians();
        self.pitch = self.pitch.clamp(-limit, limit);
    }

    /// View matrix (right-handed, Y-up).
    pub fn view_matrix(&self) -> Mat4 {
        Mat4::look_to_rh(
            self.position,
            self.forward(),
            Vec3::Y,
        )
    }

    /// Perspective projection matrix.
    pub fn projection_matrix(
        &self,
        aspect: f32,
    ) -> Mat4 {
        Mat4::perspective_rh(
            70.0_f32.to_radians(),
            aspect,
            0.1,
            1000.0,
        )
    }

    pub fn get_pose(&self) -> CameraPose {
        CameraPose {
            position: self.position.to_array(),
            yaw: self.yaw,
            pitch: self.pitch,
        }
    }

    pub fn set_pose(&mut self, pose: &CameraPose) {
        self.position = Vec3::from(pose.position);
        self.yaw = pose.yaw;
        self.pitch = pose.pitch;
    }
}

pub struct CameraPose {
    pub position: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
}
