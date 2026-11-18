// KiloNote — the desktop executable. Everything lives in the library (lib.rs),
// which the Android app starts too.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kilonote_lib::run()
}
