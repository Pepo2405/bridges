// Evita abrir una consola extra en Windows en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    forge_client_lib::run()
}
