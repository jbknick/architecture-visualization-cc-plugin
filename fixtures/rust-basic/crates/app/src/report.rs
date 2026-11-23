use acme_core::shapes::Shape;

pub fn print(shape: &dyn Shape) {
    let text = shape.describe();
    let area = shape.area();
    println!("{text}: {area}");
}
