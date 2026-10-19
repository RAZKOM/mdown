// User settings, shared by the viewer and the `mdown` launcher. A small JSON file:
//   Windows  %APPDATA%\mdown\settings.json
//   macOS    ~/Library/Application Support/mdown/settings.json
//   { "theme": "system" | "light" | "dark", "width": "normal" | "wide", "zoom": 1.0 }
// Unknown keys are preserved, and anything missing or invalid falls back to its default.
// The viewer and the launcher each compile this file and use different halves of it.
#![allow(dead_code)]

use std::path::PathBuf;

use serde_json::{Map, Value};

pub const THEMES: [&str; 3] = ["system", "light", "dark"];
pub const WIDTHS: [&str; 2] = ["normal", "wide"];
const ZOOM_RANGE: (f64, f64) = (0.5, 3.0);
const ZOOM_STEP: f64 = 0.1;

pub struct Settings {
    pub theme: String,
    pub width: String,
    pub zoom: f64,
}

pub fn file() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("mdown").join("settings.json"))
}

fn read() -> Map<String, Value> {
    file()
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn from_map(m: &Map<String, Value>) -> Settings {
    let pick = |key: &str, allowed: &[&str]| match m.get(key).and_then(Value::as_str) {
        Some(v) if allowed.contains(&v) => v.to_string(),
        _ => allowed[0].to_string(),
    };
    let zoom = m.get("zoom").and_then(Value::as_f64).filter(|z| (ZOOM_RANGE.0..=ZOOM_RANGE.1).contains(z)).unwrap_or(1.0);
    Settings { theme: pick("theme", &THEMES), width: pick("width", &WIDTHS), zoom }
}

pub fn load() -> Settings {
    from_map(&read())
}

pub fn theme() -> String {
    load().theme
}

/// Checks `value` for `key` and returns the value to store. `zoom` also accepts the steps
/// "in", "out" and "reset", which are relative to `current`.
fn validate(key: &str, value: &Value, current: &Settings) -> Result<Value, String> {
    let text = value.as_str();
    match key {
        "theme" => text.filter(|t| THEMES.contains(t)).map(Value::from).ok_or_else(|| format!("theme must be one of: {}", THEMES.join(", "))),
        "width" => text.filter(|w| WIDTHS.contains(w)).map(Value::from).ok_or_else(|| format!("width must be one of: {}", WIDTHS.join(", "))),
        "zoom" => {
            let next = match (text, value.as_f64()) {
                (Some("in"), _) => current.zoom + ZOOM_STEP,
                (Some("out"), _) => current.zoom - ZOOM_STEP,
                (Some("reset"), _) => 1.0,
                (_, Some(z)) => z,
                _ => return Err("zoom must be a number or one of: in, out, reset".into()),
            };
            // Two decimals keeps repeated steps from drifting (1.0000000000000002 and friends).
            Ok(Value::from(((next.clamp(ZOOM_RANGE.0, ZOOM_RANGE.1)) * 100.0).round() / 100.0))
        }
        _ => Err(format!("unknown setting: {key}")),
    }
}

pub fn set(key: &str, value: &Value) -> Result<(), String> {
    let path = file().ok_or("cannot find the config folder")?;
    let mut map = read();
    let stored = validate(key, value, &from_map(&map))?;
    map.insert(key.to_string(), stored);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| e.to_string())
}

pub fn set_theme(theme: &str) -> Result<(), String> {
    set("theme", &Value::from(theme))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults() -> Settings {
        from_map(&Map::new())
    }

    #[test]
    fn defaults_apply_when_missing_or_invalid() {
        let s = from_map(json!({ "theme": "neon", "width": 5, "zoom": 99 }).as_object().unwrap());
        assert_eq!((s.theme.as_str(), s.width.as_str(), s.zoom), ("system", "normal", 1.0));
    }

    #[test]
    fn rejects_bad_values() {
        let d = defaults();
        assert!(validate("theme", &json!("neon"), &d).is_err());
        assert!(validate("width", &json!(""), &d).is_err());
        assert!(validate("zoom", &json!("sideways"), &d).is_err());
        assert!(validate("colour", &json!("red"), &d).is_err());
        assert_eq!(validate("theme", &json!("dark"), &d), Ok(json!("dark")));
    }

    #[test]
    fn zoom_steps_clamp_and_do_not_drift() {
        let mut s = defaults();
        for _ in 0..3 {
            s.zoom = validate("zoom", &json!("in"), &s).unwrap().as_f64().unwrap();
        }
        assert_eq!(s.zoom, 1.3);
        for _ in 0..50 {
            s.zoom = validate("zoom", &json!("out"), &s).unwrap().as_f64().unwrap();
        }
        assert_eq!(s.zoom, 0.5);
        assert_eq!(validate("zoom", &json!("reset"), &s), Ok(json!(1.0)));
        assert_eq!(validate("zoom", &json!(7.0), &s), Ok(json!(3.0)));
    }
}
