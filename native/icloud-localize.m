// Public Foundation iCloud APIs only. No file content reads.
// download/probe never evict. evict calls evictUbiquitousItemAtURL only, never unlink.
#import <Foundation/Foundation.h>
#include <sys/stat.h>
#include <unistd.h>
#include <sys/resource.h>
#include <stdlib.h>
#include <math.h>
#include <errno.h>

static void emit(NSString *state, NSString *error, NSNumber *percent) {
  NSMutableDictionary *value = [NSMutableDictionary dictionaryWithObject:state forKey:@"state"];
  if (error) value[@"error"] = error;
  // Only forward Apple's real percent when it is a finite 0-100 value. Never invent progress.
  if ([percent isKindOfClass:[NSNumber class]]) {
    double amount = percent.doubleValue;
    if (isfinite(amount) && amount >= 0 && amount <= 100)
      value[@"percent"] = @((int)llround(amount));
  }
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static BOOL safe(NSString *root, NSString *relative) {
  if (relative.isAbsolutePath || [relative.pathComponents containsObject:@".."] || !relative.length) return NO;
  if (![root.stringByResolvingSymlinksInPath isEqual:root.stringByStandardizingPath]) return NO;
  NSString *current = root;
  for (NSString *part in relative.pathComponents) {
    current = [current stringByAppendingPathComponent:part];
    struct stat info;
    if (lstat(current.fileSystemRepresentation, &info) == 0 && S_ISLNK(info.st_mode)) return NO;
  }
  return YES;
}
static NSString *evictErrorCode(NSError *error) {
  if ([error.domain isEqualToString:@"NSFileProviderErrorDomain"]) {
    if (error.code == -2008 || error.code == -2006) return @"pinned";
    if (error.code == -2007) return @"notUploaded";
  }
  if ([error.domain isEqualToString:NSPOSIXErrorDomain] && error.code == EBUSY) return @"playing";
  if ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorNotConnectedToInternet)
    return @"offline";
  if ([error.domain isEqualToString:NSCocoaErrorDomain] &&
      (error.code == 4353 || error.code == 4354))
    return @"notUploaded";
  if ([error.domain isEqualToString:NSCocoaErrorDomain] && error.code == 4355) return @"offline";
  return @"failed";
}
static int evictItem(NSString *root, NSString *relative) {
  if (!safe(root, relative)) { emit(@"failed", @"boundary", nil); return 1; }
  NSString *name = relative.lastPathComponent;
  // A legacy placeholder is the cloud item's stand-in. Leaving it untouched keeps the cloud file.
  if (name.length > 8 && [name hasPrefix:@"."] && [name hasSuffix:@".icloud"]) {
    emit(@"skipped", nil, nil); return 0;
  }
  NSURL *url = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:relative]];
  [url removeAllCachedResourceValues];
  NSNumber *ubiquitous = nil, *uploading = nil, *uploaded = nil;
  NSString *status = nil;
  [url getResourceValue:&ubiquitous forKey:NSURLIsUbiquitousItemKey error:nil];
  [url getResourceValue:&uploading forKey:NSURLUbiquitousItemIsUploadingKey error:nil];
  [url getResourceValue:&uploaded forKey:NSURLUbiquitousItemIsUploadedKey error:nil];
  [url getResourceValue:&status forKey:NSURLUbiquitousItemDownloadingStatusKey error:nil];
  struct stat info;
  BOOL exists = lstat(url.fileSystemRepresentation, &info) == 0;
  BOOL dataless = exists && (info.st_flags & SF_DATALESS);
  if (!exists || dataless || [status isEqual:NSURLUbiquitousItemDownloadingStatusNotDownloaded]) {
    emit(@"skipped", nil, nil); return 0;
  }
  if (!ubiquitous.boolValue) { emit(@"failed", @"notCloud", nil); return 1; }
  if (uploading.boolValue) { emit(@"failed", @"uploading", nil); return 1; }
  if (uploaded && !uploaded.boolValue) { emit(@"failed", @"notUploaded", nil); return 1; }
  NSError *error = nil;
  if (![NSFileManager.defaultManager evictUbiquitousItemAtURL:url error:&error]) {
    emit(@"failed", evictErrorCode(error), nil); return 1;
  }
  emit(@"ready", nil, nil);
  return 0;
}
int main(int argc, const char *argv[]) {
 @autoreleasepool {
  // Apple TN3150: child Node metadata reads must fail rather than materialize
  // a file if macOS evicts it after the residency check. This policy is inherited
  // by child processes and preserved through exec; never change the UI process.
  if (argc == 2 && strcmp(argv[1], "materialization-policy") == 0) {
    printf("%d\n", getiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS));
    return 0;
  }
  if ((argc == 6 || argc == 7) && strcmp(argv[1], "metadata") == 0) {
    if (setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS, IOPOL_MATERIALIZE_DATALESS_FILES_OFF) != 0) return 3;
    setenv("ELECTRON_RUN_AS_NODE", "1", 1);
    execv(argv[2], (char *const *)&argv[2]);
    return 3;
  }
  if (argc != 4) { emit(@"failed", @"invalid", nil); return 2; }
  NSString *mode = @(argv[1]), *root = [@(argv[2]) stringByStandardizingPath], *relative = @(argv[3]);
  if (!safe(root, relative)) { emit(@"failed", @"boundary", nil); return 2; }
  if ([mode isEqual:@"evict"]) return evictItem(root, relative);
  NSString *logical = relative;
  NSString *name = relative.lastPathComponent;
  if (name.length > 8 && [name hasPrefix:@"."] && [name hasSuffix:@".icloud"]) {
    logical = [relative.stringByDeletingLastPathComponent stringByAppendingPathComponent:[name substringWithRange:NSMakeRange(1, name.length - 8)]];
  }
  NSURL *url = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:logical]];
  NSFileManager *fm = NSFileManager.defaultManager;
  BOOL requested = NO;
  for (NSInteger attempt = 0; attempt < 720; attempt++) {
   if (!safe(root, logical)) { emit(@"failed", @"boundary", nil); return 2; }
   [url removeAllCachedResourceValues];
   NSNumber *ubiquitous = nil, *downloading = nil, *percent = nil;
   NSString *status = nil; NSError *downloadError = nil;
   [url getResourceValue:&ubiquitous forKey:NSURLIsUbiquitousItemKey error:nil];
   [url getResourceValue:&status forKey:NSURLUbiquitousItemDownloadingStatusKey error:nil];
   [url getResourceValue:&downloading forKey:NSURLUbiquitousItemIsDownloadingKey error:nil];
   [url getResourceValue:&downloadError forKey:NSURLUbiquitousItemDownloadingErrorKey error:nil];
   // NSURLUbiquitousItemPercentDownloadedKey was deprecated in 10.8; use the public metadata item key.
   NSMetadataItem *item = [[NSMetadataItem alloc] initWithURL:url];
   percent = item ? [item valueForAttribute:NSMetadataUbiquitousItemPercentDownloadedKey] : nil;
   struct stat info;
   BOOL exists = lstat(url.fileSystemRepresentation, &info) == 0;
   BOOL resident = exists && S_ISREG(info.st_mode) && !(info.st_flags & SF_DATALESS);
   if (resident && (!ubiquitous.boolValue || [status isEqual:NSURLUbiquitousItemDownloadingStatusCurrent] || [status isEqual:NSURLUbiquitousItemDownloadingStatusDownloaded])) {
    emit(@"ready", nil, nil); return 0;
   }
   if (downloadError) {
    NSString *code = [downloadError.domain isEqual:NSURLErrorDomain] && downloadError.code == NSURLErrorNotConnectedToInternet ? @"offline" : @"downloadFailed";
    emit(@"failed", code, nil); return 1;
   }
   if ([mode isEqual:@"probe"]) { emit(@"waiting", nil, nil); return 0; }
   if (![mode isEqual:@"download"]) { emit(@"failed", @"invalid", nil); return 2; }
   if (!requested) {
    NSError *error = nil;
    if (![fm startDownloadingUbiquitousItemAtURL:url error:&error]) {
      emit(@"failed", [error.domain isEqual:NSURLErrorDomain] && error.code == NSURLErrorNotConnectedToInternet ? @"offline" : @"downloadFailed", nil); return 1;
    }
    requested = YES;
   }
   emit(downloading.boolValue ? @"downloading" : @"waiting", nil, percent);
   [NSThread sleepForTimeInterval:0.25];
  }
  emit(@"failed", @"timeout", nil); return 1;
 }
}
