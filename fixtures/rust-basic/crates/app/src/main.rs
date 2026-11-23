mod report;

use acme_core::shapes::circle::{self, Circle};
use acme_core::shapes::Shape;
use acme_core::util::{clamp, round_to};

fn main() {
    let c = Circle::new(2.0);
    let unit = circle::unit();
    let area = clamp(c.area(), 0.0, 100.0);
    let rounded = round_to(area, 2);
    println!("{rounded}");
    report::print(&c);
    report::print(&unit);
}
