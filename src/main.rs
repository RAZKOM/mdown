// The real viewer. `mdown` (src/launcher) is a thin console front-end that starts this;
// file associations point here directly so a double-click never flashes a console window.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod config;
mod settings;


fn main() {
    println!("Hello, world!");
}
