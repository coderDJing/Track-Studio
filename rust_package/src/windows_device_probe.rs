#[napi(object)]
pub struct WindowsUsbWriteDevice {
  pub eligible: bool,
  pub identity: String,
}

#[cfg(any(target_os = "windows", test))]
fn valid_root(root: &str) -> bool {
  let bytes = root.as_bytes();
  bytes.len() == 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

#[cfg(target_os = "windows")]
extern "C" {
  fn frkb_windows_probe_usb_volume(
    root: *const u16,
    volume_name: *mut u16,
    name_capacity: u32,
    serial: *mut u32,
    error: *mut u32,
  ) -> i32;
  fn frkb_windows_process_running(name: *const u16, error: *mut u32) -> i32;
}

#[cfg(target_os = "windows")]
fn probe(root: String) -> napi::Result<WindowsUsbWriteDevice> {
  if !valid_root(&root) {
    return Err(napi::Error::from_reason(
      "USB write probe requires a drive root",
    ));
  }
  let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
  let mut volume = [0u16; 64];
  let mut serial = 0u32;
  let mut error = 0u32;
  // Every pointer refers to a live, correctly sized buffer; the wrapper only reads the volume.
  let status = unsafe {
    frkb_windows_probe_usb_volume(
      wide.as_ptr(),
      volume.as_mut_ptr(),
      volume.len() as u32,
      &mut serial,
      &mut error,
    )
  };
  if status < 0 {
    return Err(napi::Error::from_reason(format!(
      "USB volume query failed: Windows error {error}"
    )));
  }
  let end = volume
    .iter()
    .position(|value| *value == 0)
    .unwrap_or(volume.len());
  Ok(WindowsUsbWriteDevice {
    eligible: status == 1,
    identity: if status == 1 {
      format!(
        "{}:{serial:08x}",
        String::from_utf16_lossy(&volume[..end]).to_lowercase()
      )
    } else {
      String::new()
    },
  })
}

/// Fresh Win32 drive/bus and volume identity query; no subprocess and no cached device state.
#[napi]
pub async fn probe_windows_usb_write_root(root: String) -> napi::Result<WindowsUsbWriteDevice> {
  #[cfg(target_os = "windows")]
  {
    napi::tokio::task::spawn_blocking(move || probe(root))
      .await
      .map_err(|error| napi::Error::from_reason(format!("USB probe task failed: {error}")))?
  }
  #[cfg(not(target_os = "windows"))]
  {
    let _ = root;
    Err(napi::Error::from_reason(
      "Windows USB probe is unavailable on this platform",
    ))
  }
}

#[napi]
pub async fn is_windows_process_running(name: String) -> napi::Result<bool> {
  if name.is_empty() || name.contains(['\0', '/', '\\']) {
    return Err(napi::Error::from_reason(
      "Process query requires an executable name",
    ));
  }
  #[cfg(target_os = "windows")]
  {
    napi::tokio::task::spawn_blocking(move || {
      let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
      let mut error = 0u32;
      // UTF-16 input is NUL terminated and remains live for the complete snapshot iteration.
      let status = unsafe { frkb_windows_process_running(wide.as_ptr(), &mut error) };
      if status < 0 {
        Err(napi::Error::from_reason(format!(
          "Process query failed: Windows error {error}"
        )))
      } else {
        Ok(status == 1)
      }
    })
    .await
    .map_err(|error| napi::Error::from_reason(format!("Process probe task failed: {error}")))?
  }
  #[cfg(not(target_os = "windows"))]
  {
    Err(napi::Error::from_reason(
      "Windows process probe is unavailable on this platform",
    ))
  }
}

#[cfg(test)]
mod tests {
  use super::valid_root;

  #[test]
  fn requires_a_complete_local_drive_root() {
    for root in ["D:\\", "z:\\"] {
      assert!(valid_root(root));
    }
    for root in [
      "D:",
      "D:/",
      "D:\\Contents",
      "\\\\server\\share\\",
      "D:\\\0",
      "1:\\",
    ] {
      assert!(!valid_root(root));
    }
  }
}
