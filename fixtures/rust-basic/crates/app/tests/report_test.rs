use acme_core::util::clamp;

#[test]
fn clamps_above() {
    let value = clamp(5.0, 0.0, 1.0);
    assert_eq!(value, 1.0);
}
