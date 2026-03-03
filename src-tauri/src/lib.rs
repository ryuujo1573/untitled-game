/// Combined cursor grab + visibility command.
/// A single IPC call sets both cursor confinement and visibility atomically,
/// avoiding the two-round-trip pattern in @tauri-apps/api/window.
///
/// On macOS: set_cursor_grab(true) → CGAssociateMouseAndMouseCursorPosition(false)
///           which disassociates cursor position from physical mouse movement while
///           still delivering raw delta motion events through the webview.
/// On Windows: confines cursor to window rect via ClipCursor.
/// On Linux:   confines via XGrabPointer / Wayland pointer constraints.
#[tauri::command]
fn set_cursor_grab(window: tauri::Window, grab: bool) -> Result<(), String> {
    window.set_cursor_grab(grab).map_err(|e| e.to_string())?;
    window.set_cursor_visible(!grab).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![set_cursor_grab])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
