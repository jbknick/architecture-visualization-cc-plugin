use super::Shape;
use crate::util::clamp;

pub struct Circle {
    radius: f64,
}

impl Circle {
    pub fn new(radius: f64) -> Self {
        Circle { radius: clamp(radius, 0.0, 1000.0) }
    }

    pub fn scaled(&self, factor: f64) -> Circle {
        Self::new(self.radius * factor)
    }
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        3.14159 * self.radius * self.radius
    }
}

pub fn unit() -> Circle {
    Circle::new(1.0)
}
