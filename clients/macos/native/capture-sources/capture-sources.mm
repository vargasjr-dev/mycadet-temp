// Objective-C++ Node addon that lists the window server's capturable windows
// in-process — the port of the mac helper's `CaptureSources.list` into the
// Electron main process.
//
// The companion's Teach picker needs, for every window: its bounds (to draw
// a frame that follows it), its owner process and bundle (to raise it and
// read its icon), and its title. `desktopCapturer` names windows without
// saying where they are, and the helper answered the gap from outside the
// app — which is also why the permission dialog used to name "Cadet Helper".
// The same `CGWindowListCopyWindowInfo` call the helper made runs here
// instead, so the data, its ordering, and the TCC posture are unchanged
// while the helper process and its JsonRpc hop drop out of the list path.
//
// Ordering is load-bearing and preserved: `CGWindowListCopyWindowInfo`
// returns windows front to back, so the first window of an app is its
// frontmost one — the picker and the tab-activation step both lean on that.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <os/log.h>

#include <unordered_map>

#include <napi.h>

namespace {

// The list reports an entry's owning app by name; `NSRunningApplication` is
// the fallback source and the only source of the bundle id and path. One
// instance per process, reused across a single list call's rows.
std::unordered_map<pid_t, NSRunningApplication *> g_appsByPid;

os_log_t logHandle() {
  static os_log_t log = os_log_create("dev.vargasjr.cadet", "capture-sources");
  return log;
}

// The display the window's bounds mostly sit on: the best-overlap display by
// intersection area, or the main display when the window server names none
// (a window parked off every display). Ports the helper's
// `ScreenCapture.displayHolding`, which the picker's display rows and the
// frame-follow logic both assume the ids agree with.
uint32_t displayHolding(CGRect frame) {
  CGDirectDisplayID ids[16];
  uint32_t count = 0;
  if (CGGetDisplaysWithRect(frame, 16, ids, &count) != kCGReturnSuccess ||
      count == 0) {
    return static_cast<uint32_t>(CGMainDisplayID());
  }
  CGDirectDisplayID best = ids[0];
  CGFloat bestArea = -1;
  for (uint32_t i = 0; i < count; i++) {
    CGRect intersection = CGRectIntersection(CGDisplayBounds(ids[i]), frame);
    CGFloat covered = intersection.size.width * intersection.size.height;
    if (covered > bestArea) {
      bestArea = covered;
      best = ids[i];
    }
  }
  return static_cast<uint32_t>(best);
}

// The window-info dictionary's keys are CoreGraphics CFString constants;
// bridged once here for the NSDictionary lookups below.
NSString *keyLayer = (__bridge NSString *)kCGWindowLayer;
NSString *keyOwnerPid = (__bridge NSString *)kCGWindowOwnerPID;
NSString *keyWindowNumber = (__bridge NSString *)kCGWindowNumber;
NSString *keyAlpha = (__bridge NSString *)kCGWindowAlpha;
NSString *keyBounds = (__bridge NSString *)kCGWindowBounds;
NSString *keyOwnerName = (__bridge NSString *)kCGWindowOwnerName;
NSString *keyTitle = (__bridge NSString *)kCGWindowName;
NSString *keyIsOnscreen = (__bridge NSString *)kCGWindowIsOnscreen;

Napi::Object boundsToObject(Napi::Env env, CGRect bounds) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("x", Napi::Number::New(env, bounds.origin.x));
  out.Set("y", Napi::Number::New(env, bounds.origin.y));
  out.Set("width", Napi::Number::New(env, bounds.size.width));
  out.Set("height", Napi::Number::New(env, bounds.size.height));
  return out;
}

