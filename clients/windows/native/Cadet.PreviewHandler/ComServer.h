#pragma once
#include <ocidl.h>
#include <shobjidl.h>
#include <windows.h>
#include <atomic>
#include <string>
#include <string_view>
#include "BundleReader.h"
extern std::atomic<long> gModuleRefs;
extern const CLSID CLSID_CadetPreview;
extern const CLSID CLSID_CadetThumbnail;
HRESULT LoadBundle(IStream* stream, cadet::BundleResult& bundle);
std::wstring Wide(std::string_view value);
IUnknown* CreateThumbnailProvider();
class RefCounted {
 public:
  RefCounted() { ++gModuleRefs; }
  virtual ~RefCounted() { --gModuleRefs; }
  ULONG AddRefImpl() { return ++refs_; }
  ULONG ReleaseImpl() {
    const ULONG refs = --refs_;
    if (refs == 0) {
      delete this;
    }
    return refs;
  }
 private:
  std::atomic<ULONG> refs_{1};
};
