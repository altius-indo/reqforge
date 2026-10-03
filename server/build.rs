// rust-embed needs ../web/dist to exist at compile time; create a placeholder if the UI
// has not been built yet (`cd web && npm run build` replaces it).
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/dist");
    if !dist.join("index.html").exists() {
        let _ = std::fs::create_dir_all(&dist);
        let _ = std::fs::write(dist.join("index.html"), "<!doctype html><title>reqforge</title><p>UI not built: run <code>npm run build</code> in web/.</p>");
    }
    println!("cargo:rerun-if-changed=../web/dist");
}
