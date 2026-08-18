//! Throwaway feasibility spike for the "operate Windows" pillar.
//!
//! Attempts to inspect and control File Explorer, Windows Settings, Notepad,
//! VS Code and Edge/Chrome through UI Automation, with a GDI screenshot as the
//! coordinate fallback. Writes `REPORT.md` plus a JSON dump of raw measurements.
//!
//! Deliberately standalone: nothing here is imported by Jarvis Core.

mod findings;
mod report;
mod targets;
#[cfg(windows)]
mod win;

use std::path::PathBuf;
use std::time::Duration;

use findings::Finding;
use targets::{Target, TARGETS};

struct Options {
    allow_input: bool,
    timeout: Duration,
    only: Vec<String>,
    out_dir: PathBuf,
}

fn parse_options() -> Options {
    let mut options = Options {
        allow_input: false,
        timeout: Duration::from_secs(15),
        only: Vec::new(),
        out_dir: PathBuf::from("out"),
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--allow-input" => options.allow_input = true,
            "--app" => {
                if let Some(value) = args.next() {
                    options.only.push(value);
                }
            }
            "--timeout" => {
                if let Some(value) = args.next() {
                    if let Ok(seconds) = value.parse::<u64>() {
                        options.timeout = Duration::from_secs(seconds);
                    }
                }
            }
            "--out" => {
                if let Some(value) = args.next() {
                    options.out_dir = PathBuf::from(value);
                }
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => eprintln!("Ignoring unknown argument: {other}"),
        }
    }
    options
}

fn print_usage() {
    println!(
        "spike-computeruse [--app explorer|settings|notepad|vscode|browser] [--allow-input] \
[--timeout SECONDS] [--out DIR]"
    );
}

fn selected(options: &Options) -> Vec<&'static Target> {
    if options.only.is_empty() {
        return TARGETS.iter().collect();
    }
    options
        .only
        .iter()
        .filter_map(|key| match targets::find(key) {
            Some(target) => Some(target),
            None => {
                eprintln!("Unknown app key: {key}");
                None
            }
        })
        .collect()
}

#[cfg(windows)]
fn probe(target: &Target, options: &Options) -> Finding {
    let mut finding = Finding::new(target.label);
    match win::launch(target.launch) {
        Ok(()) => finding.launched = true,
        Err(error) => finding.errors.push(format!("Launch failed: {error}")),
    }

    match win::wait_for_window(target, options.timeout) {
        None => finding
            .errors
            .push("No matching top-level window appeared before the timeout.".into()),
        Some((hwnd, class, title, waited)) => {
            finding.window_found = true;
            finding.window_class = class;
            finding.window_title = title;
            finding.window_wait_ms = waited;
            win::probe_uia(hwnd, &mut finding, options.allow_input, target.input_probe);
            win::capture_window(hwnd, &options.out_dir, target.key, &mut finding);
        }
    }
    finding
}

#[cfg(not(windows))]
fn probe(target: &Target, _options: &Options) -> Finding {
    let mut finding = Finding::new(target.label);
    finding
        .errors
        .push("This spike only runs on Windows; UI Automation is unavailable on this platform.".into());
    finding
}

fn main() {
    let options = parse_options();

    #[cfg(windows)]
    if let Err(error) = win::init_com() {
        eprintln!("{error}");
        std::process::exit(1);
    }

    let mut findings = Vec::new();
    for target in selected(&options) {
        eprintln!("Probing {}…", target.label);
        findings.push(probe(target, &options));
    }

    let markdown = report::render(&findings, options.allow_input);
    if let Err(error) = std::fs::create_dir_all(&options.out_dir) {
        eprintln!("Could not create {}: {error}", options.out_dir.display());
    }
    let report_path = options.out_dir.join("REPORT.md");
    if let Err(error) = std::fs::write(&report_path, &markdown) {
        eprintln!("Could not write {}: {error}", report_path.display());
    }
    let json_path = options.out_dir.join("findings.json");
    if let Ok(json) = serde_json::to_string_pretty(&findings) {
        let _ = std::fs::write(&json_path, json);
    }

    println!("{markdown}");
    eprintln!("Wrote {} and {}", report_path.display(), json_path.display());
}
