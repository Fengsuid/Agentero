//! Streamable HTTP MCP listener (loopback only).

use super::tools::AgenteroMcp;
use super::McpController;
use agentero_core::error::AppError;
use axum::Router;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Parse `127.0.0.1:8765` or `[::1]:8765`. Non-loopback addresses are rejected:
/// the server has no authentication.
pub fn parse_loopback_listen(raw: &str) -> Result<SocketAddr, AppError> {
    let addr: SocketAddr = raw.parse().map_err(|_| {
        AppError::message("listen must be a loopback socket such as 127.0.0.1:8765 or [::1]:8765")
    })?;
    if !addr.ip().is_loopback() || addr.port() == 0 {
        return Err(AppError::message(
            "MCP listens on loopback only (127.0.0.1 or ::1) and the port must be 1–65535",
        ));
    }
    Ok(addr)
}

/// Serve `listener` until Ctrl-C, or SIGTERM on Unix. The caller binds the
/// socket so it can print the actual address before this future resolves.
pub async fn serve_until_signal(
    ctrl: Arc<McpController>,
    listener: TcpListener,
) -> Result<(), AppError> {
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_tx.send(());
    });
    serve(listener, shutdown_rx, ctrl).await
}

fn allowed_hosts(bound: SocketAddr) -> Vec<String> {
    let port = bound.port();
    let mut hosts = vec![
        "127.0.0.1".to_string(),
        "localhost".to_string(),
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
    ];
    if bound.ip().is_ipv6() {
        let ip = bound.ip();
        hosts.push(ip.to_string());
        hosts.push(format!("[{ip}]"));
        hosts.push(format!("[{ip}]:{port}"));
    }
    hosts
}

async fn shutdown_signal() {
    #[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(term) => term,
            Err(err) => {
                log::warn!(target: "agentero::mcp", "SIGTERM handler unavailable: {err}");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(any(not(unix), target_os = "ios", target_os = "android"))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

pub async fn serve(
    listener: TcpListener,
    shutdown_rx: oneshot::Receiver<()>,
    ctrl: Arc<McpController>,
) -> Result<(), AppError> {
    let bound = listener
        .local_addr()
        .unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], ctrl.status().port)));
    let mut config = StreamableHttpServerConfig::default();
    config.allowed_hosts = allowed_hosts(bound);
    let mcp_service = StreamableHttpService::new(
        {
            let ctrl = Arc::clone(&ctrl);
            move || Ok(AgenteroMcp::new(Arc::clone(&ctrl)))
        },
        LocalSessionManager::default().into(),
        config,
    );
    let app = Router::new().nest_service("/mcp", mcp_service);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .map_err(|e| AppError::message(format!("mcp server: {e}")))
}
