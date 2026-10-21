use std::path::PathBuf;

const DEFAULT: (f64, f64) = (900.0, 700.0);

fn file() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("mdown").join("window.json"))
}

pub fn webview_dir() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("mdown").join("webview"))
}

pub fn load_size() -> (f64, f64) {
    let read = || -> Option<(f64, f64)> {
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(file()?).ok()?).ok()?;
        let (w, h) = (v["w"].as_f64()?, v["h"].as_f64()?);
        ((200.0..10000.0).contains(&w) && (150.0..10000.0).contains(&h)).then_some((w, h))
    };
    read().unwrap_or(DEFAULT)
}

pub fn save_size(w: f64, h: f64) {
    let Some(path) = file() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::json!({ "w": w, "h": h }).to_string());
}
