//! Let Windows precision-touchpad pinches reach the PDF's wheel handler.
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
use windows::core::Interface;

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("pdf-pinch-zoom")
        // Install before page scripts, including in new/pop-out windows. Native
        // page-scale zoom must stay blocked even outside a PDF or mid-scroll.
        .js_init_script_on_all_frames(include_str!("pinch-zoom.js"))
        .on_webview_ready(|webview| {
            if let Err(error) = webview.with_webview(|native| {
                // SAFETY: with_webview runs this on the WebView2 UI thread.
                let result = unsafe {
                    native.controller().CoreWebView2().and_then(|view| {
                        view.Settings()?
                            .cast::<ICoreWebView2Settings5>()?
                            .SetIsPinchZoomEnabled(true)
                    })
                };
                if let Err(error) = result {
                    log::warn!("Cannot enable PDF touchpad gestures: {error}");
                }
            }) {
                log::warn!("Cannot configure PDF touchpad gestures: {error}");
            }
        })
        .build()
}
