pub fn clamp(value: f64, low: f64, high: f64) -> f64 {
    if value < low {
        low
    } else if value > high {
        high
    } else {
        value
    }
}

pub fn round_to(value: f64, places: i32) -> f64 {
    let scale = 10f64.powi(places);
    (clamp(value, -1.0e12, 1.0e12) * scale).round() / scale
}
