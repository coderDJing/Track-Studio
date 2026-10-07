#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>
#include <tlhelp32.h>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace {
struct ScopedHandle {
  HANDLE value;
  explicit ScopedHandle(HANDLE handle) : value(handle) {}
  ~ScopedHandle() {
    if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value);
  }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
};

int fail(uint32_t* error) {
  *error = GetLastError();
  return -1;
}
}

// Only queries the mounted volume and storage descriptor; never requests write access.
extern "C" int frkb_windows_probe_usb_volume(
    const wchar_t* root, wchar_t* volume_name, uint32_t name_capacity,
    uint32_t* serial, uint32_t* error) {
  const UINT type = GetDriveTypeW(root);
  if (type != DRIVE_REMOVABLE && type != DRIVE_FIXED) return 0;
  if (type == DRIVE_FIXED) {
    wchar_t device[] = L"\\\\.\\X:";
    device[4] = root[0];
    ScopedHandle handle(CreateFileW(device, 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, 0, nullptr));
    if (handle.value == INVALID_HANDLE_VALUE) return fail(error);
    STORAGE_PROPERTY_QUERY query{};
    query.PropertyId = StorageDeviceProperty;
    query.QueryType = PropertyStandardQuery;
    STORAGE_DESCRIPTOR_HEADER header{};
    DWORD returned = 0;
    if (!DeviceIoControl(handle.value, IOCTL_STORAGE_QUERY_PROPERTY,
        &query, sizeof(query), &header, sizeof(header), &returned, nullptr))
      return fail(error);
    if (returned < sizeof(header) || header.Size < sizeof(STORAGE_DEVICE_DESCRIPTOR)
        || header.Size > 1024 * 1024) {
      *error = ERROR_INVALID_DATA;
      return -1;
    }
    std::vector<unsigned char> bytes(header.Size);
    if (!DeviceIoControl(handle.value, IOCTL_STORAGE_QUERY_PROPERTY,
        &query, sizeof(query), bytes.data(), header.Size, &returned, nullptr))
      return fail(error);
    if (returned < offsetof(STORAGE_DEVICE_DESCRIPTOR, BusType) + sizeof(STORAGE_BUS_TYPE)) {
      *error = ERROR_INVALID_DATA;
      return -1;
    }
    const auto* descriptor = reinterpret_cast<const STORAGE_DEVICE_DESCRIPTOR*>(bytes.data());
    if (descriptor->BusType != BusTypeUsb) return 0;
  }
  if (!GetVolumeNameForVolumeMountPointW(root, volume_name, name_capacity)) return fail(error);
  DWORD volume_serial = 0;
  if (!GetVolumeInformationW(root, nullptr, 0, &volume_serial, nullptr, nullptr, nullptr, 0))
    return fail(error);
  *serial = volume_serial;
  return 1;
}

extern "C" int frkb_windows_process_running(const wchar_t* name, uint32_t* error) {
  ScopedHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE) return fail(error);
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) {
    if (GetLastError() == ERROR_NO_MORE_FILES) return 0;
    return fail(error);
  }
  do {
    if (_wcsicmp(entry.szExeFile, name) == 0) return 1;
  } while (Process32NextW(snapshot.value, &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES) return fail(error);
  return 0;
}
