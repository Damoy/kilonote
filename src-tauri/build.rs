fn main() {
    // tauri-build only watches tauri.conf.json and capabilities/: without this line,
    // a new icon would not reach the exe (its Windows resources) until a clean build.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
