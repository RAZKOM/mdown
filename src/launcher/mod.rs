// Console front-end behind the `mdown` command. It stays tiny: it parses the
// command line, runs the setup menu, and hands files to the GUI binary (`mdown-app`),
// which is built without a console so file associations never flash a terminal window.

#[path = "../settings.rs"]
mod settings;

// ---- setup menu -------------------------------------------------------------------------

