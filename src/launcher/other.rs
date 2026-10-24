use super::Setup;

pub fn is_installed() -> bool {
    false
}

pub fn install(_: Setup, _: bool) -> Result<String, String> {
    Err("file association setup is only implemented for Windows and macOS".into())
}

pub fn uninstall() -> Result<String, String> {
    Err("file association setup is only implemented for Windows and macOS".into())
}
