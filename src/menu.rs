// macOS only. A webview app with no menu bar has no Cmd+C / Cmd+V / Cmd+A / Cmd+Q, because
// those are menu key equivalents, not keystrokes the page sees. Close and Quit are custom
// items so they run through the unsaved-changes prompt instead of killing the process.

use muda::accelerator::{Accelerator, Code, Modifiers};
use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tao::event_loop::EventLoopProxy;

use crate::Ev;

pub enum Action {
    CloseWindow,
    QuitAll,
}

/// The returned menu must stay alive for as long as the app runs.
pub fn install(proxy: EventLoopProxy<Ev>) -> Menu {
    let cmd = |code| Some(Accelerator::new(Modifiers::META, code));
    let close = MenuItem::with_id("close", "Close Window", true, cmd(Code::KeyW));
    let quit = MenuItem::with_id("quit", "Quit mdown", true, cmd(Code::KeyQ));

    let app = Submenu::with_items(
        "mdown",
        true,
        &[
            &PredefinedMenuItem::hide(None),
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::show_all(None),
            &PredefinedMenuItem::separator(),
            &quit,
        ],
    )
    .expect("app menu");
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    )
    .expect("edit menu");
    let window = Submenu::with_items(
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(None), &PredefinedMenuItem::maximize(None), &PredefinedMenuItem::separator(), &close],
    )
    .expect("window menu");

    let menu = Menu::with_items(&[&app, &edit, &window]).expect("menu");
    menu.init_for_nsapp();
    window.set_as_windows_menu_for_nsapp();

    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        let action = match e.id.0.as_str() {
            "close" => Action::CloseWindow,
            "quit" => Action::QuitAll,
            _ => return,
        };
        let _ = proxy.send_event(Ev::Menu(action));
    }));
    menu
}
