#include "BundleReader.h"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
namespace {
std::vector<std::uint8_t> Read(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
bool Expect(const std::string& name, bool condition) {
  if (!condition) {
    std::cerr << "FAILED: " << name << '\n';
  }
  return condition;
}
cadet::BundleResult Parse(const std::filesystem::path& root,
                           const char* filename) {
  const auto bytes = Read(root / filename);
  return cadet::ReadBundle(bytes.data(), bytes.size());
}
}  // namespace
int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: BundleReaderTests <fixture-directory>\n";
    return 2;
  }
  const std::filesystem::path root(argv[1]);
  bool passed = true;
  const auto valid = Parse(root, "valid.cadet");
  passed &= Expect("valid bundle", static_cast<bool>(valid));
  passed &= Expect("golden name", valid.metadata.name == "Golden App");
  passed &= Expect("golden entry", valid.metadata.entry == "index.html");
  passed &= Expect("golden icon", !valid.iconPng.empty());
  passed &= Expect("oversized icon ignored", static_cast<bool>(Parse(root, "oversized-image.cadet")));
  const std::pair<const char*, cadet::BundleError> failures[] = {
      {"malformed.cadet", cadet::BundleError::InvalidArchive},
      {"traversal.cadet", cadet::BundleError::Traversal},
      {"missing-manifest.cadet", cadet::BundleError::MissingManifest},
      {"malformed-manifest.cadet", cadet::BundleError::MalformedManifest},
  };
  for (const auto& [fixture, error] : failures) {
    passed &= Expect(fixture, Parse(root, fixture).error == error);
  }
  const auto bytes = Read(root / "valid.cadet");
  for (std::size_t size = 0; size < bytes.size(); ++size) {
    const auto truncated = cadet::ReadBundle(bytes.data(), size);
    passed &= Expect("truncated archive rejected", !truncated);
  }
  if (!passed) {
    return 1;
  }
  std::cout << "BundleReader native tests passed\n";
  return 0;
}