// `list(includeOffscreen?: boolean)` → `{ windows: [...] }`, the helper's
// `captureSources.list` envelope verbatim. Synchronous by nature: the
// window server answers in one call, so there is no thread hop to manage.
Napi::Value List(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  Napi::Array windows = Napi::Array::New(env);

  @try {
    const bool includeOffscreen =
        info.Length() > 0 && info[0].IsBoolean() &&
        info[0].As<Napi::Boolean>().Value();
    const CGWindowListOption options = static_cast<CGWindowListOption>(
        includeOffscreen ? kCGWindowListExcludeDesktopElements
                         : (kCGWindowListOptionOnScreenOnly |
                            kCGWindowListExcludeDesktopElements));
    CFArrayRef entries =
        CGWindowListCopyWindowInfo(options, kCGNullWindowID);
    if (entries == nullptr) {
      result.Set("windows", windows);
      return result;
    }

    const pid_t myPid = getpid();
    g_appsByPid.clear();
    size_t index = 0;

    for (NSDictionary *entry in (NSArray *)entries) {
      // Layer 0 is the ordinary application-window layer; the menu bar, the
      // Dock and overlays sit above it and are nothing to teach from.
      NSNumber *layer = entry[keyLayer];
      NSNumber *ownerPid = entry[keyOwnerPid];
      NSNumber *windowNumber = entry[keyWindowNumber];
      if (layer == nil || ownerPid == nil || windowNumber == nil ||
          layer.intValue != 0) {
        continue;
      }
      const pid_t pid = ownerPid.intValue;
      // Never this process: a session cannot teach the assistant about its
      // own window, and the companion's surfaces would otherwise list
      // themselves. (The helper excluded itself and its parent, the app;
      // here the app is where the list runs, so its own pid is both.)
      if (pid == myPid) {
        continue;
      }
      // A fully transparent window is a shadow artifact of some other
      // window's effect, not something a session could read.
      NSNumber *alpha = entry[keyAlpha];
      if (alpha != nil && alpha.doubleValue <= 0) {
        continue;
      }

      CGRect bounds = CGRectZero;
      NSDictionary *boundsDict = entry[keyBounds];
      if (boundsDict != nil &&
          !CGRectMakeWithDictionaryRepresentation(
              (__bridge CFDictionaryRef)boundsDict, &bounds)) {
        bounds = CGRectZero;
      }
      // Below this it is a tooltip, a popover shadow or a status item's
      // menu remnant rather than something a session could read.
      if (bounds.size.width < 50 || bounds.size.height < 50) {
        continue;
      }

      NSRunningApplication *app = g_appsByPid[pid];
      if (app == nil) {
        app = [NSRunningApplication
            runningApplicationWithProcessIdentifier:pid];
        g_appsByPid[pid] = app;
      }

      NSString *ownerName = entry[keyOwnerName];
      NSString *title = entry[keyTitle];
      NSNumber *onScreen = entry[keyIsOnscreen];

      Napi::Object window = Napi::Object::New(env);
      window.Set("windowId",
                 Napi::Number::New(env, windowNumber.unsignedIntValue));
      window.Set("pid", Napi::Number::New(env, pid));
      window.Set("app", Napi::String::New(
                            env, ownerName != nullptr
                                     ? ownerName
                                     : (app != nullptr &&
                                                app.localizedName != nullptr
                                            ? app.localizedName
                                            : @"")));
      window.Set("title", Napi::String::New(
                              env, title != nullptr ? title : @""));
      window.Set("bounds", boundsToObject(env, bounds));
      window.Set("onScreen",
                 Napi::Boolean::New(env, onScreen != nullptr
                                             ? onScreen.boolValue
                                             : !includeOffscreen));
      window.Set("displayId",
                 Napi::Number::New(env, displayHolding(bounds)));
      if (app != nullptr && app.bundleIdentifier != nullptr) {
        window.Set("bundleId",
                   Napi::String::New(env, app.bundleIdentifier));
      }
      if (app != nullptr && app.bundleURL != nullptr &&
          app.bundleURL.path != nullptr) {
        window.Set("appPath", Napi::String::New(env, app.bundleURL.path));
      }
      windows.Set(index++, window);
    }
    CFRelease(entries);
  } @catch (NSException *exception) {
    // The list is best-effort: an exception degrades to an unavailable
    // answer (undefined), which the shell reads as "fall back to the
    // helper", not as an empty world.
    os_log_error(logHandle(), "list failed: %{public}@",
                 exception.reason ?: exception.name);
    return Napi::Value();
  }

  result.Set("windows", windows);
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("list", Napi::Function::New(env, List));
  return exports;
}

} // namespace

NODE_API_MODULE(cadet_capture_sources, Init)
