use std::{
    io::{Read, Write},
    net::SocketAddr,
    path::PathBuf,
};
use zeroize::Zeroizing;

use clap::Parser;
use flower::{consensus::Consensus, service};

mod server;

// Evaluations, HTTP handling and commits allocate many small, short-lived
// values across worker threads; mimalloc serves them from per-thread pages.
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(
    version,
    about = "A Raft-backed database of reactive TypeScript values",
    after_help = "Offline provisioning: flower key seal --wrapping-key-file PATH [--format raw|pem|der] < private-key"
)]
struct Args {
    /// Unique positive ID of this Raft node.
    #[arg(long)]
    id: u64,
    /// HTTP/1.1 and HTTP/2 listen address; optional TLS through FLOWER_TLS_* files.
    #[arg(long, default_value = "127.0.0.1:7101")]
    listen: SocketAddr,
    /// Address reachable by other nodes, without an http:// prefix.
    #[arg(long)]
    advertise: Option<String>,
    /// Exclusive data directory for this node.
    #[arg(long)]
    data: PathBuf,
    /// Operator secret; use FLOWER_PEER_TOKEN for a separate peer credential.
    #[arg(long, env = "FLOWER_ADMIN_TOKEN", hide_env_values = true)]
    admin_token: String,
}

#[derive(Parser)]
#[command(about = "Seal a private-key import before it reaches Flower HTTP")]
struct SealArgs {
    /// Mounted wrapping key, supplied separately to authorized database nodes.
    #[arg(long)]
    wrapping_key_file: PathBuf,
    /// Encoding of bytes read from stdin.
    #[arg(long, default_value = "raw", value_parser = ["raw", "pem", "der"])]
    format: String,
}

fn main() -> anyhow::Result<()> {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments.get(1).is_some_and(|value| value == "key") {
        anyhow::ensure!(
            arguments.get(2).is_some_and(|value| value == "seal"),
            "native key command is: flower key seal --wrapping-key-file PATH [--format raw|pem|der] < private-key"
        );
        let arguments = SealArgs::parse_from(
            std::iter::once(arguments[0].clone()).chain(arguments.into_iter().skip(3)),
        );
        let mut bytes = Zeroizing::new(Vec::new());
        std::io::stdin().read_to_end(&mut bytes)?;
        let sealed =
            service::seal_key_import(&arguments.wrapping_key_file, &bytes, &arguments.format)?;
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(&mut output, &sealed)?;
        writeln!(output)?;
        return Ok(());
    }

    // The evaluator's shared stack allowance reserves headroom within this
    // explicit worker size, including nested isolated QuickJS runtimes.
    tokio::runtime::Builder::new_multi_thread()
        .thread_stack_size(2 * 1024 * 1024)
        // Poll sockets/timers regularly during bursts of ready HTTP and Raft
        // work. Evaluation and durable storage use the blocking worker pool.
        .event_interval(7)
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    let args = Args::parse();
    anyhow::ensure!(args.id > 0, "node ID must be positive");
    let node_id = args.id;
    let listen = args.listen.to_string();
    let telemetry =
        tokio::task::spawn_blocking(move || flower::telemetry::init(node_id, &listen)).await??;
    let result = run_server(args).await;
    let exported = telemetry.shutdown().await;
    result?;
    exported?;
    Ok(())
}

async fn run_server(args: Args) -> anyhow::Result<()> {
    let server_config = server::Config::from_env()?;
    flower::transport::validate_configuration()?;
    flower::evaluator::warmup()?;
    flower::service::validate_configuration()?;
    let address = args.advertise.unwrap_or_else(|| args.listen.to_string());
    let consensus = Consensus::open(args.id, address, args.data, args.admin_token.clone()).await?;
    let app = service::router(consensus.clone(), args.admin_token);
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    tracing::info!(id = args.id, listen = %args.listen,
        http2_max_streams = server_config.http2_max_streams, "Flower is listening");
    let result = server::serve(listener, app, server_config, shutdown_signal()).await;
    consensus.shutdown().await?;
    result?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = terminate.recv() => {},
                }
                return;
            }
            Err(error) => {
                tracing::error!(%error, "failed to register SIGTERM handler; Ctrl+C remains available")
            }
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
