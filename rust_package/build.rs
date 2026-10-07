extern crate napi_build;

use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

fn emit_rerun_if_changed_recursive(path: &Path) {
  if path.is_file() {
    println!("cargo:rerun-if-changed={}", path.display());
    return;
  }

  let Ok(entries) = fs::read_dir(path) else {
    return;
  };

  for entry in entries.flatten() {
    let path = entry.path();
    if path.is_dir() {
      emit_rerun_if_changed_recursive(&path);
    } else {
      println!("cargo:rerun-if-changed={}", path.display());
    }
  }
}

fn main() {
  let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
  #[cfg(target_os = "windows")]
  {
    let probe_source = manifest_dir.join("native/windows_device_probe/frkb_windows_device_probe.cpp");
    println!("cargo:rerun-if-changed={}", probe_source.display());
    cc::Build::new().cpp(true).file(probe_source).flag_if_supported("/std:c++17")
      .flag_if_supported("/EHsc").warnings(true).compile("frkb_windows_device_probe");
    println!("cargo:rustc-link-lib=kernel32");
  }
  let qm_root = manifest_dir.join("native/qm");
  println!(
    "cargo:rerun-if-changed={}",
    manifest_dir.join("build.rs").display()
  );
  emit_rerun_if_changed_recursive(&qm_root);

  let mut cpp_build = cc::Build::new();
  cpp_build
    .cpp(true)
    .include(&qm_root)
    .define("_USE_MATH_DEFINES", None)
    .define("kiss_fft_scalar", Some("double"))
    .file(qm_root.join("qm_key_wrapper.cpp"))
    .file(qm_root.join("dsp/keydetection/GetKeyMode.cpp"))
    .file(qm_root.join("dsp/chromagram/Chromagram.cpp"))
    .file(qm_root.join("dsp/chromagram/ConstantQ.cpp"))
    .file(qm_root.join("dsp/rateconversion/Decimator.cpp"))
    .file(qm_root.join("dsp/transforms/FFT.cpp"))
    .file(qm_root.join("maths/MathUtilities.cpp"))
    .file(qm_root.join("base/Pitch.cpp"))
    .flag_if_supported("-std=c++14")
    .flag_if_supported("/std:c++14")
    .flag_if_supported("/EHsc")
    .warnings(false)
    .compile("qm_keydetector");

  let mut c_build = cc::Build::new();
  c_build
    .include(&qm_root)
    .define("kiss_fft_scalar", Some("double"))
    .file(qm_root.join("ext/kissfft/kiss_fft.c"))
    .file(qm_root.join("ext/kissfft/tools/kiss_fftr.c"))
    .warnings(false)
    .compile("kissfft");

  let r3_stretch_root = manifest_dir.join("native/r3_stretch");
  emit_rerun_if_changed_recursive(&r3_stretch_root);
  let mut r3_stretch_build = cc::Build::new();
  r3_stretch_build
    .cpp(true)
    .include(&r3_stretch_root)
    .file(r3_stretch_root.join("frkb_r3_stretch_wrapper.cpp"))
    .flag_if_supported("-std=c++17")
    .flag_if_supported("/std:c++17")
    .flag_if_supported("/EHsc")
    .warnings(false)
    .compile("frkb_r3_stretch");

  // ===== Chromaprint =====
  let chromaprint_root = manifest_dir.join("native/chromaprint");
  let kissfft_cp_root = chromaprint_root.join("kissfft");
  emit_rerun_if_changed_recursive(&chromaprint_root);

  // Chromaprint core C++ sources
  let mut cp_build = cc::Build::new();
  cp_build
    .cpp(true)
    .include(&chromaprint_root)
    .include(chromaprint_root.join("include"))
    .include(&kissfft_cp_root)
    .define("CHROMAPRINT_NODLL", None)
    .define("USE_KISSFFT", Some("1"))
    .define("HAVE_ROUND", Some("1"))
    .define("HAVE_LRINTF", Some("1"))
    .define("_USE_MATH_DEFINES", None)
    .file(chromaprint_root.join("audio_processor.cpp"))
    .file(chromaprint_root.join("chroma.cpp"))
    .file(chromaprint_root.join("chroma_filter.cpp"))
    .file(chromaprint_root.join("chroma_resampler.cpp"))
    .file(chromaprint_root.join("chromaprint.cpp"))
    .file(chromaprint_root.join("fft.cpp"))
    .file(chromaprint_root.join("fft_lib_kissfft.cpp"))
    .file(chromaprint_root.join("fingerprint_calculator.cpp"))
    .file(chromaprint_root.join("fingerprint_compressor.cpp"))
    .file(chromaprint_root.join("fingerprint_decompressor.cpp"))
    .file(chromaprint_root.join("fingerprinter.cpp"))
    .file(chromaprint_root.join("fingerprinter_configuration.cpp"))
    .file(chromaprint_root.join("fingerprint_matcher.cpp"))
    .file(chromaprint_root.join("image_builder.cpp"))
    .file(chromaprint_root.join("silence_remover.cpp"))
    .file(chromaprint_root.join("simhash.cpp"))
    .file(chromaprint_root.join("spectrum.cpp"))
    .file(chromaprint_root.join("utils/base64.cpp"))
    .file(chromaprint_root.join("frkb_chromaprint_wrapper.cpp"))
    .flag_if_supported("-std=c++14")
    .flag_if_supported("/std:c++14")
    .flag_if_supported("/EHsc")
    .warnings(false)
    .compile("frkb_chromaprint");

  // Chromaprint's KissFFT (C, symbols renamed via kissfft_symbol_rename.h)
  let mut cp_kissfft_build = cc::Build::new();
  cp_kissfft_build
    .include(&chromaprint_root)
    .include(&kissfft_cp_root)
    .define("_USE_MATH_DEFINES", None)
    .file(kissfft_cp_root.join("kiss_fft.c"))
    .file(kissfft_cp_root.join("tools/kiss_fftr.c"))
    .warnings(false)
    .compile("chromaprint_kissfft");

  // ===== FFmpeg =====
  let ffmpeg_root = manifest_dir.join("native/ffmpeg");
  #[cfg(target_os = "windows")]
  let ffmpeg_platform = ffmpeg_root.join("win32-x64");
  #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
  let ffmpeg_platform = ffmpeg_root.join("darwin-arm64");
  #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
  let ffmpeg_platform = ffmpeg_root.join("darwin-x64");
  println!(
    "cargo:rerun-if-changed={}",
    ffmpeg_root.join("frkb_ffmpeg_decode_wrapper.c").display()
  );
  println!(
    "cargo:rerun-if-changed={}",
    ffmpeg_root.join("frkb_ffmpeg_decode_wrapper.h").display()
  );
  emit_rerun_if_changed_recursive(&ffmpeg_platform);

  let ffmpeg_lib_dir = ffmpeg_platform.join("lib");
  let ffmpeg_include_dir = ffmpeg_platform.join("include");
  println!(
    "cargo:rustc-link-search=native={}",
    ffmpeg_lib_dir.display()
  );

  // macOS: 静态链接 FFmpeg + 系统框架
  // Windows: 动态链接 FFmpeg DLL
  #[cfg(target_os = "macos")]
  {
    println!("cargo:rustc-link-lib=static=avcodec");
    println!("cargo:rustc-link-lib=static=avformat");
    println!("cargo:rustc-link-lib=static=avutil");
    println!("cargo:rustc-link-lib=static=swresample");
    // FFmpeg 依赖的 macOS 系统框架
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=AudioToolbox");
    println!("cargo:rustc-link-lib=framework=VideoToolbox");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=CoreVideo");
    println!("cargo:rustc-link-lib=iconv");

    // Homebrew's FFmpeg archives keep codec backends (x264, x265, vpx, etc.)
    // as separate libraries. Ask pkg-config for those transitive link inputs
    // so a locally built N-API module does not defer them to Electron at load time.
    if let Ok(output) = Command::new("pkg-config")
      .args([
        "--static",
        "--libs",
        "libavcodec",
        "libavformat",
        "libavutil",
        "libswresample",
      ])
      .output()
    {
      if output.status.success() {
        let tokens = String::from_utf8_lossy(&output.stdout);
        let mut parts = tokens.split_whitespace();
        while let Some(part) = parts.next() {
          if let Some(dir) = part.strip_prefix("-L") {
            println!("cargo:rustc-link-search=native={dir}");
          } else if let Some(lib) = part.strip_prefix("-l") {
            println!("cargo:rustc-link-lib={lib}");
          } else if part == "-framework" {
            if let Some(framework) = parts.next() {
              println!("cargo:rustc-link-lib=framework={framework}");
            }
          }
        }
      }
    }
    // Some Homebrew formulae are keg-only, so pkg-config omits their -L path
    // when it considers the path a default search location.
    for package in [
      "lame",
      "opus",
      "dav1d",
      "libvpx",
      "svt-av1",
      "x264",
      "x265",
      "openssl@3",
    ] {
      if let Ok(output) = Command::new("brew").args(["--prefix", package]).output() {
        if output.status.success() {
          let prefix = String::from_utf8_lossy(&output.stdout).trim().to_owned();
          if !prefix.is_empty() {
            println!("cargo:rustc-link-search=native={prefix}/lib");
          }
        }
      }
    }
  }
  #[cfg(target_os = "windows")]
  {
    println!("cargo:rustc-link-lib=avcodec");
    println!("cargo:rustc-link-lib=avformat");
    println!("cargo:rustc-link-lib=avutil");
    println!("cargo:rustc-link-lib=swresample");
  }

  let chromaprint_include = chromaprint_root.join("include");
  let mut ffmpeg_wrapper_build = cc::Build::new();
  ffmpeg_wrapper_build
    .include(&ffmpeg_include_dir)
    .include(&chromaprint_include)
    .file("native/ffmpeg/frkb_ffmpeg_decode_wrapper.c")
    .define("CHROMAPRINT_NODLL", None)
    .define("_USE_MATH_DEFINES", None)
    .warnings(false)
    .compile("frkb_ffmpeg_decode");

  napi_build::setup();

  let dts_dir = manifest_dir.join("types");
  let dts_path = dts_dir.join("index.d.ts");
  let dts_template_path = manifest_dir.join("index.d.ts.template");
  println!("cargo:rerun-if-changed={}", dts_template_path.display());

  if let Ok(template) = fs::read(&dts_template_path) {
    let _ = fs::create_dir_all(&dts_dir);
    let _ = fs::write(&dts_path, template);
  }
}
