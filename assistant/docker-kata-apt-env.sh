#!/usr/bin/env sh

. /app/assistant/docker-kata-runtime-family.sh

if ! cadet_is_kata_family_runtime; then
  return 0 2>/dev/null || exit 0
fi

export CADET_APT_DATA_ROOT="${CADET_APT_DATA_ROOT:-/data/system}"

_cadet_kata_append_path() {
  case ":${PATH:-}:" in
    *":$1:"*) ;;
    *) PATH="${PATH:+${PATH}:}$1" ;;
  esac
}

_cadet_kata_prepend_path() {
  case ":${PATH:-}:" in
    *":$1:"*) ;;
    *) PATH="$1${PATH:+:${PATH}}" ;;
  esac
}

_cadet_kata_append_pythonpath() {
  case ":${PYTHONPATH:-}:" in
    *":$1:"*) ;;
    *) PYTHONPATH="${PYTHONPATH:+${PYTHONPATH}:}$1" ;;
  esac
}

_cadet_kata_prepend_library_path() {
  case ":${LD_LIBRARY_PATH:-}:" in
    *":$1:"*) ;;
    *) LD_LIBRARY_PATH="$1${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}" ;;
  esac
}

# Shims for chroot wrapper scripts with hardcoded absolute paths must shadow
# the broken originals in the chroot bin dirs below (docker-kata-apt-shims.sh).
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/.host-shims"
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/bin"
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/usr/local/sbin"
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/usr/local/bin"
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/usr/sbin"
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/usr/bin"
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/sbin"
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/usr/games"
_cadet_kata_append_path "${CADET_APT_DATA_ROOT}/games"
export PATH

_cadet_kata_prepend_library_path "${CADET_APT_DATA_ROOT}/usr/lib/aarch64-linux-gnu"
_cadet_kata_prepend_library_path "${CADET_APT_DATA_ROOT}/usr/lib/x86_64-linux-gnu"
_cadet_kata_prepend_library_path "${CADET_APT_DATA_ROOT}/usr/lib"
_cadet_kata_prepend_library_path "${CADET_APT_DATA_ROOT}/usr/local/lib"
export LD_LIBRARY_PATH

# Make python packages installed into the chroot importable by the image
# python: apt packages land in the unversioned dist-packages dir, chroot pip
# installs in the versioned /usr/local one. The chroot suite matches the image
# suite, so the image python's version selects the right pip dir. The pip dir
# must precede the apt dir, mirroring Debian's sys.path order, so a
# pip-upgraded package wins over an older apt one.
_cadet_kata_python_version="$(/usr/bin/python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
if [ -n "${_cadet_kata_python_version}" ]; then
  _cadet_kata_append_pythonpath "${CADET_APT_DATA_ROOT}/usr/local/lib/python${_cadet_kata_python_version}/dist-packages"
fi
_cadet_kata_append_pythonpath "${CADET_APT_DATA_ROOT}/usr/lib/python3/dist-packages"
unset _cadet_kata_python_version
export PYTHONPATH

# The image bakes these under /home/assistant, which is ephemeral rootfs; on
# kata pods $HOME is the persistent data volume, so user-level installs there
# survive machine saves.
if [ -n "${HOME:-}" ]; then
  export PYTHONUSERBASE="${HOME}/.python"
  export BUN_INSTALL="${HOME}/.bun"
  _cadet_kata_prepend_path "${BUN_INSTALL}/bin"
  _cadet_kata_prepend_path "${PYTHONUSERBASE}/bin"
fi
export PATH

unset -f _cadet_kata_append_path _cadet_kata_prepend_path _cadet_kata_append_pythonpath _cadet_kata_prepend_library_path
