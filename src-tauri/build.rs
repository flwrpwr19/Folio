fn main() {
    tauri_build::build();

    #[cfg(target_os = "macos")]
    compile_macos_helper();
}

#[cfg(target_os = "macos")]
fn compile_macos_helper() {
    use std::path::PathBuf;
    use std::process::Command;

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let helper_src = PathBuf::from("helpers/folio_macos_helper.swift");
    let helper_bin = out_dir.join("folio_macos_helper");

    if !helper_src.exists() {
        return;
    }

    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "aarch64".into());
    let target = format!("{arch}-apple-macosx14.0");

    let sdk = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });

    let mut cmd = Command::new("xcrun");
    cmd.arg("swiftc").arg("-O");
    if let Some(sdk) = &sdk {
        cmd.arg("-sdk").arg(sdk);
    }
    cmd.arg("-target").arg(&target);
    cmd.args([
        "-framework",
        "AppKit",
        "-framework",
        "AVKit",
        "-framework",
        "Vision",
        "-framework",
        "CoreHaptics",
    ]);
    cmd.arg(&helper_src).arg("-o").arg(&helper_bin);

    let status = cmd.status();
    if status.map(|s| s.success()).unwrap_or(false) {
        println!("cargo:rustc-env=FOLIO_MACOS_HELPER={}", helper_bin.display());
        println!("cargo:rerun-if-changed=helpers/folio_macos_helper.swift");
    }
}
