pub mod circle;

pub trait Shape {
    fn area(&self) -> f64;

    fn describe(&self) -> String {
        let a = self.area();
        format!("a shape of area {a}")
    }
}
